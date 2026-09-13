/**
 * Street search over a static index of files in R2, as an alternative to the D1
 * `streets` table and FTS5 index.
 *
 * Files (under gnaf/{version}/):
 *   search/meta.json.gz           row count, average words per street, row counts for common words and short prefixes
 *   search/groups/{KEY}.json.gz   non-common words starting with KEY (first 3 chars) → the rows containing them
 *   search/common/{WORD}.json.gz  top rows for words in more than COMMON_DF_THRESHOLD streets (ROAD, NSW, ...)
 *   search/prefixes/{P}.json.gz   top rows with a word starting with a 1–2 char prefix
 *   search/names/{C}.json.gz      rows whose street name starts with C, in id order
 *   search/numbers/{KEY}.json.gz  rows whose number range overlaps a number bucket, most addresses first
 *   search/ids/{N}.json.gz        rows by id range
 *   search/vocab.json.gz          alphabetic words and their row counts, for fuzzy matching
 *
 * Matching follows the FTS5 query from parseSearchQuery (via `clauses`), and
 * ranking follows the D1 ORDER BY: FTS5 bm25() plus the same SQL bonuses.
 */
import { tokenizeIndexText } from "./index-tokenizer.js";
import type { ParsedQuery, SearchAlternative, SearchClause } from "./search-query.js";
import { capHintTo3Digits, usesDirectNameQuery } from "./street-finder-d1.js";
import type { QueryCorrection, StreetFinder } from "./street-finder.js";
import type { StreetEntry, StreetRow } from "./types.js";

export const INDEX_FORMAT = 1;
/** Words are grouped into files by this many leading characters */
export const GROUP_KEY_LENGTH = 3;
/** Words in more streets than this are only used to filter candidates */
export const COMMON_DF_THRESHOLD = 5000;
export const COMMON_LIST_LIMIT = 3000;
export const PREFIX_LIST_LIMIT = 500;
export const NAME_LIST_LIMIT = 5000;
export const NUMBER_LIST_LIMIT = 500;
export const NUMBER_MAX_DIGITS = 6;
export const ID_RANGE_SIZE = 1000;

// FTS5 bm25() constants
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const FUZZY_MIN_WORD_LENGTH = 4;
const FUZZY_MAX_REPLACEMENTS = 5;
/** Score penalty per edit for fuzzy-corrected words */
export const FUZZY_PENALTY_PER_EDIT = 30;

/** Compact street row stored in index files */
export type StreetIndexRow = [
  id: number,
  streetName: string,
  streetType: string,
  streetSuffix: string,
  localityName: string,
  state: string,
  postcode: string,
  addressCount: number,
  shardPrefix: string,
  digitShards: string | null,
  numMin: number | null,
  numMax: number | null,
  flatMin: number | null,
  flatMax: number | null,
  displaySearch: string,
];

/** Positions in StreetIndexRow */
export const ROW = {
  ID: 0,
  NAME: 1,
  TYPE: 2,
  SUFFIX: 3,
  LOCALITY: 4,
  STATE: 5,
  POSTCODE: 6,
  ADDRESS_COUNT: 7,
  SHARD_PREFIX: 8,
  DIGIT_SHARDS: 9,
  NUM_MIN: 10,
  NUM_MAX: 11,
  FLAT_MIN: 12,
  FLAT_MAX: 13,
  DISPLAY_SEARCH: 14,
} as const;

export interface IndexMeta {
  format: number;
  streets: number;
  avgTokens: number;
  /** Row counts for common words */
  commonDf: Record<string, number>;
  /** Rows containing a word starting with each 1–3 character prefix */
  prefixDf: Record<string, number>;
}

export interface GroupFile {
  /** word → [rows containing it, indexes into r] */
  t: Record<string, [number, number[]]>;
  r: StreetIndexRow[];
}

export interface RowListFile {
  r: StreetIndexRow[];
}

