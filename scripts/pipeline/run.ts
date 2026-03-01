import { download } from "./download.js";
import { importGnaf } from "./import.js";
import { shard } from "./shard.js";
import { upload } from "./upload.js";

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("=== GNAF Pipeline ===\n");

  console.log("Step 1/4: Download GNAF data");
  await download();
  console.log();

  console.log("Step 2/4: Import into DuckDB");
  const instance = await importGnaf();
  instance.closeSync();
  console.log();

  console.log("Step 3/4: Shard data");
  await shard();
  console.log();

  console.log("Step 4/4: Upload to S3");
  await upload();
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Pipeline complete in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
