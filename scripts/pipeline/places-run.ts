import { downloadPlaces } from "./places-download.js";
import { importPlaces } from "./places-import.js";
import { shardPlaces } from "./places-shard.js";
import { generatePlacesSearchIndex } from "./places-search-index.js";
import { uploadPlaces } from "./places-upload.js";

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("=== Places Pipeline ===\n");

  console.log("Step 1/5: Download Overture Places data");
  await downloadPlaces();
  console.log();

  console.log("Step 2/5: Import and denormalize");
  await importPlaces();
  console.log();

  console.log("Step 3/5: Shard place records");
  await shardPlaces();
  console.log();

  console.log("Step 4/5: Generate search index");
  await generatePlacesSearchIndex();
  console.log();

  console.log("Step 5/5: Upload to R2");
  await uploadPlaces();
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Places pipeline complete in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("Places pipeline failed:", err);
  process.exit(1);
});
