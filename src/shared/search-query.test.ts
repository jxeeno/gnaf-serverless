import { describe, it, expect } from "vitest";
import { parseSearchQuery, scoreAddress, computeHighlightRanges } from "./search-query.js";
import type { StreetAddressEntry } from "./types.js";

// ──────────────────────────────────────────────
// parseSearchQuery
// ──────────────────────────────────────────────

describe("parseSearchQuery", () => {
  describe("tokenization", () => {
    it("splits on whitespace and commas", () => {
      const r = parseSearchQuery("murray rd, christmas island")!;
      expect(r.textTokens).toEqual(["MURRAY", "RD", "CHRISTMAS", "ISLAND"]);
    });

    it("splits slash notation into separate number tokens", () => {
      const r = parseSearchQuery("3/5 murray st")!;
      expect(r.numTokens).toEqual(["3", "5"]);
      expect(r.textTokens).toContain("MURRAY");
    });

    it("strips non-alphanumeric characters from tokens", () => {
      const r = parseSearchQuery("o'brien street")!;
      expect(r.textTokens).toContain("OBRIEN");
    });

    it("treats digit+alpha tokens as numeric (e.g., 2A)", () => {
      const r = parseSearchQuery("2A murray st")!;
      expect(r.numTokens).toEqual(["2A"]);
      expect(r.textTokens).not.toContain("A");
      expect(r.streetHint).toBe(2);
      expect(r.streetSuffix).toBe("A");
    });

    it("returns null when only numbers are provided", () => {
      expect(parseSearchQuery("123")).toBeNull();
    });

    it("returns null when query is only flat/level keywords", () => {
      expect(parseSearchQuery("unit apartment")).toBeNull();
    });
  });

  describe("flat/level keyword stripping", () => {
    it("strips UNIT from text tokens", () => {
      const r = parseSearchQuery("unit 3 5 murray")!;
      expect(r.textTokens).not.toContain("UNIT");
      expect(r.textTokens).toContain("MURRAY");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("strips APT from text tokens", () => {
      const r = parseSearchQuery("apt 3 murray")!;
      expect(r.textTokens).not.toContain("APT");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("strips APARTMENT from text tokens", () => {
      const r = parseSearchQuery("apartment 3 murray")!;
      expect(r.textTokens).not.toContain("APARTMENT");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("strips LEVEL from text tokens", () => {
      const r = parseSearchQuery("level 2 3 murray")!;
      expect(r.textTokens).not.toContain("LEVEL");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("strips FLOOR from text tokens", () => {
      const r = parseSearchQuery("floor 1 murray")!;
      expect(r.textTokens).not.toContain("FLOOR");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("strips SUITE (SE) from text tokens", () => {
      const r = parseSearchQuery("suite 5 murray")!;
      expect(r.textTokens).not.toContain("SUITE");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("strips informal U alias from text tokens", () => {
      const r = parseSearchQuery("u 3 murray")!;
      expect(r.textTokens).not.toContain("U");
      expect(r.hasUnitKeyword).toBe(true);
      expect(r.flatHint).toBe(3);
    });

    it("strips informal FLT alias from text tokens", () => {
      const r = parseSearchQuery("flt 3 murray")!;
      expect(r.textTokens).not.toContain("FLT");
      expect(r.hasUnitKeyword).toBe(true);
    });

    it("does not strip normal street words", () => {
      const r = parseSearchQuery("murray road")!;
      expect(r.hasUnitKeyword).toBe(false);
    });
  });

  describe("flat vs street number hints", () => {
    it("single number without unit keyword → streetHint", () => {
      const r = parseSearchQuery("5 murray st")!;
      expect(r.streetHint).toBe(5);
      expect(r.flatHint).toBeNull();
    });

    it("single number with unit keyword → flatHint", () => {
      const r = parseSearchQuery("unit 3 murray st")!;
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBeNull();
    });

    it("two numbers → first is flat, last is street", () => {
      const r = parseSearchQuery("3 5 murray st")!;
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(5);
    });

    it("slash notation 3/5 → flat=3, street=5", () => {
      const r = parseSearchQuery("3/5 murray st")!;
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(5);
    });

    it("unit keyword with two numbers → flat=first, street=last", () => {
      const r = parseSearchQuery("unit 3 5 murray")!;
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(5);
    });

    it("no numbers → both hints null", () => {
      const r = parseSearchQuery("murray street")!;
      expect(r.flatHint).toBeNull();
      expect(r.streetHint).toBeNull();
    });

    it("three numbers → first is flat, last is street", () => {
      const r = parseSearchQuery("2 3 28 murray")!;
      expect(r.flatHint).toBe(2);
      expect(r.streetHint).toBe(28);
    });
  });

  describe("alpha flat identifier detection", () => {
    it("strips single letter flat from text tokens (unit A 57 mackellar)", () => {
      const r = parseSearchQuery("unit A 57 mackellar")!;
      expect(r.flatDisplayHint).toBe("A");
      expect(r.textTokens).not.toContain("A");
      expect(r.textTokens).toContain("MACKELLAR");
      expect(r.flatHint).toBeNull(); // pure alpha, no digit part
      expect(r.streetHint).toBe(57);
    });

    it("strips alpha+digit flat from text tokens (unit A1 173 monaro)", () => {
      const r = parseSearchQuery("unit A1 173 monaro")!;
      expect(r.flatDisplayHint).toBe("A1");
      expect(r.textTokens).not.toContain("A1");
      expect(r.flatHint).toBe(1); // digit part extracted
      expect(r.streetHint).toBe(173);
    });

    it("strips multi-alpha+digit flat (unit LG3 72 allara)", () => {
      const r = parseSearchQuery("unit LG3 72 allara")!;
      expect(r.flatDisplayHint).toBe("LG3");
      expect(r.textTokens).not.toContain("LG3");
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(72);
    });

    it("does not detect flat identifier without unit keyword or slash/comma", () => {
      const r = parseSearchQuery("A 57 mackellar")!;
      expect(r.flatDisplayHint).toBeNull();
      // A remains in text tokens (no unit keyword or slash/comma to trigger detection)
      expect(r.textTokens).toContain("A");
    });

    it("detects alpha flat in slash notation (A1/173 monaro)", () => {
      const r = parseSearchQuery("A1/173 monaro")!;
      expect(r.flatDisplayHint).toBe("A1");
      expect(r.flatHint).toBe(1);
      expect(r.streetHint).toBe(173);
      expect(r.textTokens).toEqual(["MONARO"]);
      expect(r.ftsQuery).not.toContain("A1");
    });

    it("detects alpha flat in comma notation (A1, 173 monaro)", () => {
      const r = parseSearchQuery("A1, 173 monaro")!;
      expect(r.flatDisplayHint).toBe("A1");
      expect(r.flatHint).toBe(1);
      expect(r.streetHint).toBe(173);
      expect(r.textTokens).toEqual(["MONARO"]);
    });

    it("detects single letter in slash notation (C/5 murray)", () => {
      // Note: "B" would be treated as BASEMENT keyword (in FLAT_LEVEL_KEYWORDS)
      const r = parseSearchQuery("C/5 murray")!;
      expect(r.flatDisplayHint).toBe("C");
      expect(r.flatHint).toBeNull();
      expect(r.streetHint).toBe(5);
      expect(r.textTokens).toEqual(["MURRAY"]);
    });

    it("does not trigger on numeric slash notation (3/5 murray)", () => {
      const r = parseSearchQuery("3/5 murray")!;
      expect(r.flatDisplayHint).toBeNull();
      // Normal numeric parsing: flat=3, street=5
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(5);
    });

    it("does not trigger on mid-query commas (28 murray rd, canberra)", () => {
      const r = parseSearchQuery("28 murray rd, canberra")!;
      expect(r.flatDisplayHint).toBeNull();
    });

    it("does not match multi-letter non-digit tokens (e.g., street names)", () => {
      const r = parseSearchQuery("unit 3 murray")!;
      expect(r.flatDisplayHint).toBeNull();
      expect(r.textTokens).toContain("MURRAY");
    });

    it("alpha flat excludes token from FTS query", () => {
      const r = parseSearchQuery("unit A1 173 monaro")!;
      expect(r.ftsQuery).not.toContain("A1");
      expect(r.ftsQuery).toContain("MONARO");
    });

    it("returns null when alpha flat leaves no text tokens", () => {
      // "unit A" → textTokens after stripping UNIT and A = []
      expect(parseSearchQuery("unit A")).toBeNull();
    });
  });

  describe("postcode filtering", () => {
    it("filters trailing 4-digit postcode (1 CANBERRA AV, FORREST ACT 2603)", () => {
      const r = parseSearchQuery("1 CANBERRA AV, FORREST ACT 2603")!;
      expect(r.numTokens).toEqual(["1"]);
      expect(r.streetHint).toBe(1);
      expect(r.flatHint).toBeNull();
    });

    it("filters trailing postcode from long address (121 OLD CANTERBURY RD, DULWICH HILL NSW 2203)", () => {
      const r = parseSearchQuery(
        "121 OLD CANTERBURY RD, DULWICH HILL NSW 2203"
      )!;
      expect(r.numTokens).toEqual(["121"]);
      expect(r.streetHint).toBe(121);
      expect(r.flatHint).toBeNull();
    });

    it("filters postcode with slash notation (3/5 MURRAY ST, SYDNEY NSW 2000)", () => {
      const r = parseSearchQuery("3/5 MURRAY ST, SYDNEY NSW 2000")!;
      expect(r.numTokens).toEqual(["3", "5"]);
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(5);
    });

    it("keeps 4-digit number before text tokens as potential street number", () => {
      const r = parseSearchQuery("unit 3 2000 kent")!;
      expect(r.numTokens).toEqual(["3", "2000"]);
      expect(r.flatHint).toBe(3);
      expect(r.streetHint).toBe(2000);
    });

    it("does not filter 3-digit numbers", () => {
      const r = parseSearchQuery("346 kent 200")!;
      expect(r.numTokens).toContain("346");
    });

    it("does not filter 5-digit numbers", () => {
      const r = parseSearchQuery("1 kent 12345")!;
      expect(r.numTokens).toContain("12345");
    });

    it("filters postcode even with unit keyword (unit 10, 99 york st, sydney NSW 2000)", () => {
      const r = parseSearchQuery("unit 10, 99 york st, sydney NSW 2000")!;
      expect(r.numTokens).toEqual(["10", "99"]);
      expect(r.flatHint).toBe(10);
      expect(r.streetHint).toBe(99);
    });

    it("keeps single 4-digit number when it is the only number", () => {
      // "2000 kent" → 2000 is before text, so it's kept
      const r = parseSearchQuery("2000 kent")!;
      expect(r.numTokens).toEqual(["2000"]);
      expect(r.streetHint).toBe(2000);
    });
  });

  describe("FTS5 query generation", () => {
    it("generates prefix search on last token", () => {
      const r = parseSearchQuery("murray")!;
      expect(r.ftsQuery).toBe("MURRAY*");
    });

    it("exact match on non-last tokens, prefix on last", () => {
      const r = parseSearchQuery("christmas murray")!;
      expect(r.ftsQuery).toBe('"CHRISTMAS" AND MURRAY*');
    });

    it("resolves full form street type to exact match (last token)", () => {
      const r = parseSearchQuery("murray road")!;
      // ROAD is already the resolved full form — exact match, no wildcard
      expect(r.ftsQuery).toBe('"MURRAY" AND ROAD');
    });

    it("resolves abbreviation to exact full form + keeps original as prefix (last token)", () => {
      const r = parseSearchQuery("murray rd")!;
      // RD → ROAD (exact), original RD* kept for prefix matching
      expect(r.ftsQuery).toBe('"MURRAY" AND (ROAD OR RD*)');
    });

    it("resolves informal abbreviation AVE (last token)", () => {
      const r = parseSearchQuery("murray ave")!;
      // AVE → AVENUE (exact), original AVE* kept for prefix matching (e.g., AVALON)
      expect(r.ftsQuery).toBe('"MURRAY" AND (AVENUE OR AVE*)');
    });

    it("resolves informal abbreviation CRES (last token)", () => {
      const r = parseSearchQuery("murray cres")!;
      // CRES → CRESCENT (exact), original CRES* kept
      expect(r.ftsQuery).toBe('"MURRAY" AND (CRESCENT OR CRES*)');
    });

    it("resolves informal abbreviation BLVD (last token)", () => {
      const r = parseSearchQuery("murray blvd")!;
      // BLVD → BOULEVARD (exact), original BLVD* kept
      expect(r.ftsQuery).toBe('"MURRAY" AND (BOULEVARD OR BLVD*)');
    });

    it("partial full-form prefix matches naturally", () => {
      // User types "ROA" — not a known abbreviation, stays as ROA* which matches ROAD in index
      const r = parseSearchQuery("murray roa")!;
      expect(r.ftsQuery).toBe('"MURRAY" AND ROA*');
    });

    it("abbreviation prefix still matches locality names (av → AVALON)", () => {
      // "AV" is a known abbreviation for AVENUE — exact AVENUE + prefix AV*
      const r = parseSearchQuery("av")!;
      expect(r.ftsQuery).toContain("AV*");
      expect(r.ftsQuery).toContain("AVENUE");
      expect(r.ftsQuery).not.toContain("AVENUE*");
    });

    it("resolves abbreviation in non-last position, keeping original too", () => {
      const r = parseSearchQuery("murray rd sydney")!;
      expect(r.ftsQuery).toContain('"ROAD"');
      expect(r.ftsQuery).toContain('"RD"');
    });

    it("resolves street suffix abbreviation N to full form NORTH (last token)", () => {
      const r = parseSearchQuery("murray rd n")!;
      expect(r.ftsQuery).toContain("NORTH");
      expect(r.ftsQuery).toContain("N*");
    });

    it("resolves multi-word suffix NE to quoted NORTH EAST (last token)", () => {
      const r = parseSearchQuery("murray rd ne")!;
      expect(r.ftsQuery).toContain('"NORTH EAST"');
      expect(r.ftsQuery).toContain("NE*");
    });

    it("resolves suffix abbreviation in non-last position", () => {
      const r = parseSearchQuery("murray rd n sydney")!;
      expect(r.ftsQuery).toContain('"NORTH"');
      expect(r.ftsQuery).toContain('"N"');
    });

    it("numbers are excluded from FTS query", () => {
      const r = parseSearchQuery("28 murray")!;
      expect(r.ftsQuery).not.toContain("28");
      expect(r.ftsQuery).toContain("MURRAY");
    });

    it("unit keywords are excluded from FTS query", () => {
      const r = parseSearchQuery("unit 3 murray")!;
      expect(r.ftsQuery).not.toContain("UNIT");
      expect(r.ftsQuery).toContain("MURRAY");
    });
  });
});

// ──────────────────────────────────────────────
// scoreAddress
// ──────────────────────────────────────────────

describe("scoreAddress", () => {
  // Helper to make entries concise
  function entry(
    opts: Partial<StreetAddressEntry> & { p?: string; d?: string }
  ): StreetAddressEntry {
    return { p: opts.p ?? "PID1", d: opts.d ?? "", ...opts };
  }

  describe("no numbers in query", () => {
    it("returns 2 (preferred) for bare street entry without flat/level", () => {
      const parsed = parseSearchQuery("murray street")!;
      expect(scoreAddress(entry({ d: "28" }), parsed)).toBe(2);
    });
  });

  describe("single street number (e.g., '5 murray')", () => {
    const parsed = parseSearchQuery("5 murray")!;

    it("bare street address → 100", () => {
      expect(scoreAddress(entry({ n: 5, d: "5" }), parsed)).toBe(100);
    });

    it("street match but entry has flat → 90 (user didn't ask for unit)", () => {
      expect(
        scoreAddress(entry({ f: 1, n: 5, d: "UNIT 1, 5" }), parsed)
      ).toBe(90);
    });

    it("flat number match → 80", () => {
      expect(scoreAddress(entry({ f: 5, d: "UNIT 5, 28" }), parsed)).toBe(80);
    });

    it("partial match in display prefix → 30", () => {
      expect(scoreAddress(entry({ n: 15, d: "15" }), parsed)).toBe(30);
    });

    it("no match → 0", () => {
      expect(scoreAddress(entry({ n: 28, d: "28" }), parsed)).toBe(0);
    });
  });

  describe("flat + street (e.g., '3/5 murray')", () => {
    const parsed = parseSearchQuery("3/5 murray")!;

    it("exact flat + street match → 200", () => {
      expect(
        scoreAddress(entry({ f: 3, n: 5, d: "UNIT 3, 5" }), parsed)
      ).toBe(200);
    });

    it("street match, no flat on entry → 100", () => {
      expect(scoreAddress(entry({ n: 5, d: "5" }), parsed)).toBe(100);
    });

    it("street match, different flat → 90", () => {
      expect(
        scoreAddress(entry({ f: 1, n: 5, d: "UNIT 1, 5" }), parsed)
      ).toBe(90);
    });

    it("flat match only → 70", () => {
      expect(
        scoreAddress(entry({ f: 3, n: 28, d: "UNIT 3, 28" }), parsed)
      ).toBe(70);
    });

    it("partial display match → 30", () => {
      expect(scoreAddress(entry({ n: 35, d: "35" }), parsed)).toBe(30);
    });

    it("no match → 0", () => {
      expect(scoreAddress(entry({ n: 99, d: "99" }), parsed)).toBe(0);
    });
  });

  describe("unit keyword with two numbers (e.g., 'unit 3 5 murray')", () => {
    const parsed = parseSearchQuery("unit 3 5 murray")!;

    it("same hints as slash notation: flat=3, street=5", () => {
      expect(parsed.flatHint).toBe(3);
      expect(parsed.streetHint).toBe(5);
    });

    it("exact flat + street match → 200", () => {
      expect(
        scoreAddress(entry({ f: 3, n: 5, d: "UNIT 3, 5" }), parsed)
      ).toBe(200);
    });

    it("street match, different flat → 90", () => {
      expect(
        scoreAddress(entry({ f: 2, n: 5, d: "UNIT 2, 5" }), parsed)
      ).toBe(90);
    });
  });

  describe("two bare numbers (e.g., '3 5 murray')", () => {
    const parsed = parseSearchQuery("3 5 murray")!;

    it("interprets first as flat, last as street", () => {
      expect(parsed.flatHint).toBe(3);
      expect(parsed.streetHint).toBe(5);
    });

    it("exact flat + street match → 200", () => {
      expect(
        scoreAddress(entry({ f: 3, n: 5, d: "UNIT 3, 5" }), parsed)
      ).toBe(200);
    });
  });

  describe("unit keyword with single number (e.g., 'unit 3 murray')", () => {
    const parsed = parseSearchQuery("unit 3 murray")!;

    it("sets flatHint=3, streetHint=null", () => {
      expect(parsed.flatHint).toBe(3);
      expect(parsed.streetHint).toBeNull();
    });

    it("flat match → 80", () => {
      expect(
        scoreAddress(entry({ f: 3, n: 28, d: "UNIT 3, 28" }), parsed)
      ).toBe(80);
    });

    it("street number match (number could be flat) → 50", () => {
      expect(scoreAddress(entry({ n: 3, d: "3" }), parsed)).toBe(50);
    });

    it("partial display match → 30", () => {
      expect(
        scoreAddress(entry({ f: 13, n: 28, d: "UNIT 13, 28" }), parsed)
      ).toBe(30);
    });

    it("no match → 0", () => {
      expect(scoreAddress(entry({ n: 99, d: "99" }), parsed)).toBe(0);
    });
  });

  describe("alpha-numeric street number (e.g., '2A murray')", () => {
    const parsed = parseSearchQuery("2A murray")!;

    it("sets streetHint=2, streetSuffix=A", () => {
      expect(parsed.streetHint).toBe(2);
      expect(parsed.streetSuffix).toBe("A");
    });

    it("exact number+suffix match → 110", () => {
      expect(scoreAddress(entry({ n: 2, d: "2A" }), parsed)).toBe(110);
    });

    it("same number, different suffix → 90", () => {
      expect(scoreAddress(entry({ n: 2, d: "2B" }), parsed)).toBe(90);
    });

    it("same number, no suffix → 90", () => {
      expect(scoreAddress(entry({ n: 2, d: "2" }), parsed)).toBe(90);
    });

    it("no match → 0", () => {
      expect(scoreAddress(entry({ n: 99, d: "99" }), parsed)).toBe(0);
    });
  });

  describe("address range in display (e.g., '14 murray' matching '14-20')", () => {
    const parsed = parseSearchQuery("14 murray")!;

    it("exact street number match → 100", () => {
      expect(scoreAddress(entry({ n: 14, d: "14-20" }), parsed)).toBe(100);
    });
  });

  // ── Real shard examples for each address pattern ──

  describe("street: plain number (e.g., 6 PEDLEY PL)", () => {
    // d='6'  n=6  f=None  — PEDLEY PL, RICHARDSON ACT 2905
    const parsed = parseSearchQuery("6 pedley")!;

    it("exact street number → 100", () => {
      expect(scoreAddress(entry({ n: 6, d: "6" }), parsed)).toBe(100);
    });

    it("wrong number → 0", () => {
      expect(scoreAddress(entry({ n: 9, d: "9" }), parsed)).toBe(0);
    });
  });

  describe("unit: plain number (e.g., UNIT 24, GLASSHOUSE, 40)", () => {
    // d='UNIT 24, GLASSHOUSE, 40'  n=40  f=24
    const parsed = parseSearchQuery("24/40 henry kendall")!;

    it("exact flat + street → 200", () => {
      expect(
        scoreAddress(entry({ n: 40, f: 24, d: "UNIT 24, GLASSHOUSE, 40" }), parsed)
      ).toBe(200);
    });

    it("street match, different flat → 90", () => {
      expect(
        scoreAddress(entry({ n: 40, f: 10, d: "UNIT 10, GLASSHOUSE, 40" }), parsed)
      ).toBe(90);
    });
  });

  describe("street: digit+alpha (e.g., 11A BRIERLY ST)", () => {
    // d='11A'  n=11  f=None
    const parsed = parseSearchQuery("11A brierly")!;

    it("exact number+suffix → 110", () => {
      expect(scoreAddress(entry({ n: 11, d: "11A" }), parsed)).toBe(110);
    });

    it("same number, different suffix → 90", () => {
      expect(scoreAddress(entry({ n: 11, d: "11B" }), parsed)).toBe(90);
    });

    it("same number, no suffix in display → 90", () => {
      expect(scoreAddress(entry({ n: 11, d: "11" }), parsed)).toBe(90);
    });
  });

  describe("unit: digit+alpha (e.g., SUITE 21B, 33 HIBBERSON ST)", () => {
    // d='SUITE 21B, 33'  n=33  f=21 — note: f is integer only, suffix in d
    const parsed = parseSearchQuery("suite 21 33 hibberson")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(entry({ n: 33, f: 21, d: "SUITE 21B, 33" }), parsed)
      ).toBe(200);
    });

    it("street match only → 90", () => {
      expect(
        scoreAddress(entry({ n: 33, f: 5, d: "SUITE 5, 33" }), parsed)
      ).toBe(90);
    });
  });

  describe("street: range (e.g., 14-20 BRIERLY ST)", () => {
    // d='14-20'  n=14  f=None
    const parsed = parseSearchQuery("14 brierly")!;

    it("range start matches street number → 100", () => {
      expect(scoreAddress(entry({ n: 14, d: "14-20" }), parsed)).toBe(100);
    });

    it("partial display match on range end → 30", () => {
      // Searching for "20 brierly" — n=14 doesn't match, but "20" appears in d
      const parsed20 = parseSearchQuery("20 brierly")!;
      expect(scoreAddress(entry({ n: 14, d: "14-20" }), parsed20)).toBe(30);
    });
  });

  describe("unit: alpha-prefix via slash notation (e.g., 'A1/173 monaro')", () => {
    const parsed = parseSearchQuery("A1/173 monaro")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(
          entry({ n: 173, f: 1, d: "UNIT A1, JAMES COURT BLK A, 173" }),
          parsed
        )
      ).toBe(200);
    });

    it("street match, different flat → 90", () => {
      expect(
        scoreAddress(
          entry({ n: 173, f: 5, d: "UNIT B5, 173" }),
          parsed
        )
      ).toBe(90);
    });
  });

  describe("unit: alpha-prefix via comma notation (e.g., 'A1, 173 monaro')", () => {
    const parsed = parseSearchQuery("A1, 173 monaro")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(
          entry({ n: 173, f: 1, d: "UNIT A1, JAMES COURT BLK A, 173" }),
          parsed
        )
      ).toBe(200);
    });
  });

  describe("unit: pure alpha via slash notation (e.g., 'C/5 murray')", () => {
    // Note: "B" would be treated as BASEMENT keyword, so use "C" instead
    const parsed = parseSearchQuery("C/5 murray")!;

    it("display flat match + street → 110", () => {
      expect(
        scoreAddress(entry({ n: 5, d: "UNIT C, 5" }), parsed)
      ).toBe(110);
    });

    it("street match, different flat → 90", () => {
      expect(
        scoreAddress(entry({ n: 5, d: "UNIT D, 5" }), parsed)
      ).toBe(90);
    });
  });

  describe("unit: alpha-prefix with alpha query (e.g., 'unit A1 173 monaro')", () => {
    // d='UNIT A1, JAMES COURT BLK A, 173'  n=173  f=1
    // Query uses alpha identifier: flatDisplayHint="A1", flatHint=1, streetHint=173
    const parsed = parseSearchQuery("unit A1 173 monaro")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(
          entry({ n: 173, f: 1, d: "UNIT A1, JAMES COURT BLK A, 173" }),
          parsed
        )
      ).toBe(200);
    });

    it("same integer flat but different alpha prefix → 200", () => {
      // B1 also has f=1, so integer matching gives 200
      expect(
        scoreAddress(
          entry({ n: 173, f: 1, d: "UNIT B1, JAMES COURT BLK B, 173" }),
          parsed
        )
      ).toBe(200);
    });

    it("street match, different flat → 90", () => {
      expect(
        scoreAddress(
          entry({ n: 173, f: 5, d: "UNIT B5, JAMES COURT BLK B, 173" }),
          parsed
        )
      ).toBe(90);
    });
  });

  describe("unit: alpha-prefix with numeric query (e.g., 'unit 1 173 monaro')", () => {
    // Same address, but user types just the number
    const parsed = parseSearchQuery("unit 1 173 monaro")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(
          entry({ n: 173, f: 1, d: "UNIT A1, JAMES COURT BLK A, 173" }),
          parsed
        )
      ).toBe(200);
    });
  });

  describe("unit: multi-alpha with alpha query (e.g., 'unit LG3 72 allara')", () => {
    // d='UNIT LG3, THE GRANDE, 72'  n=72  f=3
    // Query: flatDisplayHint="LG3", flatHint=3, streetHint=72
    const parsed = parseSearchQuery("unit LG3 72 allara")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(
          entry({ n: 72, f: 3, d: "UNIT LG3, THE GRANDE, 72" }),
          parsed
        )
      ).toBe(200);
    });

    it("street match only → 90", () => {
      expect(
        scoreAddress(
          entry({ n: 72, f: 10, d: "UNIT 10, THE GRANDE, 72" }),
          parsed
        )
      ).toBe(90);
    });
  });

  describe("unit: multi-alpha with numeric query (e.g., 'unit 3 72 allara')", () => {
    const parsed = parseSearchQuery("unit 3 72 allara")!;

    it("flat + street match → 200", () => {
      expect(
        scoreAddress(
          entry({ n: 72, f: 3, d: "UNIT LG3, THE GRANDE, 72" }),
          parsed
        )
      ).toBe(200);
    });
  });

  describe("unit: pure alpha with alpha query (e.g., 'unit A 57 mackellar')", () => {
    // d='UNIT A, 57'  n=57  f=None — pure alpha unit has no integer flat number
    // Query: flatDisplayHint="A", flatHint=null, streetHint=57
    const parsed = parseSearchQuery("unit A 57 mackellar")!;

    it("display flat match + street match → 110", () => {
      expect(
        scoreAddress(entry({ n: 57, d: "UNIT A, 57" }), parsed)
      ).toBe(110);
    });

    it("street match, different flat in display → 90", () => {
      expect(
        scoreAddress(entry({ n: 57, d: "UNIT B, 57" }), parsed)
      ).toBe(90);
    });

    it("street match, no flat in display → 90", () => {
      expect(
        scoreAddress(entry({ n: 57, d: "57" }), parsed)
      ).toBe(90);
    });

    it("no match → 0", () => {
      expect(
        scoreAddress(entry({ n: 99, d: "99" }), parsed)
      ).toBe(0);
    });
  });

  describe("unit: pure alpha without keyword (e.g., '57 mackellar')", () => {
    // Without unit keyword, no alpha detection — standard street search
    const parsed = parseSearchQuery("57 mackellar")!;

    it("street match → 100", () => {
      expect(
        scoreAddress(entry({ n: 57, d: "UNIT A, 57" }), parsed)
      ).toBe(100);
    });
  });

  describe("lot: plain number (e.g., LOT 573, CLUB RD)", () => {
    // d='LOT 573'  n=None  f=None — lots have no n or f
    const parsed = parseSearchQuery("573 club")!;

    it("partial display match on lot number → 30", () => {
      expect(
        scoreAddress(entry({ d: "LOT 573" }), parsed)
      ).toBe(30);
    });

    it("no match when different number → 0", () => {
      expect(
        scoreAddress(entry({ d: "LOT 573" }), parseSearchQuery("999 club")!)
      ).toBe(0);
    });
  });

  describe("street: alpha-prefix (e.g., G3 SHORT ST)", () => {
    // d='G3'  n=3  f=None — GNAF stores n=3 (strips alpha prefix)
    const parsed = parseSearchQuery("3 short")!;

    it("street number match → 100", () => {
      expect(scoreAddress(entry({ n: 3, d: "G3" }), parsed)).toBe(100);
    });
  });

  describe("street: digit+multi-alpha (e.g., 68AB NEW CASCADE RD)", () => {
    // d='68AB'  n=68  f=None
    const parsed = parseSearchQuery("68 new cascade")!;

    it("street number match → 100", () => {
      expect(scoreAddress(entry({ n: 68, d: "68AB" }), parsed)).toBe(100);
    });

    it("partial display match → 30", () => {
      // Searching "68AB" — but parser treats as numToken "68" + textToken "AB"
      // since our regex only captures single-alpha suffix
      const parsedFull = parseSearchQuery("68 cascade")!;
      expect(scoreAddress(entry({ n: 68, d: "68AB" }), parsedFull)).toBe(100);
    });
  });

  describe("street: range+suffix (e.g., 12-12A BEEFSTEAK RD)", () => {
    // d='12-12A'  n=12  f=None
    const parsed = parseSearchQuery("12 beefsteak")!;

    it("street number match → 100", () => {
      expect(scoreAddress(entry({ n: 12, d: "12-12A" }), parsed)).toBe(100);
    });

    it("suffix search falls back to partial match → 30", () => {
      // Searching "12A beefsteak" — parsed as streetHint=12, suffix=A
      const parsedSuffix = parseSearchQuery("12A beefsteak")!;
      // n=12 matches, but displayStartsWith("12A") should check "12-12A"
      // "12-12A" doesn't start with "12A" or include ", 12A", so suffix doesn't match exactly → 90
      expect(scoreAddress(entry({ n: 12, d: "12-12A" }), parsedSuffix)).toBe(90);
    });
  });

  describe("level number matching", () => {
    it("level + street match → 200", () => {
      const entry: StreetAddressEntry = {
        p: "PID1",
        d: "LEVEL 10, 99",
        n: 99,
        l: 10,
      };
      const parsed = parseSearchQuery("level 10, 99 york street sydney")!;
      expect(scoreAddress(entry, parsed)).toBe(200);
    });

    it("street match with no flat/level on entry → 100", () => {
      const entry: StreetAddressEntry = { p: "PID2", d: "99", n: 99 };
      const parsed = parseSearchQuery("level 10, 99 york street sydney")!;
      expect(scoreAddress(entry, parsed)).toBe(100);
    });

    it("street match with different level → 90", () => {
      const entry: StreetAddressEntry = {
        p: "PID3",
        d: "LEVEL 5, 99",
        n: 99,
        l: 5,
      };
      const parsed = parseSearchQuery("level 10, 99 york street sydney")!;
      expect(scoreAddress(entry, parsed)).toBe(90);
    });

    it("entry with matching level but no flat (level-only query) → 200", () => {
      // Query "level 10" → levelHint=10, flatHint=null. Level matches, flat not asked.
      const entry: StreetAddressEntry = {
        p: "PID4",
        d: "UNIT 3, LEVEL 10, 99",
        n: 99,
        f: 3,
        l: 10,
      };
      const parsed = parseSearchQuery("level 10, 99 york")!;
      expect(scoreAddress(entry, parsed)).toBe(200);
    });

    it("entry with wrong level scores 90 (street match, different sub-addr)", () => {
      // Entry has f=10, l=5 but query asks for level 10 → l(5) != 10 → mismatch
      const entry: StreetAddressEntry = {
        p: "PID4b",
        d: "UNIT 10, LEVEL 5, 99",
        n: 99,
        f: 10,
        l: 5,
      };
      const parsed = parseSearchQuery("level 10, 99 york")!;
      expect(scoreAddress(entry, parsed)).toBe(90);
    });

    it("level match only (no street match) → 70", () => {
      const entry: StreetAddressEntry = {
        p: "PID5",
        d: "LEVEL 10, 50",
        n: 50,
        l: 10,
      };
      const parsed = parseSearchQuery("level 10, 99 york")!;
      expect(scoreAddress(entry, parsed)).toBe(70);
    });
  });

  describe("level + suite combined (e.g., 'LEVEL 10, SUITE 6, 95 YORK')", () => {
    // Query: levelHint=10, flatHint=6, streetHint=95
    const parsed = parseSearchQuery("LEVEL 10, SUITE 6, 95 YORK ST")!;

    it("all match (level+suite+street) → 200", () => {
      expect(
        scoreAddress(
          { p: "P1", d: "LEVEL 10, SUITE 6, 95", n: 95, f: 6, l: 10 },
          parsed
        )
      ).toBe(200);
    });

    it("level match + street match, no flat on entry → 150 (partial)", () => {
      expect(
        scoreAddress(
          { p: "P2", d: "LEVEL 10, 95", n: 95, l: 10 },
          parsed
        )
      ).toBe(150);
    });

    it("flat match + street match, no level on entry → 150 (partial)", () => {
      expect(
        scoreAddress(
          { p: "P3", d: "SUITE 6, 95", n: 95, f: 6 },
          parsed
        )
      ).toBe(150);
    });

    it("street match, no sub-address on entry → 100", () => {
      expect(
        scoreAddress(
          { p: "P4", d: "95", n: 95 },
          parsed
        )
      ).toBe(100);
    });

    it("street match, wrong level → 90 (mismatch)", () => {
      expect(
        scoreAddress(
          { p: "P5", d: "LEVEL 11, 95", n: 95, l: 11 },
          parsed
        )
      ).toBe(90);
    });

    it("street match, wrong flat → 90 (mismatch)", () => {
      expect(
        scoreAddress(
          { p: "P6", d: "SUITE 3, 95", n: 95, f: 3 },
          parsed
        )
      ).toBe(90);
    });

    it("old shard data (f=6, no l field) → 150 (flat matches, level neutral)", () => {
      // Simulates entry from S3 shard that doesn't have the l field yet
      expect(
        scoreAddress(
          { p: "P7", d: "LEVEL 10, SUITE 6, 95", n: 95, f: 6 },
          parsed
        )
      ).toBe(150);
    });
  });

  describe("postcode does not affect scoring", () => {
    it("'1 CANBERRA AV' with postcode → bare street match = 100", () => {
      const parsed = parseSearchQuery("1 CANBERRA AV, FORREST ACT 2603")!;
      expect(scoreAddress(entry({ n: 1, d: "1" }), parsed)).toBe(100);
    });

    it("UNIT 1 is not incorrectly boosted when postcode is stripped", () => {
      const parsed = parseSearchQuery("1 CANBERRA AV, FORREST ACT 2603")!;
      // flatHint=null, streetHint=1 → entry.n(28) != 1, entry.f(1) == streetHint(1) → 80
      expect(
        scoreAddress(entry({ n: 28, f: 1, d: "UNIT 1, 28" }), parsed)
      ).toBe(80);
    });
  });

  describe("number range matching (number_last / n2)", () => {
    it("exact match on number_first scores normally", () => {
      const parsed = parseSearchQuery("95 york st")!;
      expect(
        scoreAddress(entry({ n: 95, d: "95-99" }), parsed)
      ).toBe(100);
    });

    it("streetHint within [n, n2] range scores as match", () => {
      const parsed = parseSearchQuery("97 york st")!;
      expect(
        scoreAddress(entry({ n: 95, n2: 99, d: "95-99" }), parsed)
      ).toBe(100);
    });

    it("streetHint equal to n2 (upper bound) scores as match", () => {
      const parsed = parseSearchQuery("99 york st")!;
      expect(
        scoreAddress(entry({ n: 95, n2: 99, d: "95-99" }), parsed)
      ).toBe(100);
    });

    it("streetHint outside range does not match as street number", () => {
      const parsed = parseSearchQuery("100 york st")!;
      expect(
        scoreAddress(entry({ n: 95, n2: 99, d: "95-99" }), parsed)
      ).toBe(0);
    });

    it("range match with sub-address hints scores correctly", () => {
      const parsed = parseSearchQuery("level 10, suite 6, 97 york st")!;
      // All match: street in range + level + flat
      expect(
        scoreAddress(entry({ n: 95, n2: 99, f: 6, l: 10, d: "LEVEL 10, SUITE 6, 95-99" }), parsed)
      ).toBe(200);
      // Street in range, partial sub-addr match
      expect(
        scoreAddress(entry({ n: 95, n2: 99, l: 10, d: "LEVEL 10, 95-99" }), parsed)
      ).toBe(150);
      // Street in range, no sub-addr
      expect(
        scoreAddress(entry({ n: 95, n2: 99, d: "95-99" }), parsed)
      ).toBe(100);
      // Street in range, sub-addr mismatch
      expect(
        scoreAddress(entry({ n: 95, n2: 99, l: 11, d: "LEVEL 11, 95-99" }), parsed)
      ).toBe(90);
    });

    it("range match with flat/unit hint (no level)", () => {
      const parsed = parseSearchQuery("3/97 york st")!;
      expect(parsed.flatHint).toBe(3);
      expect(parsed.streetHint).toBe(97);
      // Flat match + street in range
      expect(
        scoreAddress(entry({ n: 95, n2: 99, f: 3, d: "UNIT 3, 95-99" }), parsed)
      ).toBe(200);
      // Street in range but no flat on entry
      expect(
        scoreAddress(entry({ n: 95, n2: 99, d: "95-99" }), parsed)
      ).toBe(100);
    });

    it("entry without n2 only matches exact number_first", () => {
      const parsed = parseSearchQuery("97 york st")!;
      // n=95 without n2 — 97 does not match
      expect(
        scoreAddress(entry({ n: 95, d: "95" }), parsed)
      ).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles entry with undefined d gracefully", () => {
      const parsed = parseSearchQuery("5 murray")!;
      expect(
        scoreAddress(
          { p: "PID1", d: undefined as unknown as string },
          parsed
        )
      ).toBe(0);
    });

    it("handles entry with empty d", () => {
      const parsed = parseSearchQuery("5 murray")!;
      expect(scoreAddress(entry({ d: "" }), parsed)).toBe(0);
    });
  });
});

