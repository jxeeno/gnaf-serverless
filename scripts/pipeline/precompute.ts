import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import {
  parseSearchQuery,
  scoreAddress,
  computeHighlightRanges,
} from "../../src/shared/search-query.js";
import { reconstructSla } from "../../src/shared/address-format.js";
import { generateShortQueries } from "../../src/shared/precomputed-queries.js";
import type { StreetAddressEntry } from "../../src/shared/types.js";
import type { StreetEntry } from "./search-index.js";
import { SHARDS_DIR } from "./config.js";

const STREET_SHARDS_DIR = path.join(SHARDS_DIR, "streets");
const PRECOMPUTED_DIR = path.join(SHARDS_DIR, "precomputed");
const LIMIT = 50;

// ── Street data ─────────────────────────────────────────────────────────

let streets: StreetEntry[] = [];

function loadStreets(): void {
  const streetsPath = path.join(SHARDS_DIR, "streets.json");
  streets = JSON.parse(readFileSync(streetsPath, "utf-8"));
  console.log(`Loaded ${streets.length} streets`);
}

// ── Shard reader (LRU cache) ────────────────────────────────────────────

const shardCache = new Map<string, Record<string, StreetAddressEntry[]>>();
const MAX_CACHE = 256;

function readStreetShard(
  prefix: string
): Record<string, StreetAddressEntry[]> {
  const cached = shardCache.get(prefix);
  if (cached) return cached;

  const filePath = path.join(STREET_SHARDS_DIR, `${prefix}.json.gz`);
  if (!existsSync(filePath)) {
    shardCache.set(prefix, {});
    return {};
  }
  const data = JSON.parse(gunzipSync(readFileSync(filePath)).toString());

  // Evict oldest if cache is full
  if (shardCache.size >= MAX_CACHE) {
    const firstKey = shardCache.keys().next().value!;
    shardCache.delete(firstKey);
  }
  shardCache.set(prefix, data);
  return data;
}

// ── SLA reconstruction ──────────────────────────────────────────────────

function entryToSla(entry: StreetAddressEntry, street: StreetEntry): string {
  return reconstructSla(
    entry.d,
    street.street_name,
    street.street_type,
    street.street_suffix,
    street.locality_name,
    street.state,
    street.postcode
  );
}

// ── Street result / address result types ────────────────────────────────

interface StreetResult {
  streetId: number;
  display: string;
  highlight: [number, number][];
  streetName: string;
  locality: string;
  state: string;
  postcode: string | null;
  addressCount: number;
}

interface AddressResult {
  pid: string;
  sla: string;
  highlight: [number, number][];
  streetId: number;
}

// ── Street matching ─────────────────────────────────────────────────────

/**
 * Find streets matching a text prefix. Checks street_name and locality_name.
 * Sorted by address_count DESC with a bonus for exact name prefix match.
 */
function matchStreetsByText(
  token: string,
  numHint: number | null,
  limit: number
): StreetEntry[] {
  const upper = token.toUpperCase();
  const matches: { street: StreetEntry; score: number }[] = [];

  for (const s of streets) {
    const nameMatch = s.street_name.startsWith(upper);
    const locMatch = s.locality_name.startsWith(upper);
    const stateMatch = s.state.startsWith(upper);
    if (!nameMatch && !locMatch && !stateMatch) continue;

    // Number range filter
    if (
      numHint != null &&
      (s.num_min == null ||
        s.num_max == null ||
        numHint < s.num_min ||
        numHint > s.num_max)
    )
      continue;

    // Ranking: name match > loc match, with address_count tiers
    let score = 0;
    if (nameMatch) {
      score += s.street_name === upper ? 115 : 10;
    }
    if (s.address_count >= 2000) score += 20;
    else if (s.address_count >= 500) score += 15;
    else if (s.address_count >= 100) score += 10;
    else if (s.address_count >= 20) score += 5;
    if (numHint != null) score += 200; // number-in-range bonus

    matches.push({ street: s, score });
  }

  matches.sort((a, b) => b.score - a.score || b.street.address_count - a.street.address_count);
  return matches.slice(0, limit).map((m) => m.street);
}

/**
 * Find streets whose address range includes the given number.
 * Sorted by address_count DESC.
 */
function matchStreetsByNumber(num: number, limit: number): StreetEntry[] {
  const matches: StreetEntry[] = [];
  for (const s of streets) {
    if (
      s.num_min != null &&
      s.num_max != null &&
      num >= s.num_min &&
      num <= s.num_max
    ) {
      matches.push(s);
    }
  }
  matches.sort((a, b) => b.address_count - a.address_count);
  return matches.slice(0, limit);
}

