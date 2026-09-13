/**
 * Compare street search between the D1 FTS5 index (run locally in node:sqlite,
 * using the same SQL as the worker) and the static R2 index, over generated and
 * fixed queries.
 *
 * Needs Node 24+ for node:sqlite with FTS5:
 *   nvm use 24
 *   npm run search:compare -- --duckdb data/gnaf.duckdb --work /tmp/search-compare
 *
 * Or from a pipeline build's streets.json:
 *   npm run search:compare -- --streets data/shards/streets.json --work /tmp/search-compare
 *
 * The work directory caches streets.json, the SQLite database and the R2 index
 * between runs; pass --rebuild to regenerate them.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseArgs } from "node:util";
import { DuckDBInstance } from "@duckdb/node-api";
import { parseSearchQuery } from "../../src/shared/search-query.js";
import {
  createSqlStreetFinder,
  type SqlSession,
  type SqlStatement,
} from "../../src/shared/street-finder-d1.js";
import type { StreetFinder, StreetFinderResult } from "../../src/shared/street-finder.js";
import { createIndexStreetFinder, type IndexLoader } from "../../src/shared/street-index.js";
import type { StreetEntry } from "../../src/shared/types.js";
import { buildSearchIndexSql, queryStreetEntries } from "./search-index.js";
import { writeR2SearchIndex } from "./search-r2-index.js";

const { values: args } = parseArgs({
  options: {
    duckdb: { type: "string" },
    streets: { type: "string" },
    work: { type: "string" },
    samples: { type: "string", default: "300" },
    seed: { type: "string", default: "42" },
    limit: { type: "string", default: "10" },
    show: { type: "string", default: "15" },
    report: { type: "string" },
    rebuild: { type: "boolean", default: false },
  },
});

const FIXED_QUERIES = [
  "1 macquarie st sydney",
  "130 elizabeth st sydney",
  "george st",
  "12/45 smith st surry",
  "kent",
  "unit 3 5 murray",
  "level 10 suite 6 95 york st sydney",
  "20 w",
  "302",
  "8012",
  "o'brien street",
  "high st",
  "main road",
  "beach rd",
  "park",
  "north sydney",
  "st kilda rd melbourne",
  "the esplanade",
  "pacific hwy",
  "1 canberra av forrest act 2603",
  "chapel st prahran",
  "bondi rd bondi",
  "macquire st sydney",
  "george st sydny",
  "parramata rd",
  "kent st sydeny",
];

interface TestQuery {
  category: string;
  q: string;
  /** Street the query was generated from (typo queries) */
  target?: number;
}

interface QueryOutcome extends TestQuery {
  d1: number[];
  r2: number[];
  d1Display: string[];
  r2Display: string[];
  d1Ms: number;
  r2Ms: number;
  r2Fetches: number;
  corrections?: string;
}

/** Deterministic PRNG so query sets are repeatable */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random edit (deletion, transposition, substitution or insertion), keeping the first letter */
function makeTypo(word: string, rand: () => number): string | null {
  if (!/^[a-z]{5,}$/.test(word)) return null;
  const i = 1 + Math.floor(rand() * (word.length - 2));
  const letter = "abcdefghijklmnopqrstuvwxyz"[Math.floor(rand() * 26)];
  let typo: string;
  switch (Math.floor(rand() * 4)) {
    case 0:
      typo = word.slice(0, i) + word.slice(i + 1);
      break;
    case 1:
      typo = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
      break;
    case 2:
      typo = word.slice(0, i) + letter + word.slice(i + 1);
      break;
    default:
      typo = word.slice(0, i) + letter + word.slice(i);
  }
  return typo === word ? null : typo;
}

function generateQueries(streets: StreetEntry[], samples: number, rand: () => number): TestQuery[] {
  const queries = new Map<string, TestQuery>();
  const add = (category: string, q: string, target?: number) => {
    const normalized = q.replace(/\s+/g, " ").trim();
    if (normalized && !queries.has(normalized)) queries.set(normalized, { category, q: normalized, target });
  };

  // Half uniform, half weighted by address count (popular streets get searched more)
  const cumulative: number[] = [];
  let total = 0;
  for (const s of streets) {
    total += s.address_count;
    cumulative.push(total);
  }
  const weightedPick = () => {
    const target = rand() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return streets[lo];
  };

  for (let i = 0; i < samples; i++) {
    const s = i % 2 === 0 ? streets[Math.floor(rand() * streets.length)] : weightedPick();
    const name = s.street_name.toLowerCase();
    const type = s.street_type.toLowerCase();
    const loc = s.locality_name.toLowerCase();
    const num =
      s.num_min != null && s.num_max != null
        ? s.num_min + Math.floor(rand() * (s.num_max - s.num_min + 1))
        : null;

    add("name", name);
    add("name type", `${name} ${type}`);
    add("name type locality", `${name} ${type} ${loc}`);
    add("name locality state", `${name} ${loc} ${s.state.toLowerCase()}`);
    add("typing name", name.slice(0, Math.max(3, Math.ceil(name.length * 0.6))));
    add("typing locality", `${name} ${type} ${loc.slice(0, Math.max(1, Math.ceil(loc.length / 2)))}`);
    if (num != null) {
      add("number name type locality", `${num} ${name} ${type} ${loc}`);
      add("number + 1 letter", `${num} ${name.charAt(0)}`);
      if (i % 5 === 0) add("number only", String(num));
      if (s.flat_min != null && s.flat_max != null) {
        add("flat/number name", `${s.flat_min}/${num} ${name} ${type}`);
      }
    }
    const nameTypo = makeTypo(name, rand);
    if (nameTypo) add("typo street name", `${nameTypo} ${type} ${loc}`, s.id);
    const locTypo = makeTypo(loc, rand);
    if (locTypo) add("typo locality", `${name} ${type} ${locTypo}`, s.id);
  }
  for (const q of FIXED_QUERIES) add("fixed", q);
  return [...queries.values()];
}

