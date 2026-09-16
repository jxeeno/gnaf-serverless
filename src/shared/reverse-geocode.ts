import * as flatbuffers from "flatbuffers";
import { Feature } from "flatgeobuf/lib/mjs/flat-geobuf/feature.js";
import { GeometryType } from "flatgeobuf/lib/mjs/flat-geobuf/geometry-type.js";
import { generateLevelBounds, NODE_ITEM_BYTE_LEN } from "flatgeobuf/lib/mjs/packedrtree.js";
import { readFgbLayout, type FgbLayout, type ReadRange } from "./fgb.js";

/**
 * Nearest-address search over the reverse-geocode FlatGeobuf, read through
 * range requests.
 *
 * It is a best-first search of the packed R-tree. It always expands whichever
 * node could hold the closest point, and stops once nothing left could beat the
 * answers already found. Every node carries the box of what sits under it, and
 * a leaf's box is its point, so distances come from the tree alone. Features are
 * read, for their PIDs, only for the addresses returned.
 */

export interface NearestAddress {
  pid: string;
  lat: number;
  lng: number;
  /** Great-circle distance from the query point, in metres */
  distance: number;
}

export interface NearestOptions {
  /** How many addresses to return */
  limit: number;
  /** Ignore anything further away than this, in metres */
  maxRadius: number;
}

/** Range requests made while answering one query. */
export interface ReadCounter {
  reads: number;
  bytes: number;
}

export interface GeoIndexOptions {
  /** Hold the top of the tree in memory: whole levels, up to this many bytes */
  prefixBudgetBytes?: number;
  /** Keep recently read tree pages in memory, up to this many bytes */
  pageCacheBytes?: number;
}

/** Thrown when a query would read more of the index than a request should. */
export class SearchAreaTooLargeError extends Error {}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * For the ~10.7M-point index this holds the top five of seven levels (~1.8 MiB),
 * so a search reads at most two levels from storage.
 */
const DEFAULT_PREFIX_BUDGET_BYTES = 4 * 1024 * 1024;

/** Tree pages never change, so recently read ones are worth keeping. */
const DEFAULT_PAGE_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * Pages or feature runs fetched at once. A Worker invocation can hold six
 * connections open, so this leaves room for the rest of the request.
 */
const CONCURRENT_READS = 4;

/** A safety net: an ordinary query reads a handful of pages, not thousands. */
const MAX_STORED_PAGES_PER_QUERY = 2_000;

/** Features this close together (in bytes) are read in one request. */
const FEATURE_MERGE_GAP_BYTES = 8 * 1024;

/** A tree node whose children haven't been read yet. */
interface NodeEntry {
  kind: "node";
  /** How close anything under this node could be, in metres */
  bound: number;
  /** Level of this node; 0 is the leaves */
  level: number;
  /** Index of its first child, one level down */
  firstChild: number;
}

/** An address point, found in a leaf. */
interface PointEntry {
  kind: "point";
  /** Its exact distance, in metres */
  bound: number;
  x: number;
  y: number;
  /** Offset of its feature within the features section */
  offset: number;
  /** Byte length of its feature, including the 4-byte length prefix */
  length: number;
}

type Entry = NodeEntry | PointEntry;

/** Great-circle (haversine) distance in metres. */
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A lower bound on the distance from a point to anywhere in a lat/lng box.
 *
 * It takes the gap to the box in each direction, measuring longitude with the
 * cosine of the most poleward latitude involved (where degrees of longitude are
 * shortest), then takes off 1%. That keeps it at or under the true great-circle
 * distance, so the search never passes over a node that holds a closer point.
 * It never shrinks for a box inside another, which keeps results in order.
 */
