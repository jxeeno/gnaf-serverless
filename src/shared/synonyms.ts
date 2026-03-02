/**
 * Bidirectional synonym map for GNAF authority code terms.
 * Generated from GNAF authority tables (STREET_TYPE_AUT, STREET_SUFFIX_AUT,
 * FLAT_TYPE_AUT, LEVEL_TYPE_AUT).
 *
 * Maps each token to all equivalent tokens (including itself).
 * Used at query time to expand FTS5 search terms.
 */

// Build synonym groups from code↔abbreviation pairs
function buildSynonymMap(
  pairs: [string, string][]
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [code, abbrev] of pairs) {
    const uc = code.toUpperCase();
    const ua = abbrev.toUpperCase();
    if (uc === ua) continue;
    const group = [uc, ua];
    map[uc] = group;
    map[ua] = group;
  }
  return map;
}

// Street types: CODE (full) → NAME (abbreviation)
const STREET_TYPE_PAIRS: [string, string][] = [
  ["ACCESS", "ACCS"], ["AIRWALK", "AWLK"], ["ALLEY", "ALLY"],
  ["ALLEYWAY", "ALWY"], ["AMBLE", "AMBL"], ["APPROACH", "APP"],
  ["ARCADE", "ARC"], ["ARTERIAL", "ARTL"], ["ARTERY", "ARTY"],
  ["AVENUE", "AV"], ["BANAN", "BA"], ["BEACH", "BCH"],
  ["BOARDWALK", "BWLK"], ["BOULEVARD", "BVD"], ["BOULEVARDE", "BVDE"],
  ["BOUNDARY", "BDY"], ["BRACE", "BR"], ["BRANCH", "BRAN"],
  ["BREAK", "BRK"], ["BRETT", "BRET"], ["BRIDGE", "BDGE"],
  ["BROADWALK", "BRDWLK"], ["BROADWAY", "BDWY"], ["BUSWAY", "BSWY"],
  ["BYPASS", "BYPA"], ["BYWAY", "BYWY"], ["CAUSEWAY", "CSWY"],
  ["CENTRE", "CTR"], ["CENTREWAY", "CNWY"], ["CHASE", "CH"],
  ["CIRCLE", "CIR"], ["CIRCLET", "CLT"], ["CIRCUIT", "CCT"],
  ["CIRCUS", "CRCS"], ["CLOSE", "CL"], ["CLUSTER", "CLR"],
  ["COLONNADE", "CLDE"], ["COMMON", "CMMN"], ["COMMONS", "CMMNS"],
  ["CONCORD", "CNCD"], ["CONCOURSE", "CON"], ["CONNECTION", "CNTN"],
  ["CONNECTOR", "CONR"], ["COPSE", "CPS"], ["CORNER", "CNR"],
  ["CORSO", "CSO"], ["COURSE", "CRSE"], ["COURT", "CT"],
  ["COURTYARD", "CTYD"], ["CRESCENT", "CR"], ["CREST", "CRST"],
  ["CRIEF", "CRF"], ["CROOK", "CRK"], ["CROSS", "CRSS"],
  ["CROSSING", "CRSG"], ["CROSSOVER", "CRVR"], ["CRUISEWAY", "CUWY"],
  ["CUL-DE-SAC", "CSAC"], ["CUTTING", "CUTT"], ["DEVIATION", "DE"],
  ["DISTRIBUTOR", "DSTR"], ["DIVIDE", "DIV"], ["DOMAIN", "DOM"],
  ["DOWNS", "DWNS"], ["DRIVE", "DR"], ["DRIVEWAY", "DVWY"],
  ["EASEMENT", "ESMT"], ["ELBOW", "ELB"], ["ENTRANCE", "ENT"],
  ["ESPLANADE", "ESP"], ["ESTATE", "EST"], ["EXPRESSWAY", "EXP"],
  ["EXTENSION", "EXTN"], ["FAIRWAY", "FAWY"], ["FIREBREAK", "FBRK"],
  ["FIRELINE", "FLNE"], ["FIRETRACK", "FTRK"], ["FIRETRAIL", "FITR"],
  ["FLATS", "FLTS"], ["FOLLOW", "FOLW"], ["FOOTWAY", "FTWY"],
  ["FORESHORE", "FSHR"], ["FORMATION", "FORM"], ["FREEWAY", "FWY"],
  ["FRONTAGE", "FRTG"], ["FRONT", "FRNT"], ["GARDEN", "GDN"],
  ["GARDENS", "GDNS"], ["GATE", "GTE"], ["GATEWAY", "GWY"],
  ["GLADE", "GLDE"], ["GRANGE", "GRA"], ["GREEN", "GRN"],
  ["GROVE", "GR"], ["GULLY", "GLY"], ["HARBOUR", "HRBR"],
  ["HAVEN", "HVN"], ["HEATH", "HTH"], ["HEIGHTS", "HTS"],
  ["HIGHROAD", "HIRD"], ["HIGHWAY", "HWY"], ["HOLLOW", "HLLW"],
  ["INLET", "INLT"], ["INTERCHANGE", "INTG"], ["ISLAND", "ID"],
  ["JUNCTION", "JNC"], ["KNOLL", "KNOL"], ["LADDER", "LADR"],
  ["LANDING", "LDG"], ["LANEWAY", "LNWY"], ["LEADER", "LEDR"],
  ["LINKWAY", "LNKWAY"], ["LOOKOUT", "LKT"], ["LYNNE", "LYNN"],
  ["MANOR", "MANR"], ["MAZE", "MZ"], ["MEANDER", "MNDR"],
  ["MOTORWAY", "MTWY"], ["NORTH", "NTH"], ["OUTLET", "OTLT"],
  ["OUTLOOK", "OTLK"], ["PALMS", "PLMS"], ["PARADE", "PDE"],
  ["PARADISE", "PRDS"], ["PARKWAY", "PWY"], ["PASSAGE", "PSGE"],
  ["PATHWAY", "PWAY"], ["PENINSULA", "PSLA"], ["PERCH", "PRCH"],
  ["PIAZZA", "PIAZ"], ["PLACE", "PL"], ["PLAZA", "PLZA"],
  ["POCKET", "PKT"], ["POINT", "PNT"], ["PRECINCT", "PREC"],
  ["PROMENADE", "PROM"], ["PURSUIT", "PRST"], ["QUADRANT", "QDRT"],
  ["QUAY", "QY"], ["QUAYS", "QYS"], ["RAMBLE", "RMBL"],
  ["RANGE", "RNGE"], ["REACH", "RCH"], ["RESERVE", "RES"],
  ["RETREAT", "RTT"], ["RETURN", "RTN"], ["RIDGE", "RDGE"],
  ["RIGHT OF WAY", "ROFW"], ["RISING", "RSNG"], ["RIVER", "RVR"],
  ["ROAD", "RD"], ["ROADS", "RDS"], ["ROADWAY", "RDWY"],
  ["ROTARY", "RTY"], ["ROUND", "RND"], ["ROUTE", "RTE"],
  ["SERVICEWAY", "SVWY"], ["SHUNT", "SHUN"], ["SIDING", "SDNG"],
  ["SKYLINE", "SKLN"], ["SLOPE", "SLPE"], ["SOUTH", "STH"],
  ["SQUARE", "SQ"], ["STEPS", "STPS"], ["STRAIGHT", "STRT"],
  ["STRAIT", "STAI"], ["STRAND", "STRA"], ["STREET", "ST"],
  ["STRIP", "STRP"], ["SUBWAY", "SBWY"], ["TERRACE", "TCE"],
  ["THOROUGHFARE", "THFR"], ["THROUGHWAY", "THRU"], ["TOLLWAY", "TLWY"],
  ["TRACK", "TRK"], ["TRAIL", "TRL"], ["TRAMWAY", "TMWY"],
  ["TRAVERSE", "TVSE"], ["TRUNKWAY", "TKWY"], ["TUNNEL", "TUNL"],
  ["UNDERPASS", "UPAS"], ["VALLEY", "VLLY"], ["VIADUCT", "VIAD"],
  ["VIEWS", "VWS"], ["VILLAGE", "VLGE"], ["VILLA", "VLLA"],
  ["VILLAS", "VLLS"], ["VISTA", "VSTA"], ["WALKWAY", "WKWY"],
  ["WATERS", "WTRS"], ["WATERWAY", "WTWY"], ["WHARF", "WHRF"],
  ["WOOD", "WD"], ["WOODS", "WDS"],
];