// ──────────────────────────────────────────────
// computeHighlightRanges
// ──────────────────────────────────────────────

describe("computeHighlightRanges", () => {
  const baseComponents = {
    streetName: "MURRAY",
    streetType: "RD",
    streetSuffix: null,
    localityName: "VILLAWOOD",
    state: "NSW",
    postcode: "2163",
  };

  it("highlights street name and type for basic query", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, baseComponents, "murray rd");
    expect(ranges).toEqual([[0, 6], [7, 9]]);
  });

  it("highlights abbreviation via synonym match (ROA → ROAD → RD)", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, baseComponents, "murray roa");
    expect(ranges).toEqual([[0, 6], [7, 9]]);
  });

  it("highlights partial locality match", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, baseComponents, "murray rd villa");
    expect(ranges).toEqual([[0, 6], [7, 9], [11, 16]]);
  });

  it("highlights full locality match", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, baseComponents, "murray rd villawood");
    expect(ranges).toEqual([[0, 6], [7, 9], [11, 20]]);
  });

  it("does not false-positive match ST inside FORREST", () => {
    const display = "FORREST ST, SYDNEY, NSW, 2000";
    const ranges = computeHighlightRanges(display, {
      streetName: "FORREST",
      streetType: "ST",
      streetSuffix: null,
      localityName: "SYDNEY",
      state: "NSW",
      postcode: "2000",
    }, "forrest st");
    // ST should only highlight the street type at position 8-10, not inside FORREST
    expect(ranges).toEqual([[0, 7], [8, 10]]);
  });

  it("highlights street number in display prefix (SLA)", () => {
    const sla = "28 MURRAY RD, VILLAWOOD NSW 2163";
    const ranges = computeHighlightRanges(sla, {
      ...baseComponents,
      displayPrefix: "28",
    }, "28 murray");
    expect(ranges).toContainEqual([0, 2]); // "28"
    expect(ranges).toContainEqual([3, 9]); // "MURRAY"
  });

  it("highlights unit + flat + street number in SLA", () => {
    const sla = "UNIT 3, 28 MURRAY RD, VILLAWOOD NSW 2163";
    const ranges = computeHighlightRanges(sla, {
      ...baseComponents,
      displayPrefix: "UNIT 3, 28",
    }, "unit 3 28 murray");
    expect(ranges).toContainEqual([5, 6]); // "3"
    expect(ranges).toContainEqual([8, 10]); // "28"
    expect(ranges).toContainEqual([11, 17]); // "MURRAY"
  });

  it("highlights apostrophe street name when query omits apostrophe", () => {
    const display = "O'DEA ST, SYDNEY, NSW, 2000";
    const ranges = computeHighlightRanges(display, {
      streetName: "O'DEA",
      streetType: "ST",
      streetSuffix: null,
      localityName: "SYDNEY",
      state: "NSW",
      postcode: "2000",
    }, "odea st");
    expect(ranges).toEqual([[0, 5], [6, 8]]);
  });

  it("highlights apostrophe street name when query includes apostrophe", () => {
    const display = "O'DEA ST, SYDNEY, NSW, 2000";
    const ranges = computeHighlightRanges(display, {
      streetName: "O'DEA",
      streetType: "ST",
      streetSuffix: null,
      localityName: "SYDNEY",
      state: "NSW",
      postcode: "2000",
    }, "o'dea st");
    expect(ranges).toEqual([[0, 5], [6, 8]]);
  });

  it("returns empty array for empty query", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    expect(computeHighlightRanges(display, baseComponents, "")).toEqual([]);
  });

  it("highlights state match", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, baseComponents, "murray nsw");
    expect(ranges).toContainEqual([0, 6]); // MURRAY
    expect(ranges).toContainEqual([22, 25]); // NSW
  });

  it("highlights postcode match", () => {
    const display = "MURRAY RD, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, baseComponents, "murray 2163");
    expect(ranges).toContainEqual([0, 6]); // MURRAY
  });

  it("highlights street suffix via synonym match (NORTH typed as N)", () => {
    const display = "MURRAY RD N, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, {
      streetName: "MURRAY",
      streetType: "RD",
      streetSuffix: "N",
      localityName: "VILLAWOOD",
      state: "NSW",
      postcode: "2163",
    }, "murray rd north");
    expect(ranges).toContainEqual([0, 6]); // MURRAY
    expect(ranges).toContainEqual([7, 9]); // RD
    expect(ranges).toContainEqual([10, 11]); // N (full component highlighted via synonym)
  });

  it("highlights street suffix when query uses abbreviation", () => {
    const display = "MURRAY RD N, VILLAWOOD, NSW, 2163";
    const ranges = computeHighlightRanges(display, {
      streetName: "MURRAY",
      streetType: "RD",
      streetSuffix: "N",
      localityName: "VILLAWOOD",
      state: "NSW",
      postcode: "2163",
    }, "murray rd n");
    expect(ranges).toContainEqual([0, 6]); // MURRAY
    expect(ranges).toContainEqual([7, 9]); // RD
    expect(ranges).toContainEqual([10, 11]); // N
  });
});