export interface VocabFile {
  /** Newline-separated words */
  w: string;
  /** Row count per word */
  d: number[];
}

export const INDEX_PATHS = {
  meta: "search/meta.json.gz",
  vocab: "search/vocab.json.gz",
  group: (key: string) => `search/groups/${key}.json.gz`,
  common: (word: string) => `search/common/${word}.json.gz`,
  prefix: (prefix: string) => `search/prefixes/${prefix}.json.gz`,
  names: (char: string) => `search/names/${char}.json.gz`,
  numbers: (key: string) => `search/numbers/${key}.json.gz`,
  ids: (bucket: number) => `search/ids/${bucket}.json.gz`,
};

export interface IndexLoader {
  /** Load and parse an index file, or null if it doesn't exist */
  load<T>(path: string): Promise<T | null>;
}

// ── Street rows ─────────────────────────────────────────────────────────

/** Build a street key from components (same format used for street shard lookup) */
export function buildStreetKey(
  streetName: string,
  streetType: string,
  streetSuffix: string,
  localityName: string,
  state: string,
  postcode: string
): string {
  return `${streetName}|${streetType}|${streetSuffix}|${localityName}|${state}|${postcode}`;
}

/** Build a display string from street+locality components */
export function buildStreetDisplay(row: {
  street_name: string;
  street_type: string;
  street_suffix: string;
  locality_name: string;
  state: string;
  postcode: string;
}): string {
  const parts = [row.street_name];
  if (row.street_type) parts[0] += ` ${row.street_type}`;
  if (row.street_suffix) parts[0] += ` ${row.street_suffix}`;
  parts.push(row.locality_name);
  parts.push(row.state);
  if (row.postcode) parts.push(row.postcode);
  return parts.join(", ");
}

/** Build a display_search string using full-form street types and suffixes for better prefix matching */
export function buildStreetDisplaySearch(row: {
  street_name: string;
  street_type_full: string;
  street_suffix_full: string;
  locality_name: string;
  state: string;
  postcode: string;
}): string {
  const parts = [row.street_name];
  if (row.street_type_full) parts[0] += ` ${row.street_type_full}`;
  if (row.street_suffix_full) parts[0] += ` ${row.street_suffix_full}`;
  parts.push(row.locality_name);
  parts.push(row.state);
  if (row.postcode) parts.push(row.postcode);
  return parts.join(", ").replace(/'/g, "");
}

export function toIndexRow(s: StreetEntry): StreetIndexRow {
  return [
    s.id,
    s.street_name,
    s.street_type,
    s.street_suffix,
    s.locality_name,
    s.state,
    s.postcode,
    s.address_count,
    s.shard_prefix,
    s.digit_shards,
    s.num_min,
    s.num_max,
    s.flat_min,
    s.flat_max,
    s.display_search,
  ];
}

/** Expand an index row to the D1 `streets` row shape */
export function indexRowToStreet(r: StreetIndexRow): StreetRow {
  const [id, name, type, suffix, locality, state, postcode, count, shardPrefix, digitShards, numMin, numMax, flatMin, flatMax, displaySearch] = r;
  return {
    id,
    display: buildStreetDisplay({
      street_name: name,
      street_type: type,
      street_suffix: suffix,
      locality_name: locality,
      state,
      postcode,
    }),
    display_search: displaySearch,
    street_key: buildStreetKey(name, type, suffix, locality, state, postcode),
    shard_prefix: shardPrefix,
    street_name: name,
    street_type: type || null,
    street_suffix: suffix || null,
    locality_name: locality,
    state,
    postcode: postcode || null,
    address_count: count,
    digit_shards: digitShards,
    num_min: numMin,
    num_max: numMax,
    flat_min: flatMin,
    flat_max: flatMax,
  };
}

export function groupKey(word: string): string {
  return word.slice(0, GROUP_KEY_LENGTH);
}

/** Number bucket: digit count + leading digits, e.g. 302 → "3-30" (300–309) */
export function numberBucketKey(num: number): string | null {
  if (!Number.isInteger(num) || num < 0) return null;
  const digits = String(num);
  if (digits.length > NUMBER_MAX_DIGITS) return null;
  return `${digits.length}-${digits.slice(0, 2)}`;
}

/** Every number bucket overlapping [min, max] */
export function* numberBucketsInRange(min: number, max: number): Generator<string> {
  for (let len = 1; len <= NUMBER_MAX_DIGITS; len++) {
    const scale = len === 1 ? 1 : 10 ** (len - 2);
    const [firstLead, lastLead] = len === 1 ? [0, 9] : [10, 99];
    for (let lead = firstLead; lead <= lastLead; lead++) {
      const lo = lead * scale;
      const hi = (lead + 1) * scale - 1;
      if (hi < min) continue;
      if (lo > max) return;
      yield `${len}-${lead}`;
    }
  }
}

// ── Matching and ranking ────────────────────────────────────────────────

/** Occurrences of an alternative (word, prefix, or phrase) in a street's words */
export function countAlternative(doc: string[], alt: SearchAlternative): number {
  const { words, prefix } = alt;
  const last = words.length - 1;
  if (last < 0 || doc.length <= last) return 0;
  let count = 0;
  outer: for (let i = 0; i + last < doc.length; i++) {
    for (let j = 0; j < last; j++) {
      if (doc[i + j] !== words[j]) continue outer;
    }
    const word = doc[i + last];
    if (prefix ? word.startsWith(words[last]) : word === words[last]) count++;
  }
  return count;
}

/** SQLite `value LIKE pattern || '%'`: ASCII case-insensitive, `_` matches any character */
function likePrefix(value: string, pattern: string): boolean {
  if (value.length < pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === "%") return true;
    if (p !== "_" && p.toUpperCase() !== value[i].toUpperCase()) return false;
  }
  return true;
}

