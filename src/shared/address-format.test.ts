import { describe, it, expect } from "vitest";
import { formatAddressResponse } from "./address-format";
import type { ShardRecord } from "./types";

const base: ShardRecord = {
  ap: "P",
  nf: 1,
  sn: "MACQUARIE",
  sta: "ST",
  stc: "STREET",
  loc: "SYDNEY",
  pc: "2000",
  st: "NSW",
  stn: "NEW SOUTH WALES",
  lat: -33.86,
  lng: 151.21,
  gtc: "FCS",
  gtn: "FRONTAGE CENTRE SETBACK",
  glc: 7,
  con: 1,
};

describe("formatAddressResponse aliases", () => {
  it("omits alias fields when not linked", () => {
    const res = formatAddressResponse("GANSW1", base);
    expect(res.alias).toBeUndefined();
    expect(res.aliases).toBeUndefined();
  });

  it("includes the principal for alias records", () => {
    const res = formatAddressResponse("GANSW2", {
      ...base,
      ap: "A",
      pp: "GANSW1",
      atc: "RA",
      atn: "RANGED ADDRESS",
    });
    expect(res.alias).toEqual({
      principalPid: "GANSW1",
      type: { code: "RA", name: "RANGED ADDRESS" },
    });
  });

  it("lists aliases for principal records", () => {
    const res = formatAddressResponse("GANSW1", {
      ...base,
      al: [
        ["GANSW2", "RA", "RANGED ADDRESS"],
        ["GANSW3", "SYN", "SYNONYM"],
      ],
    });
    expect(res.aliases).toEqual([
      { pid: "GANSW2", type: { code: "RA", name: "RANGED ADDRESS" } },
      { pid: "GANSW3", type: { code: "SYN", name: "SYNONYM" } },
    ]);
  });
});

describe("formatAddressResponse primary/secondary links", () => {
  it("omits link fields when not linked", () => {
    const res = formatAddressResponse("GANSW1", base);
    expect(res.primary).toBeUndefined();
    expect(res.secondaries).toBeUndefined();
  });

  it("includes the primary for secondary records", () => {
    const res = formatAddressResponse("GANSW717928552", {
      ...base,
      ps: "S",
      sp: "GANSW717928588",
      sjc: "1",
      sjn: "AUTO",
    });
    expect(res.precedence).toBe("secondary");
    expect(res.primary).toEqual({
      pid: "GANSW717928588",
      joinType: { code: "1", name: "AUTO" },
    });
  });

  it("lists secondaries for primary records", () => {
    const res = formatAddressResponse("GANSW717928588", {
      ...base,
      ps: "P",
      sl: [
        ["GANSW717928480", "1", "AUTO"],
        ["GANSW717928483", "2", "MANUAL"],
      ],
    });
    expect(res.precedence).toBe("primary");
    expect(res.secondaries).toEqual([
      { pid: "GANSW717928480", joinType: { code: "1", name: "AUTO" } },
      { pid: "GANSW717928483", joinType: { code: "2", name: "MANUAL" } },
    ]);
  });
});
