import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AddressDetail } from "../components/AddressDetail";
import { Container, StatePanel } from "../components/blade";
import type { AddressResponse } from "../../shared/types";

export const Route = createFileRoute("/lotdp/$lotdpId")({
  component: LotDpPage,
});

function LotDpPage() {
  const { lotdpId } = Route.useParams();
  // The last lookup's outcome and the page being viewed, each tagged with the
  // LPID it was for, so a new LPID starts loading on its first page without
  // the effect setting state synchronously.
  const [result, setResult] = useState<{
    lotdpId: string;
    results?: AddressResponse[];
    error?: string;
  } | null>(null);
  const [pageState, setPageState] = useState({ lotdpId, page: 0 });

  const lookup = result?.lotdpId === lotdpId ? result : null;
  const loading = lookup === null;
  const results = lookup?.results ?? [];
  const error = lookup?.error ?? null;
  const page = pageState.lotdpId === lotdpId ? pageState.page : 0;
  const setPage = (next: number | ((page: number) => number)) =>
    setPageState({ lotdpId, page: typeof next === "function" ? next(page) : next });

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/addresses?lotdp=${encodeURIComponent(lotdpId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setResult({ lotdpId, results: Array.isArray(data) ? data : [data] });
      })
      .catch((err) => {
        if (!cancelled) setResult({ lotdpId, error: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, [lotdpId]);

  const total = results.length;
  const current = results[page];

  return (
    <>
      <div className="border-b border-hairline bg-cream-panel">
        <Container className="flex items-center justify-between gap-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.1em]">
        <Link to="/" className="text-ink no-underline hover:text-blade">
          ← Back to search
        </Link>
        <span className="font-mono text-ink-mute">{lotdpId}</span>
        </Container>
      </div>

      <Container className="py-6 sm:py-7">
        {/* The parcel itself is the yellow sign; the addresses on it are blades. */}
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="rounded-xl border-4 border-ink bg-signal px-5 pb-3 pt-2.5 shadow-[0_6px_0_#20241f]">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-[#5a4e00]">
              Legal parcel
            </div>
            <div className="text-[26px] font-black uppercase leading-[1.08] tracking-[-0.015em] sm:text-[34px]">
              {lotdpId}
            </div>
          </div>

          {total > 1 && (
            <div className="flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label="Previous address"
                className="plate-press flex h-9 w-9 items-center justify-center rounded-lg border-[2.5px] border-ink bg-white text-[17px] font-black disabled:text-[#a9aea6] disabled:shadow-none"
              >
                ‹
              </button>
              <span className="text-[15px] font-extrabold tracking-[0.04em]">
                {page + 1} / {total}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
                disabled={page >= total - 1}
                aria-label="Next address"
                className="plate-press flex h-9 w-9 items-center justify-center rounded-lg border-[2.5px] border-ink bg-white text-[17px] font-black shadow-[0_4px_0_#20241f] disabled:text-[#a9aea6] disabled:shadow-none"
              >
                ›
              </button>
            </div>
          )}
        </div>

        {loading && (
          <StatePanel kind="loading" heading="Fetching parcel" detail={lotdpId}>
            Looking up every address on this parcel.
          </StatePanel>
        )}

        {error && (
          <StatePanel kind="error" heading="Blank blade" detail={lotdpId}>
            No addresses carry this parcel reference. Check the state’s parcel format.
          </StatePanel>
        )}

        {total > 1 && (
          <div className="mb-5">
            <div className="mb-2.5 text-[15px] font-extrabold">
              {total} addresses share this parcel
            </div>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {results.map((r, i) => (
                <li key={r.pid}>
                  <button
                    type="button"
                    onClick={() => setPage(i)}
                    aria-current={i === page}
                    className={
                      i === page
                        ? "blade-plate block w-full text-left"
                        : "plate plate-press flex w-full flex-wrap items-center gap-2.5 px-3.5 py-2.5 text-left"
                    }
                  >
                    {i === page ? (
                      <span className="blade-face flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
                        <span className="text-[15px] font-extrabold uppercase text-white sm:text-[16.5px]">
                          {r.sla}
                        </span>
                        <span className="font-mono text-[10.5px] text-mint">{r.pid}</span>
                      </span>
                    ) : (
                      <>
                        <span className="text-[14px] font-bold uppercase sm:text-[15.5px]">
                          {r.sla}
                        </span>
                        <span className="ml-auto font-mono text-[10.5px] text-ink-mute">{r.pid}</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {current && <AddressDetail address={current} />}
      </Container>
    </>
  );
}