function inRange(n: number, min: number | null, max: number | null): boolean {
  return min != null && max != null && n >= min && n <= max;
}

export function addressCountBonus(count: number): number {
  if (count >= 2000) return 20;
  if (count >= 500) return 15;
  if (count >= 100) return 10;
  if (count >= 20) return 5;
  return 0;
}

/** Same bonuses as the D1 ranking expression (see street-finder-d1.ts) */
export function rankingBonus(
  row: StreetIndexRow,
  firstTextToken: string,
  streetHint: number | null,
  flatHint: number | null
): number {
  const name = row[ROW.NAME];
  const numMin = row[ROW.NUM_MIN];
  const numMax = row[ROW.NUM_MAX];
  const flatMin = row[ROW.FLAT_MIN];
  const flatMax = row[ROW.FLAT_MAX];
  let bonus = addressCountBonus(row[ROW.ADDRESS_COUNT]);
  if (name === firstTextToken) {
    bonus += firstTextToken.length >= 4 ? 100 : 15;
  } else if (likePrefix(name, firstTextToken)) {
    bonus += 10;
  }
  if (streetHint != null && numMin != null && numMax != null) {
    bonus += inRange(streetHint, numMin, numMax) ? 200 : -50;
  }
  if (flatHint != null && inRange(flatHint, flatMin, flatMax)) {
    bonus += 50;
  }
  return bonus;
}

interface Phrase {
  alt: SearchAlternative;
  idf: number;
}

function phraseIdf(rowCount: number, totalRows: number): number {
  const idf = Math.log((totalRows - rowCount + 0.5) / (rowCount + 0.5));
  return idf > 0 ? idf : 1e-6;
}

/** FTS5 bm25() score (positive; FTS5's rank is the negation) */
function bm25(doc: string[], phrases: Phrase[], avgTokens: number): number {
  const lengthNorm = 1 - BM25_B + (BM25_B * doc.length) / avgTokens;
  let score = 0;
  for (const { alt, idf } of phrases) {
    const tf = countAlternative(doc, alt);
    if (tf > 0) score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm);
  }
  return score;
}

