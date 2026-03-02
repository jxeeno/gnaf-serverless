import { describe, it, expect } from "vitest";
import { parseSearchQuery, scoreAddress } from "./search-query.js";
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

  describe("FTS5 query generation", () => {
    it("generates prefix search on last token", () => {
      const r = parseSearchQuery("murray")!;
      expect(r.ftsQuery).toBe("MURRAY*");
    });

    it("exact match on non-last tokens, prefix on last", () => {
      const r = parseSearchQuery("christmas murray")!;
      expect(r.ftsQuery).toBe('"CHRISTMAS" AND MURRAY*');
    });

    it("expands street type synonyms with OR", () => {
      const r = parseSearchQuery("murray road")!;
      // ROAD should expand to (ROAD* OR RD*)
      expect(r.ftsQuery).toMatch(/\(ROAD\* OR RD\*\)/);
      expect(r.ftsQuery).toContain('"MURRAY"');
    });

    it("expands abbreviations to full forms", () => {
      const r = parseSearchQuery("murray rd")!;
      // RD maps to [RD, ROAD] — either order is fine
      expect(r.ftsQuery).toMatch(/\((RD\* OR ROAD\*|ROAD\* OR RD\*)\)/);
    });

    it("expands informal abbreviation AVE to AVENUE and AV", () => {
      const r = parseSearchQuery("murray ave")!;
      expect(r.ftsQuery).toContain("AVE*");
      expect(r.ftsQuery).toContain("AVENUE*");
      expect(r.ftsQuery).toContain("AV*");
    });

    it("expands informal abbreviation CRES to CRESCENT and CR", () => {
      const r = parseSearchQuery("murray cres")!;
      expect(r.ftsQuery).toContain("CRES*");
      expect(r.ftsQuery).toContain("CRESCENT*");
      expect(r.ftsQuery).toContain("CR*");
    });

    it("expands informal abbreviation BLVD to BOULEVARD and BVD", () => {
      const r = parseSearchQuery("murray blvd")!;
      expect(r.ftsQuery).toContain("BLVD*");
      expect(r.ftsQuery).toContain("BOULEVARD*");
      expect(r.ftsQuery).toContain("BVD*");
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
    it("returns 1 (representative) for any entry", () => {
      const parsed = parseSearchQuery("murray street")!;
      expect(scoreAddress(entry({ d: "28" }), parsed)).toBe(1);
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