// Street suffixes: CODE → NAME
const STREET_SUFFIX_PAIRS: [string, string][] = [
  ["CN", "CENTRAL"], ["DE", "DEVIATION"], ["E", "EAST"],
  ["EX", "EXTENSION"], ["IN", "INNER"], ["LR", "LOWER"],
  ["ML", "MALL"], ["N", "NORTH"], ["NE", "NORTH EAST"],
  ["NW", "NORTH WEST"], ["OF", "OFF"], ["OP", "OVERPASS"],
  ["OT", "OUTER"], ["S", "SOUTH"], ["SE", "SOUTH EAST"],
  ["SW", "SOUTH WEST"], ["UP", "UPPER"], ["W", "WEST"],
];

// Flat types: CODE (abbreviation) → NAME (full)
const FLAT_TYPE_PAIRS: [string, string][] = [
  ["ANT", "ANTENNA"], ["APT", "APARTMENT"], ["ATM", "AUTOMATED TELLER MACHINE"],
  ["BBQ", "BARBECUE"], ["BLCK", "BLOCK"], ["BLDG", "BUILDING"],
  ["BNGW", "BUNGALOW"], ["BTSD", "BOATSHED"], ["CARP", "CARPARK"],
  ["CARS", "CARSPACE"], ["COOL", "COOLROOM"], ["CTGE", "COTTAGE"],
  ["DUPL", "DUPLEX"], ["FCTY", "FACTORY"], ["GRGE", "GARAGE"],
  ["HSE", "HOUSE"], ["KSK", "KIOSK"], ["LBBY", "LOBBY"],
  ["LSE", "LEASE"], ["MBTH", "MARINE BERTH"], ["MSNT", "MAISONETTE"],
  ["OFFC", "OFFICE"], ["PTHS", "PENTHOUSE"], ["RESV", "RESERVE"],
  ["RTCE", "ROOF TERRACE"], ["SE", "SUITE"], ["SEC", "SECTION"],
  ["SHRM", "SHOWROOM"], ["STLL", "STALL"], ["STOR", "STORE"],
  ["STR", "STRATA UNIT"], ["STU", "STUDIO"], ["SUBS", "SUBSTATION"],
  ["TNCY", "TENANCY"], ["TNHS", "TOWNHOUSE"], ["TWR", "TOWER"],
  ["VLLA", "VILLA"], ["VLT", "VAULT"], ["WHSE", "WAREHOUSE"],
  ["WKSH", "WORKSHOP"],
];

