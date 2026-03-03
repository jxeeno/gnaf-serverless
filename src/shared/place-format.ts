import type { PlaceShardRecord } from "./types.js";

export function formatPlaceResponse(id: string, record: PlaceShardRecord) {
  return {
    id,
    name: record.nm,
    categories: {
      primary: record.cat,
      alternate: record.cats ?? [],
    },
    address: record.addr
      ? {
          freeform: record.addr,
          locality: record.loc,
          region: record.reg,
          postcode: record.pc,
          country: record.ctr,
        }
      : undefined,
    location: {
      latitude: record.lat,
      longitude: record.lng,
    },
    confidence: record.con,
    contact:
      record.ph || record.web
        ? {
            phone: record.ph,
            website: record.web,
          }
        : undefined,
    brand: record.br,
  };
}