// ── Search execution ────────────────────────────────────────────────────

function executeSearch(
  q: string
): { streets: StreetResult[]; addresses: AddressResult[] } {
  const parsed = parseSearchQuery(q);

  // Number-only queries
  if (!parsed) {
    const numMatch = q.trim().match(/^(\d+)$/);
    if (!numMatch) return { streets: [], addresses: [] };
    return searchByNumber(parseInt(numMatch[1], 10), q);
  }

  const { streetHint, flatHint, levelHint } = parsed;

  // Single short text token: direct prefix match (mirrors useDirectQuery in worker)
  const firstToken = parsed.textTokens[0];
  const streetLimit = parsed.numTokens.length > 0 ? Math.max(30, LIMIT * 3) : LIMIT;

  const matchedStreets = matchStreetsByText(
    firstToken,
    streetHint,
    streetLimit
  );

  if (matchedStreets.length === 0) return { streets: [], addresses: [] };

  // Build street results
  const streetResults: StreetResult[] = matchedStreets
    .slice(0, LIMIT)
    .map((s) => ({
      streetId: s.id,
      display: s.display,
      highlight: computeHighlightRanges(
        s.display,
        {
          streetName: s.street_name,
          streetType: s.street_type || undefined,
          streetSuffix: s.street_suffix || undefined,
          localityName: s.locality_name,
          state: s.state,
          postcode: s.postcode || undefined,
        },
        q
      ),
      streetName: s.street_name,
      locality: s.locality_name,
      state: s.state,
      postcode: s.postcode || null,
      addressCount: s.address_count,
    }));

  // Collect address entries from shards
  const scored: {
    pid: string;
    sla: string;
    displayPrefix: string;
    streetId: number;
    street: StreetEntry;
    score: number;
  }[] = [];

  for (const street of matchedStreets) {
    const shardKeysToFetch: { prefix: string; key: string }[] = [];

    if (street.digit_shards) {
      const digitMap: Record<string, string> = JSON.parse(street.digit_shards);
      if (streetHint != null) {
        const digit = String(streetHint).charAt(0);
        const subPrefix = digitMap[digit];
        if (subPrefix) {
          shardKeysToFetch.push({
            prefix: subPrefix,
            key: `${street.street_key}|${digit}`,
          });
        }
      } else if (flatHint != null) {
        // Need all sub-shards
        shardKeysToFetch.push({
          prefix: street.shard_prefix,
          key: street.street_key,
        });
        for (const [d, prefix] of Object.entries(digitMap)) {
          shardKeysToFetch.push({
            prefix,
            key: `${street.street_key}|${d}`,
          });
        }
      } else {
        // No numbers: base shard + first digit sub-shard
        shardKeysToFetch.push({
          prefix: street.shard_prefix,
          key: street.street_key,
        });
        const firstDigit = Object.keys(digitMap).sort()[0];
        if (firstDigit != null) {
          shardKeysToFetch.push({
            prefix: digitMap[firstDigit],
            key: `${street.street_key}|${firstDigit}`,
          });
        }
      }
    } else {
      shardKeysToFetch.push({
        prefix: street.shard_prefix,
        key: street.street_key,
      });
    }

    for (const { prefix, key } of shardKeysToFetch) {
      const shardData = readStreetShard(prefix);
      const entries = shardData[key];
      if (!entries) continue;

      for (const entry of entries) {
        const score = scoreAddress(entry, parsed);
        if (score === 0) continue;
        scored.push({
          pid: entry.p,
          sla: entryToSla(entry, street),
          displayPrefix: entry.d,
          streetId: street.id,
          street,
          score,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Diversify when no numbers: 1 per street first, then backfill
  let addressSlice: typeof scored;
  if (parsed.numTokens.length === 0) {
    const seen = new Set<number>();
    const first: typeof scored = [];
    const rest: typeof scored = [];
    for (const a of scored) {
      if (!seen.has(a.streetId)) {
        seen.add(a.streetId);
        first.push(a);
      } else {
        rest.push(a);
      }
    }
    addressSlice = first.slice(0, LIMIT);
    if (addressSlice.length < LIMIT) {
      addressSlice.push(...rest.slice(0, LIMIT - addressSlice.length));
    }
  } else {
    addressSlice = scored.slice(0, LIMIT);
  }

  const addressResults: AddressResult[] = addressSlice.map((a) => ({
    pid: a.pid,
    sla: a.sla,
    highlight: computeHighlightRanges(
      a.sla,
      {
        streetName: a.street.street_name,
        streetType: a.street.street_type || undefined,
        streetSuffix: a.street.street_suffix || undefined,
        localityName: a.street.locality_name,
        state: a.street.state,
        postcode: a.street.postcode || undefined,
        displayPrefix: a.displayPrefix,
      },
      q
    ),
    streetId: a.streetId,
  }));

  return { streets: streetResults, addresses: addressResults };
}

function searchByNumber(
  num: number,
  q: string
): { streets: StreetResult[]; addresses: AddressResult[] } {
  const matchedStreets = matchStreetsByNumber(num, Math.max(30, LIMIT * 3));
  if (matchedStreets.length === 0) return { streets: [], addresses: [] };

  const streetResults: StreetResult[] = matchedStreets
    .slice(0, LIMIT)
    .map((s) => ({
      streetId: s.id,
      display: s.display,
      highlight: [],
      streetName: s.street_name,
      locality: s.locality_name,
      state: s.state,
      postcode: s.postcode || null,
      addressCount: s.address_count,
    }));

  const digit = String(num).charAt(0);
  const scored: {
    pid: string;
    sla: string;
    streetId: number;
    score: number;
  }[] = [];

  for (const street of matchedStreets) {
    let shardPrefix: string;
    let shardKey: string;

    if (street.digit_shards) {
      const digitMap: Record<string, string> = JSON.parse(street.digit_shards);
      const subPrefix = digitMap[digit];
      if (subPrefix) {
        shardPrefix = subPrefix;
        shardKey = `${street.street_key}|${digit}`;
      } else {
        continue;
      }
    } else {
      shardPrefix = street.shard_prefix;
      shardKey = street.street_key;
    }

    const shardData = readStreetShard(shardPrefix);
    const entries = shardData[shardKey];
    if (!entries) continue;

    for (const entry of entries) {
      if (entry.n == null) continue;
      const exact = entry.n === num;
      const range =
        entry.n2 != null && num >= entry.n && num <= entry.n2;
      if (!exact && !range) continue;
      const score = exact
        ? entry.f == null && entry.l == null
          ? 100
          : 90
        : 50;
      scored.push({
        pid: entry.p,
        sla: entryToSla(entry, street),
        streetId: street.id,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Diversify: 1 per street first
  const seen = new Set<number>();
  const first: typeof scored = [];
  const rest: typeof scored = [];
  for (const a of scored) {
    if (!seen.has(a.streetId)) {
      seen.add(a.streetId);
      first.push(a);
    } else {
      rest.push(a);
    }
  }
  const results = first.slice(0, LIMIT);
  if (results.length < LIMIT) {
    results.push(...rest.slice(0, LIMIT - results.length));
  }

  const numStr = String(num);
  const addressResults: AddressResult[] = results.map((a) => ({
    pid: a.pid,
    sla: a.sla,
    highlight: computeHighlightRanges(
      a.sla,
      {
        streetName: "",
        localityName: "",
        state: "",
        displayPrefix: a.sla.split(",")[0] ?? "",
      },
      numStr
    ),
    streetId: a.streetId,
  }));

  return { streets: streetResults, addresses: addressResults };
}

// ── Main ────────────────────────────────────────────────────────────────

function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000) | 0;
  return s >= 60 ? `${(s / 60) | 0}m ${s % 60}s` : `${s}s`;
}

export async function precompute(): Promise<void> {
  const t0 = Date.now();

  loadStreets();
  mkdirSync(PRECOMPUTED_DIR, { recursive: true });

  const queries = generateShortQueries();
  console.log(`Pre-computing ${queries.length} short queries...`);

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const result = executeSearch(q);
    writeFileSync(
      path.join(PRECOMPUTED_DIR, `${q}.json`),
      JSON.stringify(result)
    );
    if ((i + 1) % 500 === 0) {
      console.log(`  ${i + 1}/${queries.length} (${elapsed(t0)})...`);
    }
  }

  // Write sentinel
  writeFileSync(path.join(PRECOMPUTED_DIR, ".done"), "");
  console.log(
    `Pre-computed ${queries.length} queries to ${PRECOMPUTED_DIR} (${elapsed(t0)})`
  );
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  precompute().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
