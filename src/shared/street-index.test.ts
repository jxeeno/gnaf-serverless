import { describe, it, expect } from "vitest";
import { tokenizeIndexText } from "./index-tokenizer.js";
import { parseSearchQuery } from "./search-query.js";
import { buildStreetIndexFiles, type BuildStreetIndexOptions } from "./street-index-build.js";
import {
  boundedEditDistance,
  buildStreetDisplay,
  buildStreetDisplaySearch,
  buildStreetKey,
  createIndexStreetFinder,
  numberBucketKey,
  numberBucketsInRange,
  type IndexLoader,
} from "./street-index.js";
import type { StreetEntry } from "./types.js";

function street(
  id: number,
  name: string,
  type: string,
  typeFull: string,
  locality: string,
  state: string,
  postcode: string,
  addressCount: number,
  numMin: number,
  numMax: number
): StreetEntry {
  const base = { street_name: name, street_type: type, street_suffix: "", locality_name: locality, state, postcode };
  return {
    id,
    display: buildStreetDisplay(base),
    display_search: buildStreetDisplaySearch({
      street_name: name,
      street_type_full: typeFull,
      street_suffix_full: "",
      locality_name: locality,
      state,
      postcode,
    }),
    street_key: buildStreetKey(name, type, "", locality, state, postcode),
    shard_prefix: "000",
    ...base,
    address_count: addressCount,
    digit_shards: null,
    num_min: numMin,
    num_max: numMax,
    flat_min: null,
    flat_max: null,
  };
}

const STREETS: StreetEntry[] = [
  street(1, "GEORGE", "ST", "STREET", "SYDNEY", "NSW", "2000", 2500, 1, 700),
  street(2, "GEORGE", "ST", "STREET", "PARRAMATTA", "NSW", "2150", 900, 1, 300),
  street(3, "MACQUARIE", "ST", "STREET", "SYDNEY", "NSW", "2000", 600, 1, 200),
  street(4, "MACQUARIE", "RD", "ROAD", "SPRINGWOOD", "NSW", "2777", 150, 1, 150),
  street(5, "KENT", "ST", "STREET", "SYDNEY", "NSW", "2000", 400, 1, 500),
  street(6, "KENTUCKY", "RD", "ROAD", "BRISBANE", "QLD", "4000", 30, 1, 60),
  street(7, "HIGH", "ST", "STREET", "KEW", "VIC", "3101", 300, 1000, 1200),
];

function finderFor(options?: BuildStreetIndexOptions) {
  const files = buildStreetIndexFiles(STREETS, options);
  const loader: IndexLoader = {
    load: async <T>(path: string) => (files.get(path) as T | undefined) ?? null,
  };
  return createIndexStreetFinder(loader);
}

async function search(q: string, options?: BuildStreetIndexOptions) {
  return finderFor(options).findByQuery(parseSearchQuery(q)!, 10);
}

const ids = (result: { rows: { id: number }[] }) => result.rows.map((r) => r.id);

describe("tokenizeIndexText", () => {
  it("uppercases, strips diacritics and splits on non-alphanumerics", () => {
    expect(tokenizeIndexText("Café-Road, Sydney NSW 2000")).toEqual(["CAFE", "ROAD", "SYDNEY", "NSW", "2000"]);
  });
});

describe("parseSearchQuery clauses", () => {
  it("mirrors the FTS5 query terms", () => {
    const { clauses } = parseSearchQuery("1 george st syd")!;
    expect(clauses.map((c) => c.token)).toEqual(["GEORGE", "ST", "SYD"]);
    expect(clauses[0].alternatives).toEqual([{ words: ["GEORGE"], prefix: false }]);
    expect(clauses[1].alternatives).toContainEqual({ words: ["STREET"], prefix: false });
    expect(clauses[2]).toMatchObject({ isLast: true, alternatives: [{ words: ["SYD"], prefix: true }] });
  });
});