async function loadStreets(work: string): Promise<StreetEntry[]> {
  if (args.streets) return JSON.parse(await fsp.readFile(args.streets, "utf-8"));

  const cachePath = path.join(work, "streets.json");
  if (!args.rebuild && fs.existsSync(cachePath)) {
    return JSON.parse(await fsp.readFile(cachePath, "utf-8"));
  }
  console.log(`Reading streets from ${args.duckdb} (read-only)...`);
  const instance = await DuckDBInstance.create(args.duckdb!, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  const streets = await queryStreetEntries(conn);
  conn.disconnectSync();
  instance.closeSync();
  await fsp.writeFile(cachePath, JSON.stringify(streets));
  return streets;
}

function openSqlite(work: string, streets: StreetEntry[]): DatabaseSync {
  const dbPath = path.join(work, "streets.sqlite");
  if (args.rebuild) fs.rmSync(dbPath, { force: true });
  const exists = fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  if (!exists) {
    console.log("Building SQLite FTS5 index (same SQL as D1)...");
    db.exec(`BEGIN;\n${buildSearchIndexSql(streets)}\nCOMMIT;`);
  }
  return db;
}

/** node:sqlite adapter for the D1 finder */
function sqliteSession(db: DatabaseSync): SqlSession {
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  return {
    prepare(query) {
      let statement = statements.get(query);
      if (!statement) {
        statement = db.prepare(query);
        statements.set(query, statement);
      }
      const prepared = statement;
      const bound = (values: SQLInputValue[]): SqlStatement => ({
        bind: (...next) => bound(next as SQLInputValue[]),
        async all<T>() {
          const start = performance.now();
          const results = prepared.all(...values) as T[];
          return { results, meta: { rows_read: 0, duration: performance.now() - start } };
        },
        async first<T>() {
          return (prepared.get(...values) as T | undefined) ?? null;
        },
      });
      return bound([]);
    },
  };
}

function fileLoader(root: string): IndexLoader {
  const cache = new Map<string, unknown>();
  return {
    async load<T>(indexPath: string) {
      if (!cache.has(indexPath)) {
        const file = path.join(root, indexPath);
        let value: unknown = null;
        if (fs.existsSync(file)) {
          const bytes = fs.readFileSync(file);
          value = JSON.parse((file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf-8"));
        }
        cache.set(indexPath, value);
      }
      return cache.get(indexPath) as T | null;
    },
  };
}

async function runQuery(finder: StreetFinder, q: string, limit: number): Promise<{ result: StreetFinderResult; ms: number }> {
  const start = performance.now();
  const parsed = parseSearchQuery(q);
  let result: StreetFinderResult;
  if (parsed) {
    const streetLimit = parsed.numTokens.length > 0 ? Math.max(30, limit * 3) : limit;
    result = await finder.findByQuery(parsed, streetLimit);
  } else if (/^\d+$/.test(q.trim())) {
    result = await finder.findByNumber(parseInt(q, 10), Math.max(30, limit * 3));
  } else {
    result = { rows: [], rowsRead: 0, durationMs: 0, fetches: 0 };
  }
  return { result, ms: performance.now() - start };
}

const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "-");
const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const overlap = (a: number[], b: number[]) => (a.length ? a.filter((id) => b.includes(id)).length / a.length : 1);

function printTable(rows: Record<string, string | number>[]): void {
  const headers = Object.keys(rows[0] ?? {});
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(headers.map((h) => String(r[h]))));
}

function summarize(outcomes: QueryOutcome[], limit: number): void {
  const byCategory = new Map<string, QueryOutcome[]>();
  for (const o of outcomes) {
    byCategory.set(o.category, [...(byCategory.get(o.category) ?? []), o]);
  }
  const rows: Record<string, string | number>[] = [];
  for (const [category, list] of [...byCategory, ["ALL", outcomes] as const]) {
    const withD1 = list.filter((o) => o.d1.length > 0);
    const targeted = list.filter((o) => o.target != null);
    const top = (ids: number[]) => ids.slice(0, limit);
    rows.push({
      category,
      queries: list.length,
      "d1 empty": list.filter((o) => o.d1.length === 0).length,
      "r2 empty": list.filter((o) => o.r2.length === 0).length,
      "top1 same": pct(withD1.filter((o) => o.r2[0] === o.d1[0]).length, withD1.length),
      [`top${limit} overlap`]: pct(withD1.reduce((sum, o) => sum + overlap(top(o.d1), top(o.r2)), 0), withD1.length),
      [`top${limit} same order`]: pct(
        withD1.filter((o) => top(o.d1).join() === top(o.r2).join()).length,
        withD1.length
      ),
      "all overlap": pct(withD1.reduce((sum, o) => sum + overlap(o.d1, o.r2), 0), withD1.length),
      "target in d1": targeted.length ? pct(targeted.filter((o) => top(o.d1).includes(o.target!)).length, targeted.length) : "-",
      "target in r2": targeted.length ? pct(targeted.filter((o) => top(o.r2).includes(o.target!)).length, targeted.length) : "-",
      "d1 ms": avg(list.map((o) => o.d1Ms)).toFixed(2),
      "r2 ms": avg(list.map((o) => o.r2Ms)).toFixed(2),
      "r2 files": avg(list.map((o) => o.r2Fetches)).toFixed(1),
    });
  }
  printTable(rows);
}

async function main(): Promise<void> {
  if (!args.work || (!args.duckdb && !args.streets)) {
    console.error("Usage: compare-search.ts (--duckdb <path> | --streets <streets.json>) --work <dir> [--samples N] [--seed N] [--rebuild] [--report file.json]");
    process.exit(1);
  }
  const work = path.resolve(args.work);
  const limit = Number(args.limit);
  await fsp.mkdir(work, { recursive: true });

  const streets = await loadStreets(work);
  console.log(`${streets.length.toLocaleString()} streets`);

  if (args.rebuild || !fs.existsSync(path.join(work, "search", "meta.json.gz"))) {
    await writeR2SearchIndex(streets, path.join(work, "search"));
  }
  const db = openSqlite(work, streets);
  const d1 = createSqlStreetFinder(sqliteSession(db));
  const r2 = createIndexStreetFinder(fileLoader(work));
  const queries = generateQueries(streets, Number(args.samples), mulberry32(Number(args.seed)));
  console.log(`Running ${queries.length} queries...\n`);

  const outcomes: QueryOutcome[] = [];
  for (const query of queries) {
    const d1Run = await runQuery(d1, query.q, limit);
    const r2Run = await runQuery(r2, query.q, limit);
    outcomes.push({
      ...query,
      d1: d1Run.result.rows.map((r) => r.id),
      r2: r2Run.result.rows.map((r) => r.id),
      d1Display: d1Run.result.rows.slice(0, 3).map((r) => r.display),
      r2Display: r2Run.result.rows.slice(0, 3).map((r) => r.display),
      d1Ms: d1Run.ms,
      r2Ms: r2Run.ms,
      r2Fetches: r2Run.result.fetches,
      corrections: r2Run.result.corrections
        ?.map((c) => `${c.token}→${c.replacements.join("|")}`)
        .join(", "),
    });
  }

  summarize(outcomes, limit);

  const show = Number(args.show);
  const differing = outcomes.filter((o) => o.d1.length > 0 && o.d1[0] !== o.r2[0]);
  console.log(`\nTop result differs for ${differing.length} queries${differing.length > show ? ` (showing ${show})` : ""}:`);
  for (const o of differing.slice(0, show)) {
    console.log(`\n  [${o.category}] "${o.q}"`);
    console.log(`    d1: ${o.d1Display.join(" | ")}`);
    console.log(`    r2: ${o.r2Display.join(" | ") || "(none)"}`);
  }

  const fuzzy = outcomes.filter((o) => o.corrections);
  console.log(`\nFuzzy corrections used for ${fuzzy.length} queries${fuzzy.length > show ? ` (showing ${show})` : ""}:`);
  for (const o of fuzzy.slice(0, show)) {
    const hit = o.target != null ? (o.r2.slice(0, limit).includes(o.target) ? " ✓ target" : " ✗ target") : "";
    console.log(`  "${o.q}" (${o.corrections})${hit} → ${o.r2Display[0] ?? "(none)"}`);
  }

  if (args.report) {
    await fsp.writeFile(args.report, JSON.stringify(outcomes, null, 2));
    console.log(`\nReport written to ${args.report}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