// ── Index access ────────────────────────────────────────────────────────

/** One search's view of the loader: dedupes file loads and counts work */
class IndexSession {
  fetches = 0;
  rowsRead = 0;
  private readonly files = new Map<string, Promise<unknown>>();

  constructor(private readonly loader: IndexLoader) {}

  load<T>(path: string): Promise<T | null> {
    let file = this.files.get(path);
    if (!file) {
      this.fetches++;
      file = this.loader.load<T>(path);
      this.files.set(path, file);
    }
    return file as Promise<T | null>;
  }

  async meta(): Promise<IndexMeta> {
    const meta = await this.load<IndexMeta>(INDEX_PATHS.meta);
    if (!meta) throw new Error("Search index metadata not found");
    if (meta.format !== INDEX_FORMAT) {
      throw new Error(`Unsupported search index format: ${meta.format}`);
    }
    return meta;
  }
}

interface AlternativePlan {
  alt: SearchAlternative;
  /** Word whose group postings list every row this alternative can match */
  driver: { word: string; prefix: boolean } | null;
  /** True if the driver's postings are complete (no common words involved) */
  complete: boolean;
  /** Group files needed for candidates and row counts */
  groupKeys: string[];
  /** Truncated top-row lists, used when no clause can be looked up completely */
  lists: string[];
}

interface ClausePlan {
  clause: SearchClause;
  alternatives: AlternativePlan[];
}

function planAlternative(alt: SearchAlternative, meta: IndexMeta): AlternativePlan {
  const { words, prefix } = alt;
  const last = words[words.length - 1];
  const exactWords = prefix ? words.slice(0, -1) : words;
  const groupKeys = new Set<string>();
  for (const word of exactWords) {
    if (!(word in meta.commonDf)) groupKeys.add(groupKey(word));
  }
  if (prefix && last.length >= GROUP_KEY_LENGTH) groupKeys.add(groupKey(last));

  const rareWord = exactWords.find((w) => !(w in meta.commonDf));
  if (rareWord) {
    return { alt, driver: { word: rareWord, prefix: false }, complete: true, groupKeys: [...groupKeys], lists: [] };
  }

  if (prefix) {
    const commons = Object.keys(meta.commonDf).filter((w) => w.startsWith(last));
    if (last.length >= GROUP_KEY_LENGTH) {
      return {
        alt,
        driver: { word: last, prefix: true },
        complete: commons.length === 0,
        groupKeys: [...groupKeys],
        lists: commons.map((w) => INDEX_PATHS.common(w)),
      };
    }
    return {
      alt,
      driver: null,
      complete: false,
      groupKeys: [...groupKeys],
      lists: [INDEX_PATHS.prefix(last)],
    };
  }

  // Every word is common: only the rarest word's top rows are available
  const rarest = exactWords.reduce((a, b) => (meta.commonDf[a] <= meta.commonDf[b] ? a : b));
  return {
    alt,
    driver: null,
    complete: false,
    groupKeys: [...groupKeys],
    lists: [INDEX_PATHS.common(rarest)],
  };
}

async function loadGroups(session: IndexSession, keys: string[]): Promise<Map<string, GroupFile>> {
  const groups = new Map<string, GroupFile>();
  await Promise.all(
    [...new Set(keys)].map(async (key) => {
      const group = await session.load<GroupFile>(INDEX_PATHS.group(key));
      if (group) groups.set(key, group);
    })
  );
  return groups;
}

/** Add the rows listed in an alternative's driver postings */
function addDriverRows(
  plan: AlternativePlan,
  groups: Map<string, GroupFile>,
  rows: Map<number, StreetIndexRow>,
  ids: Set<number>
): void {
  const { driver } = plan;
  if (!driver) return;
  const group = groups.get(groupKey(driver.word));
  if (!group) return;
  const addPosting = (indexes: number[]) => {
    for (const i of indexes) {
      const row = group.r[i];
      rows.set(row[ROW.ID], row);
      ids.add(row[ROW.ID]);
    }
  };
  if (!driver.prefix) {
    const posting = group.t[driver.word];
    if (posting) addPosting(posting[1]);
    return;
  }
  for (const word in group.t) {
    if (word.startsWith(driver.word)) addPosting(group.t[word][1]);
  }
}

