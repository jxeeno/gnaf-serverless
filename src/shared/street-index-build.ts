/**
 * Builds the R2 street search index (see street-index.ts) from street entries.
 * Returns file contents keyed by index path; the pipeline writes and uploads them.
 */
import { tokenizeIndexText } from "./index-tokenizer.js";
import {
  COMMON_DF_THRESHOLD,
  COMMON_LIST_LIMIT,
  GROUP_KEY_LENGTH,
  ID_RANGE_SIZE,
  INDEX_FORMAT,
  INDEX_PATHS,
  NAME_LIST_LIMIT,
  NUMBER_LIST_LIMIT,
  PREFIX_LIST_LIMIT,
  ROW,
  addressCountBonus,
  groupKey,
  numberBucketsInRange,
  toIndexRow,
  type GroupFile,
  type IndexMeta,
  type RowListFile,
  type StreetIndexRow,
  type VocabFile,
} from "./street-index.js";
import type { StreetEntry } from "./types.js";

export interface BuildStreetIndexOptions {
  /** Words in more streets than this are treated as common (default COMMON_DF_THRESHOLD) */
  commonDfThreshold?: number;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildStreetIndexFiles(
  streets: StreetEntry[],
  options: BuildStreetIndexOptions = {}
): Map<string, unknown> {
  const commonDfThreshold = options.commonDfThreshold ?? COMMON_DF_THRESHOLD;
  const files = new Map<string, unknown>();
  const rows = streets.map(toIndexRow);

  // Word and prefix statistics
  const rowsByWord = new Map<string, number[]>();
  const rowsByShortPrefix = new Map<string, number[]>();
  const prefixRowCount = new Map<string, number>();
  let totalTokens = 0;
  rows.forEach((row, i) => {
    const doc = tokenizeIndexText(row[ROW.DISPLAY_SEARCH]);
    totalTokens += doc.length;
    const prefixes = new Set<string>();
    for (const word of new Set(doc)) {
      push(rowsByWord, word, i);
      for (let len = 1; len <= GROUP_KEY_LENGTH && len <= word.length; len++) {
        prefixes.add(word.slice(0, len));
      }
    }
    for (const prefix of prefixes) {
      prefixRowCount.set(prefix, (prefixRowCount.get(prefix) ?? 0) + 1);
      if (prefix.length < GROUP_KEY_LENGTH) push(rowsByShortPrefix, prefix, i);
    }
  });

  const commonDf: Record<string, number> = {};
  for (const [word, indexes] of rowsByWord) {
    if (indexes.length > commonDfThreshold) commonDf[word] = indexes.length;
  }

  // Ranking used for truncated lists: address-count bonus plus a street-name bonus, then most addresses
  const topRows = (indexes: number[], nameBonus: (name: string) => number, limit: number): StreetIndexRow[] =>
    indexes
      .map((i) => ({ i, score: nameBonus(rows[i][ROW.NAME]) + addressCountBonus(rows[i][ROW.ADDRESS_COUNT]) }))
      .sort((a, b) => b.score - a.score || rows[b.i][ROW.ADDRESS_COUNT] - rows[a.i][ROW.ADDRESS_COUNT] || a.i - b.i)
      .slice(0, limit)
      .map(({ i }) => rows[i]);

  // Groups: every non-common word with the rows containing it
  const wordsByGroup = new Map<string, string[]>();
  for (const word of [...rowsByWord.keys()].sort()) {
    if (!(word in commonDf)) push(wordsByGroup, groupKey(word), word);
  }
  for (const [key, words] of wordsByGroup) {
    const r: StreetIndexRow[] = [];
    const localIndex = new Map<number, number>();
    const t: GroupFile["t"] = {};
    for (const word of words) {
      const indexes = rowsByWord.get(word)!;
      t[word] = [
        indexes.length,
        indexes.map((i) => {
          let local = localIndex.get(i);
          if (local === undefined) {
            local = r.length;
            localIndex.set(i, local);
            r.push(rows[i]);
          }
          return local;
        }),
      ];
    }
    files.set(INDEX_PATHS.group(key), { t, r } satisfies GroupFile);
  }

  // Common words: top rows only
  for (const word of Object.keys(commonDf).sort()) {
    const nameBonus = (name: string) =>
      name === word ? (word.length >= 4 ? 100 : 15) : name.startsWith(word) ? 10 : 0;
    files.set(INDEX_PATHS.common(word), {
      r: topRows(rowsByWord.get(word)!, nameBonus, COMMON_LIST_LIMIT),
    } satisfies RowListFile);
  }

  // 1–2 character prefixes: top rows only
  for (const [prefix, indexes] of rowsByShortPrefix) {
    const nameBonus = (name: string) => (name.startsWith(prefix) ? 10 : 0);
    files.set(INDEX_PATHS.prefix(prefix), {
      r: topRows(indexes, nameBonus, PREFIX_LIST_LIMIT),
    } satisfies RowListFile);
  }

  // Street names by first character, in id order (the D1 direct query scans in rowid order)
  const byFirstChar = new Map<string, StreetIndexRow[]>();
  for (const row of rows) {
    const char = row[ROW.NAME].charAt(0);
    if (!/^[A-Z0-9]$/.test(char)) continue;
    const list = byFirstChar.get(char);
    if (!list) byFirstChar.set(char, [row]);
    else if (list.length < NAME_LIST_LIMIT) list.push(row);
  }
  for (const [char, list] of byFirstChar) {
    files.set(INDEX_PATHS.names(char), { r: list } satisfies RowListFile);
  }

  // Number buckets: most addresses first
  const numberBuckets = new Map<string, StreetIndexRow[]>();
  const numbered = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row[ROW.NUM_MIN] != null && row[ROW.NUM_MAX] != null)
    .sort((a, b) => b.row[ROW.ADDRESS_COUNT] - a.row[ROW.ADDRESS_COUNT] || a.i - b.i);
  for (const { row } of numbered) {
    for (const key of numberBucketsInRange(row[ROW.NUM_MIN]!, row[ROW.NUM_MAX]!)) {
      const list = numberBuckets.get(key);
      if (!list) numberBuckets.set(key, [row]);
      else if (list.length < NUMBER_LIST_LIMIT) list.push(row);
    }
  }
  for (const [key, list] of numberBuckets) {
    files.set(INDEX_PATHS.numbers(key), { r: list } satisfies RowListFile);
  }

  // Id ranges
  const idRanges = new Map<number, StreetIndexRow[]>();
  for (const row of rows) push(idRanges, Math.floor(row[ROW.ID] / ID_RANGE_SIZE), row);
  for (const [bucket, list] of idRanges) {
    files.set(INDEX_PATHS.ids(bucket), { r: list } satisfies RowListFile);
  }

  // Vocabulary for fuzzy matching
  const vocabWords = [...rowsByWord.keys()].filter((w) => /^[A-Z]+$/.test(w)).sort();
  files.set(INDEX_PATHS.vocab, {
    w: vocabWords.join("\n"),
    d: vocabWords.map((w) => rowsByWord.get(w)!.length),
  } satisfies VocabFile);

  files.set(INDEX_PATHS.meta, {
    format: INDEX_FORMAT,
    streets: rows.length,
    avgTokens: rows.length > 0 ? totalTokens / rows.length : 0,
    commonDf,
    prefixDf: Object.fromEntries(prefixRowCount),
  } satisfies IndexMeta);

  return files;
}
