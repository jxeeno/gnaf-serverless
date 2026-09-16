import { describe, it, expect } from "vitest";
import { compareScored } from "./search.js";

// Street ids in the order SQL ranked them for
// "lot 3 pleasure point rd pleasure point".
const PLEASURE_POINT_RD = 1;
const RIVERVIEW_RD = 2;
const streetRank = new Map([
  [PLEASURE_POINT_RD, 0],
  [RIVERVIEW_RD, 1],
]);

describe("compareScored", () => {
  it("breaks a score tie in favour of the better-matched street", () => {
    // Both are genuinely lot 3 and score 200. Riverview's PID sorts first, so a
    // PID tiebreak alone put it ahead of the street the query named.
    const riverview = { pid: "GANSW705644268", streetId: RIVERVIEW_RD, score: 200 };
    const pleasurePoint = { pid: "GANSW709931011", streetId: PLEASURE_POINT_RD, score: 200 };

    const sorted = [riverview, pleasurePoint].sort(compareScored(streetRank));
    expect(sorted.map((a) => a.pid)).toEqual(["GANSW709931011", "GANSW705644268"]);
  });

  it("never lets street rank outweigh a higher score", () => {
    const betterScore = { pid: "B", streetId: RIVERVIEW_RD, score: 200 };
    const betterStreet = { pid: "A", streetId: PLEASURE_POINT_RD, score: 100 };

    const sorted = [betterStreet, betterScore].sort(compareScored(streetRank));
    expect(sorted.map((a) => a.pid)).toEqual(["B", "A"]);
  });

  it("still lists a principal before its alias on a better street", () => {
    const alias = { pid: "A", streetId: PLEASURE_POINT_RD, score: 100, aliasOf: "P" };
    const principal = { pid: "P", streetId: RIVERVIEW_RD, score: 100 };

    const sorted = [alias, principal].sort(compareScored(streetRank));
    expect(sorted.map((a) => a.pid)).toEqual(["P", "A"]);
  });

  it("falls back to PID on the same street", () => {
    const b = { pid: "GANSW2", streetId: PLEASURE_POINT_RD, score: 100 };
    const a = { pid: "GANSW1", streetId: PLEASURE_POINT_RD, score: 100 };

    const sorted = [b, a].sort(compareScored(streetRank));
    expect(sorted.map((x) => x.pid)).toEqual(["GANSW1", "GANSW2"]);
  });

  it("puts streets missing from the ranking last", () => {
    const unranked = { pid: "A", streetId: 99, score: 100 };
    const ranked = { pid: "Z", streetId: RIVERVIEW_RD, score: 100 };

    const sorted = [unranked, ranked].sort(compareScored(streetRank));
    expect(sorted.map((x) => x.pid)).toEqual(["Z", "A"]);
  });
});