/** Rows containing an alternative, as FTS5 counts them for bm25 (approximate for prefixes and phrases) */
function alternativeRowCount(alt: SearchAlternative, meta: IndexMeta, groups: Map<string, GroupFile>): number {
  const counts = alt.words.map((word, i) => {
    const isPrefix = alt.prefix && i === alt.words.length - 1;
    if (!isPrefix) {
      return meta.commonDf[word] ?? groups.get(groupKey(word))?.t[word]?.[0] ?? 0;
    }
    if (word.length <= GROUP_KEY_LENGTH) return meta.prefixDf[word] ?? 0;
    let count = 0;
    for (const w in meta.commonDf) {
      if (w.startsWith(word)) count += meta.commonDf[w];
    }
    const group = groups.get(groupKey(word));
    if (group) {
      for (const w in group.t) {
        if (w.startsWith(word)) count += group.t[w][0];
      }
    }
    return Math.min(count, meta.streets);
  });
  return Math.min(...counts);
}

interface ScoredRow {
  row: StreetIndexRow;
  score: number;
  replacements?: Record<string, string>;
}

async function findByClauses(
  session: IndexSession,
  meta: IndexMeta,
  parsed: ParsedQuery,
  clauses: SearchClause[],
  streetLimit: number
): Promise<StreetRow[]> {
  if (clauses.length === 0 || clauses.some((c) => c.alternatives.length === 0)) return [];

  const plans: ClausePlan[] = clauses.map((clause) => ({
    clause,
    alternatives: clause.alternatives.map((alt) => planAlternative(alt, meta)),
  }));
  const groups = await loadGroups(
    session,
    plans.flatMap((p) => p.alternatives.flatMap((a) => a.groupKeys))
  );

  const rows = new Map<number, StreetIndexRow>();
  let candidates: Set<number>;
  const complete = plans.filter((p) => p.alternatives.every((a) => a.complete));
  if (complete.length > 0) {
    // Intersect the full posting lists of every clause that has them
    const sets = complete
      .map((p) => {
        const ids = new Set<number>();
        for (const a of p.alternatives) addDriverRows(a, groups, rows, ids);
        return ids;
      })
      .sort((a, b) => a.size - b.size);
    candidates = sets[0];
    for (const other of sets.slice(1)) {
      candidates = new Set([...candidates].filter((id) => other.has(id)));
    }
  } else {
    // Only common words and short prefixes: no clause lists every match, so take
    // candidates from every clause (full postings where an alternative has them,
    // truncated top-row lists otherwise) and let the clause filter below narrow them.
    // Using one clause alone misses matches, e.g. "st ja" needs ST's postings for
    // ST JAMES AV and JA*'s top rows for JAMES ST.
    candidates = new Set();
    const alternatives = plans.flatMap((p) => p.alternatives);
    const lists = await Promise.all(
      [...new Set(alternatives.flatMap((a) => a.lists))].map((path) => session.load<RowListFile>(path))
    );
    for (const a of alternatives) addDriverRows(a, groups, rows, candidates);
    for (const list of lists) {
      for (const row of list?.r ?? []) {
        rows.set(row[ROW.ID], row);
        candidates.add(row[ROW.ID]);
      }
    }
  }
  if (candidates.size === 0) return [];

  const phrases: Phrase[] = plans.flatMap((p) =>
    p.alternatives.map((a) => ({
      alt: a.alt,
      idf: phraseIdf(alternativeRowCount(a.alt, meta, groups), meta.streets),
    }))
  );
  const flatHint = parsed.flatHint ?? parsed.levelHint;
  const firstToken = clauses[0].token;

  const scored: ScoredRow[] = [];
  for (const id of candidates) {
    const row = rows.get(id)!;
    const doc = tokenizeIndexText(row[ROW.DISPLAY_SEARCH]);
    session.rowsRead++;

    let penalty = 0;
    let replacements: Record<string, string> | undefined;
    let matched = true;
    for (const { clause } of plans) {
      let best: SearchAlternative | null = null;
      for (const alt of clause.alternatives) {
        if (best && (alt.penalty ?? 0) >= (best.penalty ?? 0)) continue;
        if (countAlternative(doc, alt) > 0) best = alt;
      }
      if (!best) {
        matched = false;
        break;
      }
      if (best.penalty != null) {
        penalty += best.penalty;
        (replacements ??= {})[clause.token] = best.words.join(" ");
      }
    }
    if (!matched) continue;

    const score =
      bm25(doc, phrases, meta.avgTokens) +
      rankingBonus(row, replacements?.[firstToken] ?? firstToken, parsed.streetHint, flatHint) -
      penalty;
    scored.push({ row, score, replacements });
  }

  scored.sort((a, b) => b.score - a.score || a.row[ROW.ID] - b.row[ROW.ID]);
  return scored.slice(0, streetLimit).map(({ row, replacements }) =>
    replacements ? { ...indexRowToStreet(row), query_replacements: replacements } : indexRowToStreet(row)
  );
}