// Level types: CODE → NAME
const LEVEL_TYPE_PAIRS: [string, string][] = [
  ["B", "BASEMENT"], ["FL", "FLOOR"], ["G", "GROUND"],
  ["L", "LEVEL"], ["LB", "LOBBY"], ["LG", "LOWER GROUND FLOOR"],
  ["M", "MEZZANINE"], ["OD", "OBSERVATION DECK"], ["P", "PARKING"],
  ["PDM", "PODIUM"], ["PLF", "PLATFORM"], ["PTHS", "PENTHOUSE"],
  ["RT", "ROOFTOP"], ["SB", "SUB-BASEMENT"], ["UG", "UPPER GROUND FLOOR"],
  ["UNGD", "UNDERGROUND"],
];

const _synonyms: Record<string, string[]> = {
  ...buildSynonymMap(STREET_TYPE_PAIRS),
  ...buildSynonymMap(STREET_SUFFIX_PAIRS),
  ...buildSynonymMap(FLAT_TYPE_PAIRS),
  ...buildSynonymMap(LEVEL_TYPE_PAIRS),
};

/**
 * Common informal abbreviations not in the official GNAF authority tables.
 * Maps each informal abbreviation to a GNAF term it's equivalent to.
 * The alias is added to the existing synonym group for that term.
 */
const INFORMAL_ALIASES: [string, string][] = [
  // Street types — Australia Post / common usage
  ["AVE", "AVENUE"],
  ["CRES", "CRESCENT"],
  ["BLVD", "BOULEVARD"],
  ["CRT", "COURT"],
  ["DRV", "DRIVE"],
  ["TERR", "TERRACE"],
  ["TER", "TERRACE"],
  ["GRV", "GROVE"],
  ["LN", "LANE"],
  ["PKWY", "PARKWAY"],
  ["SQR", "SQUARE"],
  ["CIRC", "CIRCUIT"],
  ["RDG", "RIDGE"],
  // Flat types
  ["U", "UNIT"],
  ["UN", "UNIT"],
  ["FLT", "FLAT"],
  ["STE", "SUITE"],
];

// Add informal aliases into existing synonym groups
for (const [alias, target] of INFORMAL_ALIASES) {
  const ua = alias.toUpperCase();
  const ut = target.toUpperCase();
  const existing = _synonyms[ut];
  if (existing) {
    // Extend the shared group array and point the alias at it
    if (!existing.includes(ua)) existing.push(ua);
    _synonyms[ua] = existing;
  } else {
    // Target not in map (e.g., UNIT, LANE, FLAT have no GNAF pair) — create a pair
    const group = [ut, ua];
    _synonyms[ut] = group;
    _synonyms[ua] = group;
  }
}

export const SYNONYMS: Record<string, string[]> = _synonyms;

/**
 * Set of all flat type and level type keywords.
 * These should be stripped from FTS5 search terms since they don't
 * appear in the street display column.
 */
export const FLAT_LEVEL_KEYWORDS: Set<string> = new Set([
  "UNIT", "U", "UN", // UNIT + informal aliases
  "FLAT", "FLT",     // FLAT + informal alias
  ...FLAT_TYPE_PAIRS.flat(),
  ...LEVEL_TYPE_PAIRS.flat(),
]);
