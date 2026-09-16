import { download } from "./download.js";
import { importGnaf } from "./import.js";
import { shard } from "./shard.js";
import { generateSearchIndex } from "./search-index.js";
import { precompute } from "./precompute.js";
import { generateGeoIndex } from "./geo-index.js";
import { upload } from "./upload.js";

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("=== GNAF Pipeline ===\n");

  console.log("Step 1/7: Download GNAF data");
  await download();
  console.log();

  console.log("Step 2/7: Import into DuckDB");
  const instance = await importGnaf();
  instance.closeSync();
  console.log();

  console.log("Step 3/7: Shard data");
  await shard();
  console.log();

  console.log("Step 4/7: Generate search index");
  await generateSearchIndex();
  console.log();

  console.log("Step 5/7: Pre-compute short queries");
  await precompute();
  console.log();

  console.log("Step 6/7: Generate reverse-geocode index");
  await generateGeoIndex();
  console.log();

  console.log("Step 7/7: Upload to S3");
  await upload();
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Pipeline complete in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
