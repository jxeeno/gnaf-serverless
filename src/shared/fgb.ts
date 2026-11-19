import * as flatbuffers from "flatbuffers";
import { magicbytes, SIZE_PREFIX_LEN } from "flatgeobuf/lib/mjs/constants.js";
import { fromByteBuffer, type HeaderMeta } from "flatgeobuf/lib/mjs/header-meta.js";
import { calcTreeSize } from "flatgeobuf/lib/mjs/packedrtree.js";

/**
 * Where each part of a FlatGeobuf file sits, so it can be read with range
 * requests: the pipeline validates the file it writes this way, and the Worker
 * reads the reverse-geocode index from R2 the same way.
 *
 * Layout: 8 magic bytes, a 4-byte header length, the header, the packed
 * R-tree (root level first), then the features.
 */

/** Reads `length` bytes starting at `offset`. */
export type ReadRange = (offset: number, length: number) => Promise<ArrayBuffer>;

export interface FgbLayout {
  header: HeaderMeta;
  /** Byte offset of the packed R-tree, or of the features when there is no index */
  treeOffset: number;
  /** Byte length of the packed R-tree (0 when the file has no index) */
  treeLength: number;
  /** Byte offset of the first feature */
  featuresOffset: number;
}

// Same ceiling the library's own reader applies.
const MAX_HEADER_BYTES = 10 * 1024 * 1024;

export async function readFgbLayout(read: ReadRange): Promise<FgbLayout> {
  const magicLength = magicbytes.length;
  const start = new Uint8Array(await read(0, magicLength + SIZE_PREFIX_LEN));

  // The first three bytes spell "fgb"; the fourth is the major version.
  if (!magicbytes.subarray(0, 4).every((b, i) => start[i] === b)) {
    throw new Error("Not a FlatGeobuf v3 file");
  }

  const headerLength = new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(
    magicLength,
    true
  );
  if (headerLength < 8 || headerLength > MAX_HEADER_BYTES) {
    throw new Error(`Invalid FlatGeobuf header length: ${headerLength}`);
  }

  // The header parser reads the 4-byte length prefix itself. Hand it the header
  // alone and every field decodes as garbage — a nonsense feature count that
  // then stalls building the tree's level table.
  const headerBytes = new Uint8Array(await read(magicLength, SIZE_PREFIX_LEN + headerLength));
  const header = fromByteBuffer(new flatbuffers.ByteBuffer(headerBytes));

  const treeOffset = magicLength + SIZE_PREFIX_LEN + headerLength;
  const treeLength =
    header.indexNodeSize > 0 ? calcTreeSize(header.featuresCount, header.indexNodeSize) : 0;

  return { header, treeOffset, treeLength, featuresOffset: treeOffset + treeLength };
}
