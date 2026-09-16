import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { AddressResponse } from "../../shared/types";
import { useResolvedSlas } from "../useResolvedSlas";
import { Plate } from "./blade";

/** How many siblings to show at once, and how many to keep above the current one. */
const PAGE_SIZE = 40;
const LEAD_IN = 5;

type Node = { pid: string; label: string };

/**
 * Shows where an address sits among the others GNAF links it to: the site it
 * belongs to, the addresses inside that site, and any alternate forms of the
 * address itself.
 *
 * G-NAF models these as two separate relations. PRIMARY_SECONDARY is physical
 * containment — the units inside a building — and is one level deep. ADDRESS_ALIAS
 * is the same doorway written another way. An address can sit in both at once, so
 * they are drawn as two rows rather than one tree.
 */
export function RelationshipView({ address }: { address: AddressResponse }) {
  const parentPid = address.primary?.pid;
  // Tagged with the PID it belongs to, so a result for the address we just
  // navigated away from is ignored at render rather than cleared in an effect.
  const [fetched, setFetched] = useState<{
    pid: string;
    data: AddressResponse | null;
  } | null>(null);

  // When this address is a unit, its siblings live on the parent record.
  useEffect(() => {
    if (!parentPid) return;
    let cancelled = false;
    fetch(`/api/addresses/${encodeURIComponent(parentPid)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: AddressResponse) => {
        if (!cancelled) setFetched({ pid: parentPid, data });
      })
      .catch(() => {
        if (!cancelled) setFetched({ pid: parentPid, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [parentPid]);

  const forThisParent = fetched?.pid === parentPid ? fetched : null;
  const parent = forThisParent?.data ?? null;
  const parentFailed = forThisParent != null && forThisParent.data === null;

  // The site is either the parent we fetched, or this address when it is one.
  const site = parent ?? (address.secondaries?.length ? address : null);
  const siteIsSelf = site === address;
  const siblings: Node[] = useMemo(
    () =>
      (site?.secondaries ?? []).map((s) => ({ pid: s.pid, label: s.joinType.name })),
    [site]
  );

  // Keep the current address on screen: window the list around it rather than
  // always starting at the top, which for a 3,000-unit tower would never reach it.
  const selfIndex = siblings.findIndex((s) => s.pid === address.pid);
  const start = selfIndex > LEAD_IN ? selfIndex - LEAD_IN : 0;
  const [taken, setTaken] = useState<{ pid: string; n: number }>({
    pid: address.pid,
    n: PAGE_SIZE,
  });
  const take = taken.pid === address.pid ? taken.n : PAGE_SIZE;
  const setTake = (next: (n: number) => number) =>
    setTaken({ pid: address.pid, n: next(take) });
  const visible = useMemo(() => siblings.slice(start, start + take), [siblings, start, take]);
  const hiddenBefore = start;
  const hiddenAfter = Math.max(0, siblings.length - (start + take));

  const aliasNodes: Node[] = useMemo(
    () => (address.aliases ?? []).map((a) => ({ pid: a.pid, label: a.type.name })),
    [address.aliases]
  );

  const pidsToResolve = useMemo(
    () => [
      ...visible.map((v) => v.pid),
      ...aliasNodes.map((a) => a.pid),
      ...(address.alias ? [address.alias.principalPid] : []),
    ],
    [visible, aliasNodes, address.alias]
  );
  const slas = useResolvedSlas(pidsToResolve);

  const hasSite = site != null || parentFailed;
  const hasAliases = aliasNodes.length > 0 || address.alias != null;
  if (!hasSite && !hasAliases) return null;

  const name = (pid: string) => {
    if (pid === address.pid) return address.sla;
    if (pid === parent?.pid) return parent.sla;
    const s = slas[pid];
    return s === undefined ? null : s === "" ? "" : s;
  };

  return (
    <Plate title="How this address is linked">
      <div className="flex flex-col gap-5 px-3.5 py-4">
        {hasSite && (
          <section>
            <h3 className="m-0 mb-2.5 text-[12px] font-extrabold uppercase tracking-[0.1em] text-ink-mute">
              {siteIsSelf ? "Addresses inside this one" : "The site this address belongs to"}
            </h3>

            {parentFailed && !site && (
              <p className="m-0 text-[12.5px] font-semibold text-ink-mute">
                Couldn’t load the site record ({parentPid}).
              </p>
            )}

            {site && (
              <>
                {/* The site itself, as the blade at the head of the branch. */}
                <NodeRow
                  pid={site.pid}
                  sla={name(site.pid)}
                  role="site"
                  current={siteIsSelf}
                  count={siblings.length}
                />

                {siblings.length > 0 && (
                  <div className="mt-1.5 border-l-[3px] border-ink pl-3.5">
                    {hiddenBefore > 0 && (
                      <p className="m-0 mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-mute">
                        {hiddenBefore.toLocaleString()} above
                      </p>
                    )}
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {visible.map((node) => (
                        <li key={node.pid}>
                          <NodeRow
                            pid={node.pid}
                            sla={name(node.pid)}
                            role={node.label}
                            current={node.pid === address.pid}
                          />
                        </li>
                      ))}
                    </ul>
                    {hiddenAfter > 0 && (
                      <button
                        type="button"
                        onClick={() => setTake((n) => n + PAGE_SIZE)}
                        className="plate-press mt-2 inline-flex items-center rounded-lg border-[2.5px] border-ink bg-white px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.08em] shadow-[0_3px_0_#20241f]"
                      >
                        Show {Math.min(PAGE_SIZE, hiddenAfter)} more · {hiddenAfter.toLocaleString()}{" "}
                        left
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {hasAliases && (
          <section>
            <h3 className="m-0 mb-2.5 text-[12px] font-extrabold uppercase tracking-[0.1em] text-ink-mute">
              {address.alias ? "The address this one is an alias of" : "Other ways to write this address"}
            </h3>

            {address.alias && (
              <NodeRow
                pid={address.alias.principalPid}
                sla={name(address.alias.principalPid)}
                role="principal"
              />
            )}

            {aliasNodes.length > 0 && (
              <>
                <NodeRow pid={address.pid} sla={address.sla} role="principal" current />
                <div className="mt-1.5 border-l-[3px] border-dashed border-ink pl-3.5">
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {aliasNodes.map((node) => (
                      <li key={node.pid}>
                        <NodeRow pid={node.pid} sla={name(node.pid)} role={node.label} alias />
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </Plate>
  );
}

/**
 * One address in the tree. The current address is a green blade — you are here —
 * and everything else is a plate you can walk to.
 */
function NodeRow({
  pid,
  sla,
  role,
  current = false,
  alias = false,
  count,
}: {
  pid: string;
  sla: string | null;
  role: string;
  current?: boolean;
  alias?: boolean;
  count?: number;
}) {
  const text =
    sla === null ? (
      <span className="font-semibold normal-case text-ink-mute">Resolving…</span>
    ) : sla === "" ? (
      <span className="font-semibold normal-case text-ink-mute">Address unavailable</span>
    ) : (
      sla
    );

  const body = (
    <>
      <span className="min-w-0 flex-1 text-[13px] font-bold uppercase leading-snug">{text}</span>
      <span className={`font-mono text-[10px] ${current ? "text-mint" : "text-ink-mute"}`}>{pid}</span>
      <span
        className={`text-[9.5px] font-extrabold uppercase tracking-[0.08em] ${
          current ? "text-mint" : "text-ink-mute"
        }`}
      >
        {count != null ? `${count.toLocaleString()} inside` : role}
      </span>
    </>
  );

  if (current) {
    return (
      <div className="blade-plate block">
        <div className="blade-face flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-white">
          {body}
        </div>
      </div>
    );
  }

  return (
    <Link
      to="/address/$gnafId"
      params={{ gnafId: pid }}
      className={`plate-sm plate-press flex flex-wrap items-center gap-x-2.5 gap-y-1 px-2.5 py-1.5 text-ink no-underline ${
        alias ? "border-dashed" : ""
      }`}
    >
      {body}
    </Link>
  );
}
