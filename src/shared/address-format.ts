import type { ShardRecord, AddressResponse } from "./types.js";

/**
 * Build multi-line address (MLA) from structured components.
 * Matches addressr logic: level, flat, building name each get own line,
 * merged if >3 lines before street + locality.
 */
function buildMla(r: ShardRecord): string[] {
  const lines: string[] = [];

  // Level line
  if (r.ltc != null || r.lvn != null) {
    const levelStr = [
      r.ltn ?? "",
      " ",
      r.lnp ?? "",
      r.lvn != null ? String(r.lvn) : "",
      r.lns ?? "",
    ]
      .join("")
      .trim();
    if (levelStr) lines.push(levelStr);
  }

  // Flat line
  if (r.ftc != null || r.fn != null) {
    const flatStr = [
      r.ftn ?? "",
      " ",
      r.fnp ?? "",
      r.fn != null ? String(r.fn) : "",
      r.fns ?? "",
    ]
      .join("")
      .trim();
    if (flatStr) lines.push(flatStr);
  }

  // Building name
  if (r.bn) {
    lines.push(r.bn);
  }

  // If we have 3 prefix lines (level+flat+building), merge first two
  if (lines.length === 3) {
    lines[1] = `${lines[0]}, ${lines[1]}`;
    lines.shift();
  }

  // Street line
  let streetNum = "";
  if (r.nf != null) {
    streetNum = `${r.nfp ?? ""}${r.nf}${r.nfs ?? ""}`;
    if (r.nl != null) {
      streetNum += `-${r.nlp ?? ""}${r.nl}${r.nls ?? ""}`;
    }
    streetNum += " ";
  } else if (r.ln != null) {
    streetNum = `LOT ${r.lp ?? ""}${r.ln}${r.ls ?? ""} `;
  }

  let streetLine = `${streetNum}${r.sn}`;
  if (r.stc) streetLine += ` ${r.sta ?? r.stc}`;
  if (r.ssc) streetLine += ` ${r.ssn ?? r.ssc}`;
  lines.push(streetLine);

  // Locality line
  lines.push(`${r.loc} ${r.st} ${r.pc ?? ""}`);

  return lines;
}

/**
 * Build short multi-line address (SMLA).
 * Only generated when flat exists. Uses compact notation (e.g. "1/19 MURRAY RD").
 */
function buildSmla(r: ShardRecord): string[] | undefined {
  if (r.ftc == null && r.fn == null) return undefined;

  const lines: string[] = [];

  // Level line (compact: code directly concatenated)
  if (r.ltc != null || r.lvn != null) {
    const levelStr = [
      r.ltc ?? "",
      r.lnp ?? "",
      r.lvn != null ? String(r.lvn) : "",
      r.lns ?? "",
    ]
      .join("")
      .trim();
    if (levelStr) lines.push(levelStr);
  }

  // Flat/number as slash notation
  const flatPart = `${r.fnp ?? ""}${r.fn != null ? String(r.fn) : ""}${r.fns ?? ""}/`;

  let numberPart = "";
  if (r.nf != null) {
    numberPart = `${r.nfp ?? ""}${r.nf}${r.nfs ?? ""}`;
    if (r.nl != null) {
      numberPart += `-${r.nlp ?? ""}${r.nl}${r.nls ?? ""}`;
    }
  } else if (r.ln != null) {
    numberPart = `${r.lp ?? ""}${r.ln}${r.ls ?? ""}`;
  }

  let streetLine = `${flatPart}${numberPart} ${r.sn}`;
  if (r.stc) streetLine += ` ${r.sta ?? r.stc}`;
  if (r.ssc) streetLine += ` ${r.ssc}`;
  lines.push(streetLine);

  // Locality line
  lines.push(`${r.loc} ${r.st} ${r.pc ?? ""}`);

  return lines;
}

/**
 * Format a compact ShardRecord into a full addressr-compatible AddressResponse.
 */
export function formatAddressResponse(
  pid: string,
  r: ShardRecord
): AddressResponse {
  const mla = buildMla(r);
  const sla = mla.join(", ");
  const smla = buildSmla(r);
  const ssla = smla?.join(", ");

  const structured: AddressResponse["structured"] = {
    confidence: r.con,
    street: {
      name: r.sn,
    },
    locality: {
      name: r.loc,
    },
    postcode: r.pc,
    state: {
      name: r.stn,
      abbreviation: r.st,
    },
  };

  // Optional structured fields
  if (r.bn) structured.buildingName = r.bn;

  if (r.ln != null) {
    structured.lotNumber = {};
    if (r.lp) structured.lotNumber.prefix = r.lp;
    if (r.ln) structured.lotNumber.number = r.ln;
    if (r.ls) structured.lotNumber.suffix = r.ls;
  }

  if (r.ftc != null || r.fn != null) {
    structured.flat = {
      type: { code: r.ftc ?? "", name: r.ftn ?? "" },
    };
    if (r.fnp) structured.flat.prefix = r.fnp;
    if (r.fn != null) structured.flat.number = r.fn;
    if (r.fns) structured.flat.suffix = r.fns;
  }

  if (r.ltc != null || r.lvn != null) {
    structured.level = {
      type: { code: r.ltc ?? "", name: r.ltn ?? "" },
    };
    if (r.lnp) structured.level.prefix = r.lnp;
    if (r.lvn != null) structured.level.number = r.lvn;
    if (r.lns) structured.level.suffix = r.lns;
  }

  if (r.nf != null) {
    structured.number = {};
    if (r.nfp) structured.number.prefix = r.nfp;
    if (r.nf != null) structured.number.number = r.nf;
    if (r.nfs) structured.number.suffix = r.nfs;
    if (r.nl != null) {
      structured.number.last = {};
      if (r.nlp) structured.number.last.prefix = r.nlp;
      if (r.nl != null) structured.number.last.number = r.nl;
      if (r.nls) structured.number.last.suffix = r.nls;
    }
  }

  // Street type: code = long form (e.g. "ROAD"), name = abbreviation (e.g. "RD")
  if (r.stc) {
    structured.street.type = { code: r.stc, name: r.sta ?? r.stc };
  }
  if (r.ssc) {
    structured.street.suffix = { code: r.ssc, name: r.ssn ?? r.ssc };
  }
  if (r.scc) {
    structured.street.class = { code: r.scc, name: r.scn ?? r.scc };
  }
  if (r.lcc) {
    structured.locality.class = { code: r.lcc, name: r.lcn ?? r.lcc };
  }

  const response: AddressResponse = {
    pid,
    sla,
    mla,
    structured,
    geocoding: {
      level: {
        code: String(r.glc),
        name: r.gln ?? "",
      },
      geocodes: [
        {
          default: true,
          latitude: r.lat,
          longitude: r.lng,
          type: {
            code: r.gtc,
            name: r.gtn,
          },
        },
      ],
    },
  };

  if (r.lpi) response.lpid = r.lpi;
  if (ssla) response.ssla = ssla;
  if (smla) response.smla = smla;

  if (r.ps) {
    response.precedence = r.ps === "P" ? "primary" : "secondary";
  } else if (r.ap === "P") {
    response.precedence = "primary";
  }

  return response;
}