function boxLowerBound(
  lat: number,
  lng: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number {
  const gapLat = lat < minY ? minY - lat : lat > maxY ? lat - maxY : 0;
  const gapLng = lng < minX ? minX - lng : lng > maxX ? lng - maxX : 0;
  if (gapLat === 0 && gapLng === 0) return 0;
  const poleward = Math.min(Math.max(Math.abs(lat), Math.abs(minY), Math.abs(maxY)), 90);
  const eastWest = Math.cos(poleward * DEG) * gapLng;
  return 0.99 * EARTH_RADIUS_M * DEG * Math.hypot(gapLat, eastWest);
}

class MinHeap<T extends { bound: number }> {
  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].bound <= items[i].bound) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].bound < items[smallest].bound) smallest = left;
        if (right < items.length && items[right].bound < items[smallest].bound) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class GeoIndex {
  /** Range requests made since the index was opened, including opening it */
  reads = 0;
  bytesRead = 0;

  /** Tree pages read recently, by first node and count, least recently used first */
  private readonly pages = new Map<string, { bytes: number; view: Promise<DataView> }>();
  private pageBytes = 0;

  private constructor(
    private readonly source: ReadRange,
    private readonly layout: FgbLayout,
    private readonly fileBytes: number,
    /** Node index ranges per level; index 0 is the leaves, the last is the root */
    private readonly levels: Array<[number, number]>,
    /** The first `prefixNodes` nodes of the tree, held in memory */
    private readonly prefix: DataView,
    private readonly prefixNodes: number,
    private readonly pageCacheBytes: number
  ) {}

  /**
   * Open an index. `fileBytes` is the file's total size, which gives the length
   * of the last feature.
   */
  static async open(
    source: ReadRange,
    fileBytes: number,
    {
      prefixBudgetBytes = DEFAULT_PREFIX_BUDGET_BYTES,
      pageCacheBytes = DEFAULT_PAGE_CACHE_BYTES,
    }: GeoIndexOptions = {}
  ): Promise<GeoIndex> {
    let reads = 0;
    let bytesRead = 0;
    const counted: ReadRange = async (offset, length) => {
      reads++;
      bytesRead += length;
      return source(offset, length);
    };

    const layout = await readFgbLayout(counted);
    const { header } = layout;
    if (header.indexNodeSize === 0) {
      throw new Error("The geo index has no spatial index");
    }
    if (header.geometryType !== GeometryType.Point) {
      throw new Error(`The geo index holds geometry type ${header.geometryType}, not points`);
    }
    if (header.featuresCount === 0) {
      throw new Error("The geo index is empty");
    }

    const levels = generateLevelBounds(header.featuresCount, header.indexNodeSize);

    // Levels are stored root first, so the top of the tree is one contiguous
    // run of nodes. Take as many whole levels as fit the budget.
    let prefixNodes = 0;
    for (let level = levels.length - 1; level >= 0; level--) {
      const end = levels[level][1];
      if (end * NODE_ITEM_BYTE_LEN > prefixBudgetBytes) break;
      prefixNodes = end;
    }
    const prefix =
      prefixNodes > 0
        ? new DataView(await counted(layout.treeOffset, prefixNodes * NODE_ITEM_BYTE_LEN))
        : new DataView(new ArrayBuffer(0));

    const index = new GeoIndex(
      source,
      layout,
      fileBytes,
      levels,
      prefix,
      prefixNodes,
      pageCacheBytes
    );
    index.reads = reads;
    index.bytesRead = bytesRead;
    return index;
  }

  get featuresCount(): number {
    return this.layout.header.featuresCount;
  }

  /**
   * The nearest addresses to a point, closest first, with ties broken by PID.
   * Pass `counter` to count the range requests this one query makes; the totals
   * on the index are shared by every query it serves.
   */
  async nearest(
    lat: number,
    lng: number,
    { limit, maxRadius }: NearestOptions,
    counter?: ReadCounter
  ): Promise<NearestAddress[]> {
    const queue = new MinHeap<Entry>();
    const found: PointEntry[] = [];
    let storedPages = 0;

    // The root has no parent to carry its box, so start from a stand-in parent
    // one level above it, whose only child is the root.
    queue.push({ kind: "node", bound: 0, level: this.levels.length, firstChild: 0 });

    // Anything further than this can't make the answer. Points leave the queue
    // closest first, so once `limit` are found the last of them sets the bar.
    const bar = () => (found.length >= limit ? found[limit - 1].bound : maxRadius);

    for (;;) {
      const batch: NodeEntry[] = [];
      while (batch.length < CONCURRENT_READS) {
        const top = queue.peek();
        // `<=`, not `<`: an entry level with the bar may hold a tie, which the
        // PID tiebreak below needs to see.
        if (!top || top.bound > bar()) break;
        if (top.kind === "point") {
          // A node already taken this round might hold something closer, so
          // expand it before accepting any point.
          if (batch.length > 0) break;
          found.push(queue.pop() as PointEntry);
        } else {
          batch.push(queue.pop() as NodeEntry);
        }
      }
      if (batch.length === 0) break;

      for (const node of batch) {
        if (this.levels[node.level - 1][1] > this.prefixNodes) storedPages++;
      }
      if (storedPages > MAX_STORED_PAGES_PER_QUERY) {
        throw new SearchAreaTooLargeError(
          "The search had to read too much of the index; use a smaller radius"
        );
      }

      const children = await Promise.all(
        batch.map((node) => this.children(node, lat, lng, counter))
      );
      for (const entries of children) {
        for (const entry of entries) {
          if (entry.bound <= maxRadius) queue.push(entry);
        }
      }
    }

    if (found.length === 0) return [];

    // Every point level with the last place is in `found`, so ties can be broken
    // by PID now the PIDs are about to be known.
    const cutoff = found[Math.min(limit, found.length) - 1].bound;
    const chosen = found.filter((p) => p.bound <= cutoff);
    const pids = await this.readPids(chosen, counter);

    return chosen
      .map((p, i) => ({ pid: pids[i], lat: p.y, lng: p.x, distance: p.bound }))
      .sort((a, b) => a.distance - b.distance || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))
      .slice(0, limit);
  }

  /** The children of a node, each with its distance bound from the query point. */
  private async children(
    node: NodeEntry,
    lat: number,
    lng: number,
    counter?: ReadCounter
  ): Promise<Entry[]> {
    const level = node.level - 1;
    const levelEnd = this.levels[level][1];
    const start = node.firstChild;
    const end = Math.min(start + this.layout.header.indexNodeSize, levelEnd);
    const isLeaf = level === 0;
    // At the leaves, read one node further so the last child's feature length
    // can be worked out from where the next feature starts.
    const readEnd = isLeaf ? Math.min(end + 1, levelEnd) : end;
    const view = await this.readNodes(start, readEnd - start, counter);

    const out: Entry[] = [];
    for (let i = start; i < end; i++) {
      const o = (i - start) * NODE_ITEM_BYTE_LEN;
      const minX = view.getFloat64(o, true);
      const minY = view.getFloat64(o + 8, true);
      const maxX = view.getFloat64(o + 16, true);
      const maxY = view.getFloat64(o + 24, true);
      const offset = Number(view.getBigUint64(o + 32, true));

      if (isLeaf) {
        const nextOffset =
          i + 1 < levelEnd
            ? Number(view.getBigUint64(o + NODE_ITEM_BYTE_LEN + 32, true))
            : this.fileBytes - this.layout.featuresOffset;
        out.push({
          kind: "point",
          bound: haversineMetres(lat, lng, minY, minX),
          x: minX,
          y: minY,
          offset,
          length: nextOffset - offset,
        });
      } else {
        // An inner node's offset is the index of its first child.
        out.push({
          kind: "node",
          bound: boxLowerBound(lat, lng, minX, minY, maxX, maxY),
          level,
          firstChild: offset,
        });
      }
    }
    return out;
  }

  private readNodes(start: number, count: number, counter?: ReadCounter): Promise<DataView> {
    // Pages sit wholly inside or outside the prefix, which ends on a level boundary.
    if (start + count <= this.prefixNodes) {
      return Promise.resolve(
        new DataView(
          this.prefix.buffer,
          this.prefix.byteOffset + start * NODE_ITEM_BYTE_LEN,
          count * NODE_ITEM_BYTE_LEN
        )
      );
    }

    const key = `${start}:${count}`;
    const cached = this.pages.get(key);
    if (cached) {
      // Move it to the most recently used end.
      this.pages.delete(key);
      this.pages.set(key, cached);
      return cached.view;
    }

    const bytes = count * NODE_ITEM_BYTE_LEN;
    const view = this.read(this.layout.treeOffset + start * NODE_ITEM_BYTE_LEN, bytes, counter).then(
      (buf) => new DataView(buf)
    );
    const entry = { bytes, view };
    // Stored as a promise, so queries that want the same page share one read.
    this.pages.set(key, entry);
    this.pageBytes += bytes;
    view.catch(() => this.forgetPage(key, entry));

    for (const [oldKey, old] of this.pages) {
      if (this.pageBytes <= this.pageCacheBytes || old === entry) break;
      this.forgetPage(oldKey, old);
    }
    return view;
  }

  private forgetPage(key: string, entry: { bytes: number }): void {
    if (this.pages.get(key) !== entry) return;
    this.pages.delete(key);
    this.pageBytes -= entry.bytes;
  }

  private async read(offset: number, length: number, counter?: ReadCounter): Promise<ArrayBuffer> {
    this.reads++;
    this.bytesRead += length;
    if (counter) {
      counter.reads++;
      counter.bytes += length;
    }
    return this.source(offset, length);
  }

  /** Read the PID of each point, fetching features that sit close together in one request. */
  private async readPids(points: PointEntry[], counter?: ReadCounter): Promise<string[]> {
    const order = points
      .map((point, i) => ({ point, i }))
      .sort((a, b) => a.point.offset - b.point.offset);

    const runs: Array<typeof order> = [];
    for (const entry of order) {
      const run = runs[runs.length - 1];
      const last = run?.[run.length - 1];
      if (last && entry.point.offset - (last.point.offset + last.point.length) <= FEATURE_MERGE_GAP_BYTES) {
        run.push(entry);
      } else {
        runs.push([entry]);
      }
    }

    const pids = new Array<string>(points.length);
    await mapLimit(runs, CONCURRENT_READS, async (run) => {
      const from = run[0].point.offset;
      const to = Math.max(...run.map(({ point }) => point.offset + point.length));
      const bytes = new Uint8Array(
        await this.read(this.layout.featuresOffset + from, to - from, counter)
      );
      for (const { point, i } of run) {
        pids[i] = decodePid(bytes.subarray(point.offset - from, point.offset - from + point.length));
      }
    });
    return pids;
  }
}

const textDecoder = new TextDecoder();

/**
 * The GNAF PID from one feature, including its 4-byte length prefix.
 *
 * FlatGeobuf packs properties as a column index (uint16) followed by the value;
 * a string value is a uint32 byte length and then UTF-8. The index has exactly
 * one column, gnaf_pid, which the pipeline checks when it builds the file.
 */
export function decodePid(featureBytes: Uint8Array): string {
  // flatbuffers reads from a ByteBuffer's start, so give it its own copy.
  const feature = Feature.getSizePrefixedRootAsFeature(
    new flatbuffers.ByteBuffer(featureBytes.slice())
  );
  const props = feature.propertiesArray();
  if (!props || props.byteLength < 6) {
    throw new Error("Geo index feature has no properties");
  }
  const view = new DataView(props.buffer, props.byteOffset, props.byteLength);
  if (view.getUint16(0, true) !== 0) {
    throw new Error("Geo index feature's first property isn't gnaf_pid");
  }
  const length = view.getUint32(2, true);
  return textDecoder.decode(props.subarray(6, 6 + length));
}