/** Direct query for a single 1-char token (e.g. "20 W"), matching the D1 LIKE query */
async function findByNamePrefix(
  session: IndexSession,
  parsed: ParsedQuery,
  streetLimit: number
): Promise<StreetRow[]> {
  const token = parsed.textTokens[0];
  const list = await session.load<RowListFile>(INDEX_PATHS.names(token));
  const streetHint = capHintTo3Digits(parsed.streetHint);
  const flatHint = capHintTo3Digits(parsed.flatHint ?? parsed.levelHint);
  const result: StreetRow[] = [];
  for (const row of list?.r ?? []) {
    session.rowsRead++;
    if (!likePrefix(row[ROW.NAME], token)) continue;
    if (streetHint != null && !inRange(streetHint, row[ROW.NUM_MIN], row[ROW.NUM_MAX])) continue;
    if (flatHint != null && !inRange(flatHint, row[ROW.FLAT_MIN], row[ROW.FLAT_MAX])) continue;
    result.push(indexRowToStreet(row));
    if (result.length >= streetLimit) break;
  }
  return result;
}

// ── Fuzzy matching ──────────────────────────────────────────────────────

interface ParsedVocab {
  words: string[];
  rows: number[];
  /** Word indexes by word length */
  byLength: number[][];
}

const parsedVocabs = new WeakMap<VocabFile, ParsedVocab>();

function parseVocab(file: VocabFile): ParsedVocab {
  let vocab = parsedVocabs.get(file);
  if (!vocab) {
    const words = file.w ? file.w.split("\n") : [];
    const byLength: number[][] = [];
    words.forEach((word, i) => (byLength[word.length] ??= []).push(i));
    vocab = { words, rows: file.d, byLength };
    parsedVocabs.set(file, vocab);
  }
  return vocab;
}

// Reused rows for boundedEditDistance
let distRowA = new Int32Array(64);
let distRowB = new Int32Array(64);
let distRowC = new Int32Array(64);

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transpositions)
 * between `a` and `b`, or null if above `maxDistance`. With `prefix`, compares
 * `a` against the closest-matching prefix of `b` and returns that prefix length.
 */
