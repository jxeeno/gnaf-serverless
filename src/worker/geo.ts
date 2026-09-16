import type { GeoIndexMetadata } from "../shared/types.js";
import { GeoIndex } from "../shared/reverse-geocode.js";

/**
 * The reverse-geocode index, opened once per isolate.
 *
 * Opening reads the header and the top of the tree (about 1.8 MiB for the full
 * index), so later requests on the same isolate go straight to searching. Only
 * the current data version is kept.
 */
let open: { key: string; index: Promise<GeoIndex> } | null = null;

export function openGeoIndex(
  bucket: R2Bucket,
  version: string,
  geo: GeoIndexMetadata
): Promise<GeoIndex> {
  const key = `gnaf/${version}/${geo.file}`;
  if (open?.key === key) return open.index;

  const index = GeoIndex.open(async (offset, length) => {
    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) throw new Error(`Geo index not found: ${key}`);
    return obj.arrayBuffer();
  }, geo.bytes);

  const entry = { key, index };
  open = entry;
  // Don't keep a failed open around for the life of the isolate.
  index.catch(() => {
    if (open === entry) open = null;
  });
  return index;
}
