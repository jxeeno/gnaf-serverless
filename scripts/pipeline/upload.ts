import fsp from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import type { ShardMetadata } from "../../src/shared/types.js";
import {
  S3_ENDPOINT,
  S3_REGION,
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  SHARDS_DIR,
  ADDRESS_SHARDS_DIR,
  LOTDP_SHARDS_DIR,
} from "./config.js";

function createS3Client(): S3Client {
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new Error(
      "Missing S3 configuration. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY env vars."
    );
  }

  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

async function uploadFile(
  client: S3Client,
  localPath: string,
  s3Key: string,
  contentType: string,
  contentEncoding?: string
): Promise<void> {
  const body = await fsp.readFile(localPath);
  const params: PutObjectCommandInput = {
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: body,
    ContentType: contentType,
  };
  if (contentEncoding) {
    params.ContentEncoding = contentEncoding;
  }
  await client.send(new PutObjectCommand(params));
}

async function uploadDirectory(
  client: S3Client,
  localDir: string,
  s3Prefix: string,
  contentType: string,
  contentEncoding?: string
): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(localDir);
  } catch {
    console.warn(`  Directory ${localDir} not found, skipping`);
    return 0;
  }

  let uploaded = 0;
  const concurrency = 10;
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (entry) => {
        const localPath = path.join(localDir, entry);
        const s3Key = `${s3Prefix}/${entry}`;
        await uploadFile(client, localPath, s3Key, contentType, contentEncoding);
      })
    );
    uploaded += batch.length;
    if (uploaded % 100 < concurrency) {
      console.log(`  Uploaded ${uploaded}/${entries.length} files to ${s3Prefix}/`);
    }
  }
  return uploaded;
}

export async function upload(): Promise<void> {
  // Read metadata to get version
  const metadataPath = path.join(SHARDS_DIR, "metadata.json");
  const metadata: ShardMetadata = JSON.parse(
    await fsp.readFile(metadataPath, "utf-8")
  );
  const version = metadata.version;

  console.log(`Uploading GNAF ${version} to S3...`);
  const client = createS3Client();

  // Upload address shards
  console.log("Uploading address shards...");
  const addressCount = await uploadDirectory(
    client,
    ADDRESS_SHARDS_DIR,
    `gnaf/${version}/addresses`,
    "application/json",
    "gzip"
  );
  console.log(`  Uploaded ${addressCount} address shards`);

  // Upload lot/DP shards
  console.log("Uploading lot/DP shards...");
  const lotdpCount = await uploadDirectory(
    client,
    LOTDP_SHARDS_DIR,
    `gnaf/${version}/lotdp`,
    "application/json",
    "gzip"
  );
  console.log(`  Uploaded ${lotdpCount} lot/DP shards`);

  // Upload metadata
  console.log("Uploading metadata...");
  await uploadFile(
    client,
    metadataPath,
    `gnaf/${version}/metadata.json`,
    "application/json"
  );

  // Update latest pointer
  const latestPointer = JSON.stringify({ version, date: metadata.date });
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: "gnaf/latest.json",
      Body: Buffer.from(latestPointer),
      ContentType: "application/json",
    })
  );

  console.log(`Upload complete. Version: ${version}`);
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  upload().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