describe("boundedEditDistance", () => {
  it("counts substitutions, insertions, deletions and transpositions as one edit", () => {
    expect(boundedEditDistance("SYDNY", "SYDNEY", 1, false)?.distance).toBe(1);
    expect(boundedEditDistance("SYDENY", "SYDNEY", 1, false)?.distance).toBe(1);
    expect(boundedEditDistance("MCQUARIE", "MACQUARIE", 1, false)?.distance).toBe(1);
    expect(boundedEditDistance("PARRAMATA", "PARRAMATTA", 1, false)?.distance).toBe(1);
  });

  it("returns null above the limit", () => {
    expect(boundedEditDistance("KENT", "BRISBANE", 1, false)).toBeNull();
    expect(boundedEditDistance("MACQUIRE", "MACQUARIE", 1, false)).toBeNull();
    expect(boundedEditDistance("MACQUIRE", "MACQUARIE", 2, false)?.distance).toBe(2);
  });

  it("matches against the closest prefix in prefix mode", () => {
    expect(boundedEditDistance("SYDNY", "SYDNEYS", 1, true)).toEqual({ distance: 1, length: 5 });
    expect(boundedEditDistance("MACQ", "MACQUARIE", 1, true)).toEqual({ distance: 0, length: 4 });
  });
});

describe("number buckets", () => {
  it("keys numbers by digit count and leading digits", () => {
    expect(numberBucketKey(5)).toBe("1-5");
    expect(numberBucketKey(12)).toBe("2-12");
    expect(numberBucketKey(302)).toBe("3-30");
    expect(numberBucketKey(8012)).toBe("4-80");
  });

  it("lists every bucket overlapping a range", () => {
    expect([...numberBucketsInRange(8, 11)]).toEqual(["1-8", "1-9", "2-10", "2-11"]);
    expect([...numberBucketsInRange(295, 312)]).toEqual(["3-29", "3-30", "3-31"]);
  });
});

describe("createIndexStreetFinder", () => {
  it("finds a street by name, type and locality", async () => {
    expect(ids(await search("macquarie st sydney"))).toEqual([3]);
  });

  it("matches the last word as a prefix", async () => {
    expect(ids(await search("macq")).sort()).toEqual([3, 4]);
    expect(ids(await search("george st parr"))).toEqual([2]);
  });

  it("ranks an exact street name above a prefix match", async () => {
    expect(ids(await search("kent"))).toEqual([5, 6]);
  });

  it("ranks streets whose number range contains the street number first", async () => {
    const result = await finderFor().findByQuery(parseSearchQuery("1100 high st")!, 30);
    expect(result.rows[0].id).toBe(7);
  });

  it("uses common words only as filters", async () => {
    // STREET, NSW and ROAD appear in more than 2 streets here, so they are common
    expect(ids(await search("george st", { commonDfThreshold: 2 })).sort()).toEqual([1, 2]);
    const streetOnly = await search("street", { commonDfThreshold: 2 });
    expect(streetOnly.rows.length).toBeGreaterThan(0);
    expect(streetOnly.rows.every((r) => r.street_type === "ST")).toBe(true);
  });

  it("corrects a misspelled last word", async () => {
    const result = await search("macquarie st sydny");
    expect(ids(result)).toEqual([3]);
    expect(result.corrections?.[0].token).toBe("SYDNY");
    expect(result.rows[0].query_replacements).toEqual({ SYDNY: "SYDNE" });
  });

  it("corrects a misspelled street name", async () => {
    expect(ids(await search("macquire st sydney"))).toEqual([3]);
    expect(ids(await search("kent st sydeny"))).toEqual([5]);
  });

  it("doesn't use fuzzy matching when there are exact matches", async () => {
    const result = await search("kent st");
    expect(result.corrections).toBeUndefined();
  });

  it("finds streets by number and by id", async () => {
    const finder = finderFor();
    expect(ids(await finder.findByNumber(1100, 30))).toEqual([7]);
    const byId = await finder.findById(3);
    expect(byId?.display).toBe("MACQUARIE ST, SYDNEY, NSW, 2000");
    expect(byId?.street_key).toBe("MACQUARIE|ST||SYDNEY|NSW|2000");
    expect(await finder.findById(99)).toBeNull();
  });
});
