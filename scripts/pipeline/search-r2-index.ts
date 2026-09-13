import fsp from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildStreetIndexFiles } from "../../src/shared/street-index-build.js";
import type { StreetEntry } from "../../src/shared/types.js";
import { SEARCH_R2_INDEX_DIR, SHARDS_DIR } from "./config.js";

/** Format bytes as KB/MB */
function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Write the static R2 street search index to outDir (replacing any previous build).
 * Index paths are "search/..."; files land at outDir/... without that prefix.
 */
export async function writeR2SearchIndex(streets: StreetEntry[], outDir: string): Promise<void> {
  const t0 = Date.now();
  console.log(`Building R2 search index for ${streets.length} streets...`);
  const files = buildStreetIndexFiles(streets);

  await fsp.rm(outDir, { recursive: true, force: true });
  const createdDirs = new Set<string>();
  let rawBytes = 0;
  let storedBytes = 0;
  const sizes: { file: string; bytes: number }[] = [];

  for (const [indexPath, content] of files) {
    const relative = indexPath.replace(/^search\//, "");
    const target = path.join(outDir, relative);
    const dir = path.dirname(target);
    if (!createdDirs.has(dir)) {
      await fsp.mkdir(dir, { recursive: true });
      createdDirs.add(dir);
    }
    const json = Buffer.from(JSON.stringify(content));
    const body = target.endsWith(".gz") ? gzipSync(json) : json;
    await fsp.writeFile(target, body);
    rawBytes += json.length;
    storedBytes += body.length;
    sizes.push({ file: relative, bytes: body.length });
  }

  sizes.sort((a, b) => b.bytes - a.bytes);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `  ${files.size} files, ${formatBytes(rawBytes)} raw, ${formatBytes(storedBytes)} stored (${seconds}s)`
  );
  console.log(
    `  Largest: ${sizes.slice(0, 5).map((s) => `${s.file} ${formatBytes(s.bytes)}`).join(", ")}`
  );
}

// Allow running directly: rebuild from the streets.json written by search-index
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const streets: StreetEntry[] = JSON.parse(
      await fsp.readFile(path.join(SHARDS_DIR, "streets.json"), "utf-8")
    );
    await writeR2SearchIndex(streets, SEARCH_R2_INDEX_DIR);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
