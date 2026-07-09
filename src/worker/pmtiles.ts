import {
  PMTiles,
  ResolvedValueCache,
  Compression,
  type Source,
  type RangeResponse,
} from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Protobuf from "pbf";

export interface PMTilesLayerConfig {
  name: string;
  label: string;
  file: string;
  layer: string;
  zoom: number;
  properties?: string[];
}

export interface OverlayResult {
  label: string;
  features: Record<string, string | number | boolean>[];
}

/**
 * PMTiles Source backed by Cloudflare R2.
 */
class R2Source implements Source {
  constructor(
    private bucket: R2Bucket,
    private key: string
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    _etag?: string
  ): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, {
      range: { offset, length },
    });
    if (!obj) {
      throw new Error(`PMTiles file not found: ${this.key}`);
    }
    return {
      data: await obj.arrayBuffer(),
      etag: obj.etag,
      cacheControl: obj.httpMetadata?.cacheControl,
    };
  }
}

/**
 * Decompress function for PMTiles internal directory compression.
 */
async function decompress(
  buf: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return buf;
  }
  if (compression === Compression.Gzip) {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }
  throw new Error(`Unsupported compression: ${compression}`);
}

/**
 * Convert lat/lng to tile coordinates at a given zoom level.
 */
function latLngToTile(
  lat: number,
  lng: number,
  zoom: number
): { x: number; y: number; z: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n
  );
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)), z: zoom };
}

/**
 * Convert lat/lng to pixel coordinates within a specific tile.
 * Returns coordinates in the tile's extent (typically 4096).
 */
function latLngToTilePixel(
  lat: number,
  lng: number,
  z: number,
  tileX: number,
  tileY: number,
  extent: number
): { px: number; py: number } {
  const n = 2 ** z;
  const worldX = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const worldY =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n;
  return {
    px: (worldX - tileX) * extent,
    py: (worldY - tileY) * extent,
  };
}

/**
 * Ray-casting point-in-ring test.
 */
function pointInRing(
  px: number,
  py: number,
  ring: { x: number; y: number }[]
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x,
      yi = ring[i].y;
    const xj = ring[j].x,
      yj = ring[j].y;
    if (
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if a point is inside a polygon/multi-polygon using the even-odd rule.
 * Works for both simple polygons with holes and multi-polygons.
 */
function pointInPolygon(
  px: number,
  py: number,
  rings: { x: number; y: number }[][]
): boolean {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(px, py, ring)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Decompress tile data based on the tile compression from the PMTiles header.
 */
async function decompressTile(
  data: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return data;
  }
  if (compression === Compression.Gzip) {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }
  throw new Error(`Unsupported tile compression: ${compression}`);
}

/**
 * Query a single PMTiles layer for features containing the given point.
 */
async function querySingleLayer(
  bucket: R2Bucket,
  config: PMTilesLayerConfig,
  lat: number,
  lng: number
): Promise<OverlayResult | null> {
  const source = new R2Source(bucket, config.file);
  const cache = new ResolvedValueCache(64, false, decompress);
  const pmtiles = new PMTiles(source, cache, decompress);

  const header = await pmtiles.getHeader();
  const { x, y, z } = latLngToTile(lat, lng, config.zoom);

  const tileResponse = await pmtiles.getZxy(z, x, y);
  if (!tileResponse) return null;

  const tileData = await decompressTile(tileResponse.data, header.tileCompression);
  const tile = new VectorTile(new Protobuf(tileData));

  const layer = tile.layers[config.layer];
  if (!layer) return null;

  const { px, py } = latLngToTilePixel(lat, lng, z, x, y, layer.extent);

  const features: Record<string, string | number | boolean>[] = [];

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);

    // Only check polygon features (type 3)
    if (feature.type !== 3) continue;

    const geometry = feature.loadGeometry();
    if (pointInPolygon(px, py, geometry)) {
      // Filter properties if configured
      let props: Record<string, string | number | boolean>;
      if (config.properties) {
        props = {};
        for (const key of config.properties) {
          if (key in feature.properties) {
            props[key] = feature.properties[key];
          }
        }
      } else {
        props = { ...feature.properties };
      }

      features.push(props);
    }
  }

  if (features.length === 0) return null;

  return { label: config.label, features };
}

/**
 * Query all configured PMTiles layers for a given lat/lng.
 * Returns overlay results keyed by layer name.
 * Layers that fail or have no match are silently skipped.
 */
export async function queryOverlays(
  bucket: R2Bucket,
  layersJson: string,
  lat: number,
  lng: number
): Promise<Record<string, OverlayResult>> {
  let layers: PMTilesLayerConfig[];
  try {
    layers = JSON.parse(layersJson);
  } catch {
    // .dev.vars / dotenv may pass escaped quotes as literal backslash-quote
    try {
      layers = JSON.parse(layersJson.replace(/\\"/g, '"'));
    } catch (e) {
      console.error("PMTiles: failed to parse PMTILES_LAYERS JSON:", e);
      return {};
    }
  }

  if (!Array.isArray(layers) || layers.length === 0) return {};

  const results = await Promise.allSettled(
    layers.map((layer) => querySingleLayer(bucket, layer, lat, lng))
  );

  const overlays: Record<string, OverlayResult> = {};
  for (let i = 0; i < layers.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      overlays[layers[i].name] = result.value;
    }
  }

  return overlays;
}
