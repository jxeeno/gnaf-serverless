import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Container, Pill, StatePanel } from "../components/blade";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

interface SearchResult {
  streetId: number;
  display: string;
  highlight?: [number, number][];
  streetName: string;
  locality: string;
  state: string;
  postcode: string;
  addressCount: number;
}

interface SearchAddressResult {
  pid: string;
  sla: string;
  highlight?: [number, number][];
  streetId: number;
}

interface StreetAddress {
  p: string;
  s: string;
}

interface SearchMeta {
  d1RowsRead: number;
  d1Duration: number;
  s3Fetches: number;
  s3Duration: number;
}

interface RequestLogEntry {
  id: number;
  query: string;
  timestamp: number;
  totalMs: number;
  d1RowsRead: number;
  d1Duration: number;
  s3Fetches: number;
  s3Duration: number;
  streets: number;
  addresses: number;
  stale: boolean;
}

type Lane = "address" | "pid" | "lpid";

const GNAF_PID = /^GA[A-Z]{2,3}_?\d+$/i;

/**
 * Work out which of the three identifiers was typed, so the one box can serve
 * all of them. A PID is unmistakable; a parcel reference is a run of
 * slash-separated parts with no spaces in it; everything else is an address.
 */
function detectLane(raw: string): Lane {
  const q = raw.trim();
  if (GNAF_PID.test(q)) return "pid";
  if (q.length > 1 && !/\s/.test(q) && /[/\\]/.test(q)) return "lpid";
  return "address";
}

const LANE_LABEL: Record<Lane, string> = {
  address: "Address",
  pid: "GNAF PID",
  lpid: "LPID",
};

/** Render text with server-provided highlight ranges. */
function HighlightMatch({ text, highlight }: { text: string; highlight?: [number, number][] }) {
  if (!highlight || highlight.length === 0) return <>{text}</>;

  const parts: React.ReactElement[] = [];
  let prev = 0;
  for (const [start, end] of highlight) {
    if (prev < start) parts.push(<span key={prev}>{text.slice(prev, start)}</span>);
    parts.push(
      <mark key={start} className="rounded-sm bg-signal/70 px-0.5 text-inherit">
        {text.slice(start, end)}
      </mark>
    );
    prev = end;
  }
  if (prev < text.length) parts.push(<span key={prev}>{text.slice(prev)}</span>);

  return <>{parts}</>;
}

/** The leading number of an address line, used to group a long street. */
function leadingDigit(sla: string): string | null {
  const m = /(\d)/.exec(sla);
  return m ? m[1] : null;
}

function IndexPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAddresses, setSearchAddresses] = useState<SearchAddressResult[]>([]);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [selectedStreet, setSelectedStreet] = useState<SearchResult | null>(null);
  const [streetAddresses, setStreetAddresses] = useState<StreetAddress[]>([]);
  const [streetDigit, setStreetDigit] = useState<string | null>(null);
  const [streetLoading, setStreetLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [requestLog, setRequestLog] = useState<RequestLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const lane = detectLane(query);
  const trimmed = query.trim();

  const dropdownItems = useMemo<
    Array<{ type: "address"; data: SearchAddressResult } | { type: "street"; data: SearchResult }>
  >(
    () => [
      ...searchAddresses.map((data) => ({ type: "address" as const, data })),
      ...searchResults.map((data) => ({ type: "street" as const, data })),
    ],
    [searchAddresses, searchResults]
  );

  const hasResults = dropdownItems.length > 0;
  const showResults = lane === "address" && hasResults && !selectedStreet;

  // Debounced search with AbortController for stale request cancellation.
  useEffect(() => {
    if (lane !== "address") return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (q.length < 1) {
      setSearchResults([]);
      setSearchAddresses([]);
      setSearchMeta(null);
      setSelectedStreet(null);
      setActiveIndex(-1);
      return;
    }

    const requestId = ++requestIdRef.current;

    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSearchLoading(true);
      setError(null);
      const fetchStart = performance.now();
      try {
        const res = await fetch(`/api/addresses/search?q=${encodeURIComponent(q)}&limit=10`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }

        const totalMs = performance.now() - fetchStart;
        const isStale = requestId !== requestIdRef.current;

        const data: { streets: SearchResult[]; addresses: SearchAddressResult[] } = await res.json();

        const meta: SearchMeta = {
          d1RowsRead: parseInt(res.headers.get("X-D1-Rows-Read") ?? "0", 10),
          d1Duration: parseFloat(res.headers.get("X-D1-Duration-Ms") ?? "0"),
          s3Fetches: parseInt(res.headers.get("X-R2-Fetches") ?? "0", 10),
          s3Duration: parseFloat(res.headers.get("X-R2-Duration-Ms") ?? "0"),
        };

        setRequestLog((prev) =>
          [
            {
              id: requestId,
              query: q,
              timestamp: Date.now(),
              totalMs,
              d1RowsRead: meta.d1RowsRead,
              d1Duration: meta.d1Duration,
              s3Fetches: meta.s3Fetches,
              s3Duration: meta.s3Duration,
              streets: data.streets.length,
              addresses: data.addresses.length,
              stale: isStale,
            },
            ...prev,
          ].slice(0, 50)
        );

        if (isStale) return;

        setSearchResults(data.streets);
        setSearchAddresses(data.addresses);
        setSearchMeta(meta);
        setSelectedStreet(null);
        setActiveIndex(-1);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setSearchResults([]);
        setSearchAddresses([]);
        setSearchMeta(null);
      } finally {
        if (requestId === requestIdRef.current) setSearchLoading(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, lane]);

  // Load every address on a street, then group by leading number client-side.
  const handleStreetSelect = useCallback(async (street: SearchResult) => {
    setSelectedStreet(street);
    setStreetAddresses([]);
    setStreetDigit(null);
    setStreetLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/streets/${street.streetId}/addresses`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setStreetAddresses((await res.json()) as StreetAddress[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStreetLoading(false);
    }
  }, []);

  const submit = useCallback(() => {
    if (!trimmed) return;
    if (lane === "pid") {
      navigate({ to: "/address/$gnafId", params: { gnafId: trimmed } });
      return;
    }
    if (lane === "lpid") {
      navigate({ to: "/lotdp/$lotdpId", params: { lotdpId: trimmed } });
      return;
    }
    const item = dropdownItems[activeIndex >= 0 ? activeIndex : 0];
    if (!item) return;
    if (item.type === "address") {
      navigate({ to: "/address/$gnafId", params: { gnafId: item.data.pid } });
    } else {
      handleStreetSelect(item.data);
    }
  }, [trimmed, lane, navigate, dropdownItems, activeIndex, handleStreetSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
        return;
      }
      if (!showResults) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, dropdownItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Escape") {
        setActiveIndex(-1);
        inputRef.current?.blur();
      }
    },
    [showResults, dropdownItems.length, submit]
  );

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    listRef.current.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const digits = useMemo(() => {
    const seen = new Set<string>();
    for (const a of streetAddresses) {
      const d = leadingDigit(a.s);
      if (d) seen.add(d);
    }
    return [...seen].sort();
  }, [streetAddresses]);

  const shownStreetAddresses = useMemo(
    () =>
      streetDigit === null
        ? streetAddresses
        : streetAddresses.filter((a) => leadingDigit(a.s) === streetDigit),
    [streetAddresses, streetDigit]
  );

  const clear = () => {
    setQuery("");
    setSearchResults([]);
    setSearchAddresses([]);
    setSearchMeta(null);
    setSelectedStreet(null);
    setStreetAddresses([]);
    setError(null);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  // ── Street drill-down replaces the landing content ──────────────────────
  if (selectedStreet) {
    return (
      <Container className="py-7">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="blade-plate">
            <div className="blade-face px-5 pt-2.5 pb-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-mint">
                {selectedStreet.locality} {selectedStreet.state} {selectedStreet.postcode} · street id{" "}
                {selectedStreet.streetId}
              </div>
              <div className="text-[26px] font-black uppercase leading-[1.05] tracking-[-0.015em] text-white sm:text-[34px]">
                {selectedStreet.streetName}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-center gap-2">
            <div className="flex h-24 w-24 flex-col items-center justify-center rounded-full border-8 border-signal bg-white shadow-[0_5px_0_#20241f]">
              <div className="text-[20px] font-black leading-none">
                {selectedStreet.addressCount.toLocaleString()}
              </div>
              <div className="text-[9.5px] font-extrabold uppercase tracking-[0.1em] text-ink-mute">
                addresses
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedStreet(null);
                setStreetAddresses([]);
                inputRef.current?.focus();
              }}
              className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-mute hover:text-ink"
            >
              ← Back to results
            </button>
          </div>
        </div>

        {digits.length > 1 && (
          <div className="plate mb-4 flex flex-wrap items-center gap-3 px-4 py-3.5">
            <span className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-ink-mute">
              Narrow by leading number
            </span>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setStreetDigit(null)}
                aria-pressed={streetDigit === null}
                className={`plate-press flex h-8 items-center justify-center rounded-md border-[2.5px] border-ink px-2.5 text-[12px] font-black ${
                  streetDigit === null ? "bg-signal" : "bg-white"
                }`}
              >
                All
              </button>
              {digits.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setStreetDigit(d)}
                  aria-pressed={streetDigit === d}
                  className={`plate-press flex h-8 w-8 items-center justify-center rounded-md border-[2.5px] border-ink text-[14px] font-black ${
                    streetDigit === d ? "bg-signal" : "bg-white"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <span className="ml-auto text-[12.5px] font-semibold text-ink-soft">
              Showing <b>{shownStreetAddresses.length.toLocaleString()}</b>
              {streetDigit && (
                <>
                  {" "}
                  starting with <b>{streetDigit}</b>
                </>
              )}
            </span>
          </div>
        )}

        {streetLoading && <StatePanel kind="loading" heading="Fetching street">{selectedStreet.display}</StatePanel>}

        {!streetLoading && shownStreetAddresses.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shownStreetAddresses.map((addr) => (
              <Link
                key={addr.p}
                to="/address/$gnafId"
                params={{ gnafId: addr.p }}
                className="plate plate-press flex items-center gap-2.5 px-3 py-2.5 text-ink no-underline"
              >
                <span className="text-[13.5px] font-bold uppercase leading-snug">{addr.s}</span>
              </Link>
            ))}
          </div>
        )}

        {!streetLoading && streetAddresses.length === 0 && !error && (
          <StatePanel kind="empty" heading="Blank blade">
            No addresses are recorded on this street.
          </StatePanel>
        )}

        {error && (
          <StatePanel kind="error" heading="Lookup failed" detail={selectedStreet.display}>
            {error}
          </StatePanel>
        )}
      </Container>
    );
  }

  // ── Landing ────────────────────────────────────────────────────────────
  return (
    <>
      <div
        className="relative overflow-hidden"
        style={{
          background: "#fbf9f4",
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(32,36,31,0.05) 0 1px, transparent 1px 46px)",
        }}
      >
        <Container className="pb-10 pt-10 sm:pt-14">
        <div className="mb-8 flex flex-wrap items-start gap-6 lg:gap-10">
          <div className="min-w-0 flex-1">
            <div className="blade-plate inline-block">
              <div className="blade-face px-5 pb-3.5 pt-3 sm:px-7">
                <div className="mb-0.5 text-[13px] font-bold uppercase tracking-[0.22em] text-mint">
                  Australia · all states
                </div>
                <div className="text-[32px] font-black uppercase leading-none tracking-[-0.02em] text-white sm:text-[44px] lg:text-[50px]">
                  Address Lookup
                </div>
              </div>
            </div>
            <h1 className="mt-6 mb-3.5 max-w-[560px] text-[30px] font-extrabold leading-[1.02] tracking-[-0.03em] text-balance sm:text-[40px]">
              Type an address. Get the whole country back in milliseconds.
            </h1>
            <p className="m-0 max-w-[500px] text-[16.5px] leading-[1.55] text-ink-soft">
              Every G-NAF address, sharded into R2, indexed in D1, served from the edge by a single
              Cloudflare Worker. No database to run.
            </p>
          </div>

          <div className="hidden w-[150px] shrink-0 pt-1.5 text-center md:block">
            <div className="mx-auto flex h-32 w-32 rotate-45 items-center justify-center rounded-xl border-4 border-ink bg-signal">
              <div className="-rotate-45 text-center leading-[1.05]">
                <div className="text-[26px] font-black tracking-[-0.02em]">15.9M</div>
                <div className="text-[10.5px] font-bold uppercase tracking-[0.12em]">addresses</div>
              </div>
            </div>
            <div className="mt-11 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-mute">
              Updated quarterly
            </div>
          </div>
        </div>

        {/* One box for all three identifiers. */}
        <div className="max-w-[620px]">
          <div className="flex items-stretch overflow-hidden rounded-xl border-[3px] border-ink bg-white shadow-[0_6px_0_#20241f] focus-within:shadow-[0_3px_0_#20241f]">
            <div className="flex w-14 shrink-0 items-center justify-center border-r-[3px] border-ink bg-signal">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#20241f" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m21 21-4.34-4.34" />
                <circle cx="11" cy="11" r="8" />
              </svg>
            </div>
            <input
              ref={inputRef}
              type="text"
              aria-label="Search by address, GNAF PID or legal parcel ID"
              placeholder="1 Macquarie St Sydney"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="min-w-0 flex-1 bg-transparent px-4 py-4 text-[18px] font-bold tracking-[-0.01em] outline-none placeholder:font-semibold placeholder:text-[#a8a79f] sm:text-[20px]"
            />
            {trimmed && (
              <div className="hidden items-center whitespace-nowrap border-l-[3px] border-ink bg-cream px-3.5 text-[10.5px] font-extrabold uppercase tracking-[0.1em] text-blade sm:flex">
                {LANE_LABEL[lane]} ✓
              </div>
            )}
            <button
              type="button"
              onClick={submit}
              className="plate-press flex items-center bg-blade px-4 text-[12px] font-extrabold uppercase tracking-[0.12em] text-white sm:px-5"
            >
              Go
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[10.5px] font-extrabold uppercase tracking-[0.14em] text-ink-mute">
              Try
            </span>
            {(
              [
                ["Address", "11/1 Hay St, Perth WA"],
                ["GNAF PID", "GAWA_148312575"],
                ["LPID", "D073064/50"],
              ] as const
            ).map(([kind, example]) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setQuery(example);
                  inputRef.current?.focus();
                }}
                className="inline-flex items-stretch overflow-hidden rounded-[7px] border-2 border-ink bg-white"
              >
                <span className="flex items-center bg-signal px-1.5 py-1 text-[9.5px] font-extrabold uppercase tracking-[0.08em]">
                  {kind}
                </span>
                <span className="px-2 py-1 text-[12.5px] font-bold">{example}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 mb-0 text-[12.5px] font-semibold text-ink-mute">
            One box — it works out which of the three you gave it.
          </p>

          {error && (
            <div className="mt-4 rounded-lg border-[2.5px] border-alarm bg-white px-4 py-3 text-[13px] font-semibold text-alarm">
              {error}
            </div>
          )}

          {showResults && (
            <div ref={listRef} className="mt-4 flex flex-col gap-2.5">
              {searchAddresses.map((addr, i) => (
                <Link
                  key={addr.pid}
                  to="/address/$gnafId"
                  params={{ gnafId: addr.pid }}
                  data-index={i}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{ animation: "bladeDrop 0.35s ease-out both", animationDelay: `${i * 0.04}s` }}
                  className={`blade-plate block no-underline ${i === activeIndex ? "ring-[3px] ring-signal" : ""}`}
                >
                  <div className="blade-face flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
                    <span className="text-[15px] font-extrabold uppercase text-white sm:text-[17px]">
                      <HighlightMatch text={addr.sla} highlight={addr.highlight} />
                    </span>
                    <span className="font-mono text-[10.5px] text-mint">{addr.pid}</span>
                  </div>
                </Link>
              ))}

              {searchResults.map((result, i) => {
                const idx = searchAddresses.length + i;
                return (
                  <button
                    key={result.streetId}
                    type="button"
                    data-index={idx}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => handleStreetSelect(result)}
                    style={{ animation: "bladeDrop 0.35s ease-out both", animationDelay: `${idx * 0.04}s` }}
                    className={`plate plate-press flex w-full flex-wrap items-center gap-2.5 px-3.5 py-2.5 text-left ${
                      idx === activeIndex ? "ring-[3px] ring-signal" : ""
                    }`}
                  >
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-ink bg-signal text-[11px] font-black">
                      ST
                    </span>
                    <span className="text-[14px] font-bold uppercase sm:text-[16px]">
                      <HighlightMatch text={result.display} highlight={result.highlight} />
                    </span>
                    <span className="ml-auto text-[12.5px] font-bold text-ink-mute">
                      {result.addressCount.toLocaleString()} addresses →
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {searchMeta && showResults && (
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <Pill tone="ink">
                D1 {searchMeta.d1Duration.toFixed(0)}ms · {searchMeta.d1RowsRead.toLocaleString()} rows
              </Pill>
              <Pill>
                R2 {searchMeta.s3Duration.toFixed(0)}ms · {searchMeta.s3Fetches} fetches
              </Pill>
              {query && (
                <button type="button" onClick={clear} className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-mute hover:text-ink">
                  Clear
                </button>
              )}
            </div>
          )}

          {lane === "address" && trimmed.length > 0 && !hasResults && !searchLoading && !error && (
            <p className="mt-4 mb-0 text-[13px] font-semibold text-ink-mute">
              Nothing matches “{trimmed}” yet — keep typing, or try a street name and suburb.
            </p>
          )}

          {lane !== "address" && trimmed.length > 0 && (
            <p className="mt-4 mb-0 text-[13px] font-semibold text-ink-mute">
              Press Go to look up this {lane === "pid" ? "GNAF PID" : "parcel reference"}.
            </p>
          )}
        </div>
        </Container>
      </div>

      {/* What happens between the keystroke and the answer. */}
      <section className="bg-ink text-cream">
        <Container className="py-10">
        <h2 className="m-0 mb-6 text-[24px] font-black uppercase tracking-[-0.02em] sm:text-[30px]">
          The route your query takes
        </h2>
        <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-3">
          {[
            ["Keystroke", "Debounced in the browser, then one request to the Worker."],
            ["D1 · FTS5", "The street index matches the name, expanding synonyms as it goes."],
            ["R2 shard", "One gzip shard is fetched and scored. One read, not a table scan."],
          ].map(([step, copy], i) => (
            <li key={step} className="rounded-lg border-2 border-slate-line p-4">
              <div className="mb-2 flex items-center gap-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-signal text-[12px] font-black text-ink">
                  {i + 1}
                </span>
                <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-signal">
                  {step}
                </span>
              </div>
              <p className="m-0 text-[13.5px] leading-[1.55] text-[#d9d5c8]">{copy}</p>
            </li>
          ))}
        </ol>
        </Container>
      </section>

      <section>
        <Container className="py-10">
        <h2 className="m-0 mb-2.5 text-[24px] font-black uppercase tracking-[-0.02em] sm:text-[30px]">
          Deploy your own
        </h2>
        <p className="m-0 mb-5 max-w-[600px] text-[14.5px] leading-[1.55] text-ink-soft">
          Every quarterly release ships pre-sharded, so you never have to run the pipeline. The deploy
          workflow uploads shards to R2, creates a D1 database with read replication and updates{" "}
          <span className="font-mono font-semibold">wrangler.json</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4 rounded-xl bg-blade px-5 py-4 shadow-[0_6px_0_rgba(11,60,44,0.4)]">
          <span className="text-[15.5px] font-extrabold text-white">
            Full deploy instructions live in the README
          </span>
          <a
            href="https://github.com/jxeeno/gnaf-serverless#using-pre-built-data"
            className="plate-press ml-auto inline-flex items-center rounded-lg border-[2.5px] border-ink bg-white px-4 py-2.5 text-[13px] font-black uppercase tracking-[0.06em] text-ink no-underline shadow-[0_4px_0_#20241f]"
          >
            Using pre-built data ↗
          </a>
        </div>
        </Container>
      </section>

      {requestLog.length > 0 && (
        <section className="border-t border-hairline">
          <Container className="py-5">
          <button
            type="button"
            onClick={() => setDebugOpen((v) => !v)}
            className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-ink-mute hover:text-ink"
          >
            {debugOpen ? "▾" : "▸"} Request log ({requestLog.length})
          </button>
          {debugOpen && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] font-mono text-[11px]">
                <thead>
                  <tr className="border-b-2 border-ink text-left">
                    {["#", "Query", "Total", "D1", "Rows", "R2", "Reqs", "St", "Ad", ""].map((h) => (
                      <th key={h} className="px-2 py-1.5 font-semibold text-ink-mute">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {requestLog.map((e) => (
                    <tr key={e.id} className={`border-b border-hairline ${e.stale ? "opacity-40" : ""}`}>
                      <td className="px-2 py-1 text-ink-mute">{e.id}</td>
                      <td className="max-w-[140px] truncate px-2 py-1">{e.query}</td>
                      <td className="px-2 py-1 text-right">{e.totalMs.toFixed(0)}ms</td>
                      <td className="px-2 py-1 text-right">{e.d1Duration.toFixed(0)}ms</td>
                      <td className="px-2 py-1 text-right">{e.d1RowsRead.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right">{e.s3Duration.toFixed(0)}ms</td>
                      <td className="px-2 py-1 text-right">{e.s3Fetches}</td>
                      <td className="px-2 py-1 text-right">{e.streets}</td>
                      <td className="px-2 py-1 text-right">{e.addresses}</td>
                      <td className="px-2 py-1 text-center">{e.stale ? "stale" : "ok"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </Container>
        </section>
      )}
    </>
  );
}
