import type { SearchBackend, StreetFinder } from "../shared/street-finder.js";
import { createSqlStreetFinder } from "../shared/street-finder-d1.js";
import { createR2StreetFinder } from "./street-finder-r2.js";

/** A valid `?backend=` override wins; otherwise SEARCH_BACKEND, defaulting to d1 */
export function resolveSearchBackend(
  configured: string | undefined,
  override?: string
): SearchBackend {
  const value = override === "d1" || override === "r2" ? override : configured;
  return value === "r2" ? "r2" : "d1";
}

export function createStreetFinder(
  env: { SEARCH_DB: D1Database; GNAF_BUCKET: R2Bucket },
  backend: SearchBackend,
  version: string,
  ctx: ExecutionContext
): StreetFinder {
  return backend === "r2"
    ? createR2StreetFinder(env.GNAF_BUCKET, version, ctx)
    : createSqlStreetFinder(env.SEARCH_DB.withSession());
}
