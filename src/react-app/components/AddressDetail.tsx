import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { AddressResponse } from "../../shared/types";
import { AddressMap } from "../AddressMap";
import { useResolvedSlas } from "../useResolvedSlas";
import { Blade, FieldRow, Pill, Plate } from "./blade";

/**
 * Resolving each linked PID costs a request, and a handful of buildings have
 * thousands of units, so reveal them a page at a time rather than all at once.
 */
const PAGE_SIZE = 50;

export interface DetailTiming {
  totalMs: number;
}

/**
 * A list of linked addresses (aliases, or the secondaries of a building). Shows
 * the PID immediately and fills in the address as each one resolves.
 */
function LinkedAddressList({ items }: { items: { pid: string; label: string }[] }) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const visible = useMemo(() => items.slice(0, shown), [items, shown]);
  const pids = useMemo(() => visible.map((i) => i.pid), [visible]);
  const slas = useResolvedSlas(pids);
  const remaining = items.length - visible.length;

  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {visible.map((item) => {
          const sla = slas[item.pid];
          return (
            <li key={item.pid}>
              <Link
                to="/address/$gnafId"
                params={{ gnafId: item.pid }}
                className="plate-sm plate-press flex flex-wrap items-center gap-x-2.5 gap-y-1 px-2.5 py-1.5 text-ink no-underline"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold uppercase">
                  {sla === undefined ? (
                    <span className="font-semibold normal-case text-ink-mute">Resolving…</span>
                  ) : sla === "" ? (
                    <span className="font-semibold normal-case text-ink-mute">Address unavailable</span>
                  ) : (
                    sla
                  )}
                </span>
                <span className="font-mono text-[10px] text-ink-mute">{item.pid}</span>
                <span className="text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-ink-mute">
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE_SIZE)}
          className="plate-press mt-2.5 inline-flex items-center rounded-lg border-[2.5px] border-ink bg-white px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.08em] shadow-[0_3px_0_#20241f]"
        >
          Show {Math.min(PAGE_SIZE, remaining)} more · {remaining.toLocaleString()} left
        </button>
      )}
    </>
  );
}

