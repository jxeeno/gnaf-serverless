import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import {
  CKAN_BASE,
  GNAF_PACKAGE_ID,
  DATUM,
  DATA_DIR,
  GNAF_ZIP_PATH,
  GNAF_EXTRACT_DIR,
} from "./config.js";

interface CKANResource {
  id: string;
  name: string;
  url: string;
  format: string;
  size: number | null;
  last_modified: string | null;
  created: string;
  state: string;
}

interface CKANResponse {
  success: boolean;
  result: {
    resources: CKANResource[];
  };
}

async function getLatestGnafUrl(): Promise<{ url: string; name: string }> {
  console.log(`Fetching GNAF package metadata from data.gov.au...`);
  const res = await fetch(
    `${CKAN_BASE}/package_show?id=${GNAF_PACKAGE_ID}`
  );
  if (!res.ok) {
    throw new Error(`CKAN API returned ${res.status}: ${res.statusText}`);
  }
  const data: CKANResponse = await res.json();
  if (!data.success) {
    throw new Error("CKAN API returned success: false");
  }

  const zips = data.result.resources
    .filter((r) => r.format === "ZIP" && r.state === "active")
    .sort(
      (a, b) =>
        new Date(b.last_modified ?? b.created).getTime() -
        new Date(a.last_modified ?? a.created).getTime()
    );

  const match = zips.find((r) => r.name.toUpperCase().includes(DATUM));
  if (!match) {
    throw new Error(`No active ZIP resource found for datum ${DATUM}`);
  }

  console.log(`Found: ${match.name}`);
  console.log(`Size: ${match.size ? (match.size / 1e9).toFixed(2) + " GB" : "unknown"}`);
  return { url: match.url, name: match.name };
}

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`Downloading to ${dest}...`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const fileStream = createWriteStream(dest);
  await pipeline(res.body, fileStream);
  const stat = await fsp.stat(dest);
  console.log(`Downloaded ${(stat.size / 1e9).toFixed(2)} GB`);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  console.log(`Extracting ${zipPath} to ${destDir}...`);
  const { default: unzipper } = await import("unzipper");
  await fsp.mkdir(destDir, { recursive: true });

  const directory = await unzipper.Open.file(zipPath);
  let extracted = 0;
  const total = directory.files.length;

  for (const file of directory.files) {
    const fullPath = path.join(destDir, file.path);
    if (file.type === "Directory") {
      await fsp.mkdir(fullPath, { recursive: true });
    } else {
      await fsp.mkdir(path.dirname(fullPath), { recursive: true });
      const writeStream = createWriteStream(fullPath);
      await pipeline(file.stream(), writeStream);
      extracted++;
      if (extracted % 100 === 0) {
        console.log(`  Extracted ${extracted}/${total} files...`);
      }
    }
  }
  console.log(`Extracted ${extracted} files`);
}

export async function download(): Promise<void> {
  // Check if already extracted
  if (fs.existsSync(GNAF_EXTRACT_DIR)) {
    const entries = await fsp.readdir(GNAF_EXTRACT_DIR);
    if (entries.length > 0) {
      console.log(
        `GNAF data already extracted at ${GNAF_EXTRACT_DIR}, skipping download.`
      );
      return;
    }
  }

  const { url } = await getLatestGnafUrl();

  // Download if ZIP doesn't exist
  if (!fs.existsSync(GNAF_ZIP_PATH)) {
    await downloadFile(url, GNAF_ZIP_PATH);
  } else {
    console.log(`ZIP already exists at ${GNAF_ZIP_PATH}, skipping download.`);
  }

  await extractZip(GNAF_ZIP_PATH, GNAF_EXTRACT_DIR);
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  download().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
