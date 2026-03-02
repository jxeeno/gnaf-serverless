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

    it("exact street number match → 100", () => {
      expect(scoreAddress(entry({ n: 5, d: "5" }), parsed)).toBe(100);
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