export function AddressDetail({
  address,
  timing,
}: {
  address: AddressResponse;
  timing?: DetailTiming;
}) {
  const [jsonOpen, setJsonOpen] = useState(false);

  // The two single links in the header, resolved so they name an address
  // rather than just a PID.
  const headerPids = useMemo(
    () =>
      [address.alias?.principalPid, address.primary?.pid].filter(
        (pid): pid is string => pid != null
      ),
    [address.alias?.principalPid, address.primary?.pid]
  );
  const headerSlas = useResolvedSlas(headerPids);

  const geocode =
    address.geocoding.geocodes.find((g) => g.default) ?? address.geocoding.geocodes[0];

  // The blade carries the street line; everything else sits above it as context.
  const bladeLine = address.mla[0] ?? address.sla;
  const bladeContext = address.mla.slice(1).join(" · ");

  return (
    <div>
      <Blade context={bladeContext || undefined}>{bladeLine}</Blade>

      <div className="mt-4 flex flex-wrap gap-2">
        <Pill tone="mono">{address.pid}</Pill>
        {address.precedence && (
          <Pill tone={address.precedence === "primary" ? "signal" : "line"}>
            {address.precedence}
          </Pill>
        )}
        {address.lpid && <Pill>LPID {address.lpid}</Pill>}
        <Pill>Geocode level {address.geocoding.level.code}</Pill>
        <Pill>Confidence {address.structured.confidence}</Pill>
        {address.alias && (
          <Link
            to="/address/$gnafId"
            params={{ gnafId: address.alias.principalPid }}
            title={address.alias.principalPid}
            className="no-underline"
          >
            <Pill tone="signal">
              {address.alias.type.name} of{" "}
              {headerSlas[address.alias.principalPid] || address.alias.principalPid}
            </Pill>
          </Link>
        )}
        {address.primary && (
          <Link
            to="/address/$gnafId"
            params={{ gnafId: address.primary.pid }}
            title={address.primary.pid}
            className="no-underline"
          >
            <Pill tone="signal">
              Inside {headerSlas[address.primary.pid] || address.primary.pid}
            </Pill>
          </Link>
        )}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        {/* The map is the panel, not a tab behind one. */}
        <div className="relative min-h-[300px] overflow-hidden rounded-xl border-[3px] border-ink shadow-[0_6px_0_#20241f] lg:min-h-[440px]">
          <AddressMap
            latitude={geocode?.latitude}
            longitude={geocode?.longitude}
            label={address.sla}
          />
          {geocode && (
            <div className="pointer-events-none absolute bottom-3 left-3 z-[500] rounded-md bg-ink px-2.5 py-1.5 font-mono text-[10px] tracking-[0.06em] text-cream">
              {geocode.latitude.toFixed(6)}, {geocode.longitude.toFixed(6)} · {geocode.type.name}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3.5">
          <Plate title="Structured address">
            <dl className="m-0 grid grid-cols-[88px_1fr] gap-x-2.5 gap-y-[7px] px-3.5 py-3">
              {address.structured.buildingName && (
                <FieldRow label="Building">{address.structured.buildingName}</FieldRow>
              )}
              {address.structured.flat && (
                <FieldRow label="Flat">
                  {address.structured.flat.type.name}{" "}
                  {[
                    address.structured.flat.prefix,
                    address.structured.flat.number,
                    address.structured.flat.suffix,
                  ]
                    .filter((v) => v != null)
                    .join("")}
                </FieldRow>
              )}
              {address.structured.level && (
                <FieldRow label="Level">
                  {address.structured.level.type.name}{" "}
                  {[
                    address.structured.level.prefix,
                    address.structured.level.number,
                    address.structured.level.suffix,
                  ]
                    .filter((v) => v != null)
                    .join("")}
                </FieldRow>
              )}
              {address.structured.number && (
                <FieldRow label="Number">
                  {[
                    address.structured.number.prefix,
                    address.structured.number.number,
                    address.structured.number.suffix,
                  ]
                    .filter(Boolean)
                    .join("")}
                  {address.structured.number.last &&
                    `–${[
                      address.structured.number.last.prefix,
                      address.structured.number.last.number,
                      address.structured.number.last.suffix,
                    ]
                      .filter(Boolean)
                      .join("")}`}
                </FieldRow>
              )}
              {address.structured.lotNumber && (
                <FieldRow label="Lot">
                  {[
                    address.structured.lotNumber.prefix,
                    address.structured.lotNumber.number,
                    address.structured.lotNumber.suffix,
                  ]
                    .filter(Boolean)
                    .join("")}
                </FieldRow>
              )}
              <FieldRow label="Street">
                {address.structured.street.name}
                {address.structured.street.type && ` · ${address.structured.street.type.name}`}
                {address.structured.street.suffix && ` ${address.structured.street.suffix.name}`}
              </FieldRow>
              <FieldRow label="Locality">{address.structured.locality.name}</FieldRow>
              <FieldRow label="Postcode">{address.structured.postcode ?? "—"}</FieldRow>
              <FieldRow label="State">{address.structured.state.name}</FieldRow>
            </dl>
          </Plate>

          {timing && (
            <div className="flex items-stretch gap-3.5">
              <div className="flex h-[104px] w-[104px] shrink-0 flex-col items-center justify-center rounded-full border-8 border-alarm bg-white shadow-[0_5px_0_#20241f]">
                <div className="text-[26px] font-black leading-none">{timing.totalMs.toFixed(0)}</div>
                <div className="text-[10px] font-extrabold tracking-[0.1em] text-ink-mute">MS TOTAL</div>
              </div>
              <div className="flex-1 rounded-xl bg-ink px-3.5 py-3 font-mono text-[11px] leading-[1.85] text-cream">
                <div className="flex justify-between gap-3">
                  <span className="text-[#a9aea6]">geocode</span>
                  <span className="truncate">{geocode?.type.code ?? "—"}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-[#a9aea6]">level</span>
                  <span className="truncate">{address.geocoding.level.code}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-[#a9aea6]">r2</span>
                  <span>1 shard read</span>
                </div>
              </div>
            </div>
          )}

          {address.overlays && Object.keys(address.overlays).length > 0 && (
            <Plate title="Overlays">
              <div className="flex flex-col gap-3 px-3.5 py-3">
                {Object.entries(address.overlays).map(([key, overlay]) => (
                  <div key={key}>
                    <p className="m-0 mb-1 text-[11px] font-bold uppercase tracking-[0.06em] text-ink-mute">
                      {overlay.label}
                    </p>
                    {overlay.features.map((feature, fi) => (
                      <div key={fi} className="text-[13.5px] font-bold">
                        {Object.values(feature).map(String).join(" · ")}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Plate>
          )}
        </div>
      </div>

      {address.aliases && address.aliases.length > 0 && (
        <div className="mt-4">
          <Plate title={`Aliases · ${address.aliases.length}`}>
            <div className="px-3.5 py-3">
              <LinkedAddressList
                items={address.aliases.map((a) => ({ pid: a.pid, label: a.type.name }))}
              />
            </div>
          </Plate>
        </div>
      )}

      {address.secondaries && address.secondaries.length > 0 && (
        <div className="mt-4">
          <Plate
            title={`Addresses inside this one · ${address.secondaries.length.toLocaleString()}`}
          >
            <div className="px-3.5 py-3">
              <LinkedAddressList
                items={address.secondaries.map((s) => ({ pid: s.pid, label: s.joinType.name }))}
              />
            </div>
          </Plate>
        </div>
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setJsonOpen((v) => !v)}
          aria-expanded={jsonOpen}
          className="plate plate-press flex w-full items-center justify-between px-3.5 py-3 font-mono text-[11.5px]"
        >
          <span>{"{ }"} Raw JSON</span>
          <span className="font-bold">{jsonOpen ? "Collapse ↑" : "Expand ↓"}</span>
        </button>
        {jsonOpen && (
          <pre className="mt-2 max-h-[520px] overflow-auto rounded-xl border-[2.5px] border-ink bg-ink p-4 font-mono text-[11.5px] leading-relaxed text-cream">
            {JSON.stringify(address, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