export function boundedEditDistance(
  a: string,
  b: string,
  maxDistance: number,
  prefix: boolean
): { distance: number; length: number } | null {
  const m = a.length;
  const n = prefix ? Math.min(b.length, m + maxDistance) : b.length;
  if (!prefix && Math.abs(n - m) > maxDistance) return null;
  if (b.length < m - maxDistance) return null;
  if (distRowA.length <= n) {
    distRowA = new Int32Array(n + 1);
    distRowB = new Int32Array(n + 1);
    distRowC = new Int32Array(n + 1);
  }

  let prev2 = distRowA;
  let prev = distRowB;
  let cur = distRowC;
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cb = b.charCodeAt(j - 1);
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > maxDistance) return null;
    const recycled = prev2;
    prev2 = prev;
    prev = cur;
    cur = recycled;
  }

  // `prev` now holds the distances for all of `a`
  if (!prefix) {
    return prev[n] <= maxDistance ? { distance: prev[n], length: n } : null;
  }
  let best: { distance: number; length: number } | null = null;
  for (let j = Math.max(1, m - maxDistance); j <= n; j++) {
    const d = prev[j];
    if (d > maxDistance) continue;
    if (!best || d < best.distance || (d === best.distance && Math.abs(j - m) < Math.abs(best.length - m))) {
      best = { distance: d, length: j };
    }
  }
  return best;
}

interface FuzzyMatch {
  replacement: string;
  distance: number;
  rows: number;
}

/** Vocabulary words (or word prefixes) within `maxDistance` edits, closest and most common first */
export function findFuzzyMatches(
  vocab: ParsedVocab,
  word: string,
  prefix: boolean,
  maxDistance: number
): FuzzyMatch[] {
  const matches = new Map<string, FuzzyMatch>();
  const maxLength = prefix ? vocab.byLength.length - 1 : word.length + maxDistance;
  for (let len = Math.max(1, word.length - maxDistance); len <= maxLength && len < vocab.byLength.length; len++) {
    for (const i of vocab.byLength[len] ?? []) {
      const candidate = vocab.words[i];
      const result = boundedEditDistance(word, candidate, maxDistance, prefix);
      if (!result || result.distance === 0) continue;
      const replacement = prefix ? candidate.slice(0, result.length) : candidate;
      const existing = matches.get(replacement);
      if (!existing || result.distance < existing.distance) {
        matches.set(replacement, { replacement, distance: result.distance, rows: vocab.rows[i] });
      } else if (result.distance === existing.distance) {
        existing.rows += vocab.rows[i];
      }
    }
  }
  return [...matches.values()].sort((a, b) => a.distance - b.distance || b.rows - a.rows);
}

async function wordExists(session: IndexSession, meta: IndexMeta, word: string, prefix: boolean): Promise<boolean> {
  if (prefix ? Object.keys(meta.commonDf).some((w) => w.startsWith(word)) : word in meta.commonDf) {
    return true;
  }
  const group = await session.load<GroupFile>(INDEX_PATHS.group(groupKey(word)));
  if (!group) return false;
  return prefix ? Object.keys(group.t).some((w) => w.startsWith(word)) : word in group.t;
}

/**
 * Replace query words with close vocabulary words. First only words missing from
 * the index are corrected; with `includeKnownWords`, every plain word also gets
 * corrections alongside itself (for typos that happen to be real words).
 */
async function buildFuzzyClauses(
  session: IndexSession,
  meta: IndexMeta,
  clauses: SearchClause[],
  includeKnownWords: boolean
): Promise<{ clauses: SearchClause[]; corrections: QueryCorrection[] } | null> {
  const targets: { index: number; known: boolean }[] = [];
  for (let i = 0; i < clauses.length; i++) {
    const { alternatives } = clauses[i];
    // Synonym-expanded tokens (ST, RD, ...) are known terms
    if (alternatives.length !== 1 || alternatives[0].words.length !== 1) continue;
    const [word] = alternatives[0].words;
    if (word.length < FUZZY_MIN_WORD_LENGTH || !/^[A-Z]+$/.test(word)) continue;
    const known = await wordExists(session, meta, word, alternatives[0].prefix);
    if (!known || includeKnownWords) targets.push({ index: i, known });
  }
  if (targets.length === 0) return null;

  const vocabFile = await session.load<VocabFile>(INDEX_PATHS.vocab);
  if (!vocabFile) return null;
  const vocab = parseVocab(vocabFile);

  const fuzzyClauses = [...clauses];
  const corrections: QueryCorrection[] = [];
  for (const { index, known } of targets) {
    const clause = clauses[index];
    const alt = clause.alternatives[0];
    const word = alt.words[0];
    const maxDistance = word.length >= 8 ? 2 : 1;
    const matches = findFuzzyMatches(vocab, word, alt.prefix, maxDistance).slice(0, FUZZY_MAX_REPLACEMENTS);
    if (matches.length === 0) {
      if (known) continue;
      return null; // an unknown word with no correction can't match anything
    }
    fuzzyClauses[index] = {
      ...clause,
      alternatives: [
        ...(known ? [alt] : []),
        ...matches.map((m) => ({
          words: [m.replacement],
          prefix: alt.prefix,
          penalty: m.distance * FUZZY_PENALTY_PER_EDIT,
        })),
      ],
    };
    corrections.push({ token: clause.token, replacements: matches.map((m) => m.replacement) });
  }
  return corrections.length > 0 ? { clauses: fuzzyClauses, corrections } : null;
}

// ── Street finder ───────────────────────────────────────────────────────

export interface IndexStreetFinderOptions {
  /** Retry with corrected words when nothing matches (default true) */
  fuzzy?: boolean;
}

/** Street finder backed by the static R2 search index */
export function createIndexStreetFinder(
  loader: IndexLoader,
  options: IndexStreetFinderOptions = {}
): StreetFinder {
  const fuzzy = options.fuzzy ?? true;

  return {
    backend: "r2",

    async findByQuery(parsed, streetLimit) {
      const start = Date.now();
      const session = new IndexSession(loader);
      const meta = await session.meta();

      let rows: StreetRow[];
      let corrections: QueryCorrection[] | undefined;
      if (usesDirectNameQuery(parsed)) {
        rows = await findByNamePrefix(session, parsed, streetLimit);
      } else {
        rows = await findByClauses(session, meta, parsed, parsed.clauses, streetLimit);
        if (rows.length === 0 && fuzzy) {
          for (const includeKnownWords of [false, true]) {
            const fuzzed = await buildFuzzyClauses(session, meta, parsed.clauses, includeKnownWords);
            if (!fuzzed) continue;
            rows = await findByClauses(session, meta, parsed, fuzzed.clauses, streetLimit);
            if (rows.length > 0) {
              corrections = fuzzed.corrections;
              break;
            }
          }
        }
      }

      return {
        rows,
        rowsRead: session.rowsRead,
        durationMs: Date.now() - start,
        fetches: session.fetches,
        ...(corrections ? { corrections } : {}),
      };
    },

    async findByNumber(num, streetLimit) {
      const start = Date.now();
      const session = new IndexSession(loader);
      const key = numberBucketKey(num);
      const list = key ? await session.load<RowListFile>(INDEX_PATHS.numbers(key)) : null;
      const rows: StreetRow[] = [];
      for (const row of list?.r ?? []) {
        session.rowsRead++;
        if (!inRange(num, row[ROW.NUM_MIN], row[ROW.NUM_MAX])) continue;
        rows.push(indexRowToStreet(row));
        if (rows.length >= streetLimit) break;
      }
      return { rows, rowsRead: session.rowsRead, durationMs: Date.now() - start, fetches: session.fetches };
    },

    async findById(id) {
      if (!Number.isInteger(id) || id < 0) return null;
      const session = new IndexSession(loader);
      const list = await session.load<RowListFile>(INDEX_PATHS.ids(Math.floor(id / ID_RANGE_SIZE)));
      const row = list?.r.find((r) => r[ROW.ID] === id);
      return row ? indexRowToStreet(row) : null;
    },
  };
}
