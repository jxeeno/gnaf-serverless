import React, { useState, useCallback, useRef, useEffect } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Search, MapPin, Hash, ChevronDown, Loader2, Building2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

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

/** Render text with server-provided highlight ranges */
function HighlightMatch({ text, highlight }: { text: string; highlight?: [number, number][] }) {
  if (!highlight || highlight.length === 0) return <>{text}</>;

  const parts: React.ReactElement[] = [];
  let prev = 0;
  for (const [start, end] of highlight) {
    if (prev < start) {
      parts.push(<span key={prev}>{text.slice(prev, start)}</span>);
    }
    parts.push(
      <mark key={start} className="bg-primary/15 text-foreground rounded-sm px-0.5">
        {text.slice(start, end)}
      </mark>
    );
    prev = end;
  }
  if (prev < text.length) {
    parts.push(<span key={prev}>{text.slice(prev)}</span>);
  }

  return <>{parts}</>;
}

function IndexPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"search" | "gnaf" | "lpid">("search");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAddresses, setSearchAddresses] = useState<SearchAddressResult[]>([]);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [selectedStreet, setSelectedStreet] = useState<SearchResult | null>(null);
  const [streetAddresses, setStreetAddresses] = useState<StreetAddress[]>([]);
  const [streetLoading, setStreetLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [requestLog, setRequestLog] = useState<RequestLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Build flat list of dropdown items for keyboard navigation
  const dropdownItems: Array<
    | { type: "address"; data: SearchAddressResult }
    | { type: "street"; data: SearchResult }
  > = [];
  for (const addr of searchAddresses) {
    dropdownItems.push({ type: "address", data: addr });
  }
  for (const street of searchResults) {
    dropdownItems.push({ type: "street", data: street });
  }

  const hasDropdownContent = dropdownItems.length > 0;
  const showDropdown =
    mode === "search" && dropdownOpen && hasDropdownContent && !selectedStreet;

  // Debounced search with AbortController for stale request cancellation
  useEffect(() => {
    if (mode !== "search") return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (q.length < 2) {
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
        const res = await fetch(
          `/api/addresses/search?q=${encodeURIComponent(q)}&limit=10`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }

        const totalMs = performance.now() - fetchStart;
        const isStale = requestId !== requestIdRef.current;

        const data: {
          streets: SearchResult[];
          addresses: SearchAddressResult[];
        } = await res.json();

        const meta: SearchMeta = {
          d1RowsRead: parseInt(
            res.headers.get("X-D1-Rows-Read") ?? "0",
            10
          ),
          d1Duration: parseFloat(
            res.headers.get("X-D1-Duration-Ms") ?? "0"
          ),
          s3Fetches: parseInt(res.headers.get("X-R2-Fetches") ?? "0", 10),
          s3Duration: parseFloat(
            res.headers.get("X-R2-Duration-Ms") ?? "0"
          ),
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
        setDropdownOpen(true);
        setActiveIndex(-1);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setSearchResults([]);
        setSearchAddresses([]);
        setSearchMeta(null);
      } finally {
        if (requestId === requestIdRef.current) {
          setSearchLoading(false);
        }
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Keyboard navigation for dropdown
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) =>
          Math.min(prev + 1, dropdownItems.length - 1)
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        const item = dropdownItems[activeIndex];
        if (item.type === "address") {
          navigate({
            to: "/address/$gnafId",
            params: { gnafId: (item.data as SearchAddressResult).pid },
          });
        } else {
          handleStreetSelect(item.data as SearchResult);
        }
      } else if (e.key === "Escape") {
        setDropdownOpen(false);
      }
    },
    [showDropdown, activeIndex, dropdownItems, navigate]
  );

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(
      `[data-index="${activeIndex}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Load all addresses on a street
  const handleStreetSelect = useCallback(async (street: SearchResult) => {
    setSelectedStreet(street);
    setStreetAddresses([]);
    setDropdownOpen(false);
    setStreetLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/streets/${street.streetId}/addresses`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data: StreetAddress[] = await res.json();
      setStreetAddresses(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStreetLoading(false);
    }
  }, []);

  const handleModeChange = (newMode: "search" | "gnaf" | "lpid") => {
    setMode(newMode);
    setQuery("");
    setSearchResults([]);
    setSearchAddresses([]);
    setSearchMeta(null);
    setSelectedStreet(null);
    setStreetAddresses([]);
    setError(null);
    setDropdownOpen(false);
    setActiveIndex(-1);
  };

  const handleClear = () => {
    setQuery("");
    setSearchResults([]);
    setSearchAddresses([]);
    setSearchMeta(null);
    setSelectedStreet(null);
    setStreetAddresses([]);
    setError(null);
    setDropdownOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  // Direct lookup submissions navigate to their routes
  const [directQuery, setDirectQuery] = useState("");
  const handleDirectSearch = () => {
    const q = directQuery.trim();
    if (!q) return;
    if (mode === "gnaf") {
      navigate({ to: "/address/$gnafId", params: { gnafId: q } });
    } else if (mode === "lpid") {
      navigate({ to: "/lotdp/$lotdpId", params: { lotdpId: q } });
    }
  };

  return (
    <>
      <div className="mb-6">
        <div className="flex gap-2 mb-3">
          <Button
            variant={mode === "search" ? "default" : "outline"}
            size="sm"
            onClick={() => handleModeChange("search")}
            className="gap-1.5"
          >
            <Search className="h-3.5 w-3.5" />
            Search
          </Button>
          <Button
            variant={mode === "gnaf" ? "default" : "outline"}
            size="sm"
            onClick={() => handleModeChange("gnaf")}
            className="gap-1.5"
          >
            <Hash className="h-3.5 w-3.5" />
            GNAF PID
          </Button>
          <Button
            variant={mode === "lpid" ? "default" : "outline"}
            size="sm"
            onClick={() => handleModeChange("lpid")}
            className="gap-1.5"
          >
            <MapPin className="h-3.5 w-3.5" />
            LPID
          </Button>
        </div>

        {mode === "search" ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search for an address, e.g. 1 Macquarie St Sydney"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (selectedStreet) {
                  setSelectedStreet(null);
                  setStreetAddresses([]);
                }
              }}
              onFocus={() => {
                if (hasDropdownContent && !selectedStreet) setDropdownOpen(true);
              }}
              onKeyDown={handleSearchKeyDown}
              className="h-11 w-full rounded-lg border border-input bg-background pl-10 pr-10 text-base shadow-sm transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
            {searchLoading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
            {!searchLoading && query && (
              <button
                type="button"
                onClick={handleClear}
                className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            {/* Typeahead dropdown */}
            {showDropdown && (
              <div
                ref={dropdownRef}
                className="absolute z-50 left-0 right-0 top-full mt-1 max-h-[420px] overflow-auto rounded-lg border border-border bg-popover shadow-lg"
              >
                {searchAddresses.length > 0 && (
                  <div className="px-3 py-2">
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Addresses
                    </p>
                  </div>
                )}
                {searchAddresses.map((addr, i) => {
                  const idx = i;
                  return (
                    <Link
                      key={addr.pid}
                      to="/address/$gnafId"
                      params={{ gnafId: addr.pid }}
                      data-index={idx}
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors cursor-pointer no-underline ${
                        idx === activeIndex
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">
                        <HighlightMatch text={addr.sla} highlight={addr.highlight} />
                      </span>
                    </Link>
                  );
                })}

                {searchResults.length > 0 && (
                  <div
                    className={`px-3 py-2 ${searchAddresses.length > 0 ? "border-t border-border" : ""}`}
                  >
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Streets
                    </p>
                  </div>
                )}
                {searchResults.map((result, i) => {
                  const idx = searchAddresses.length + i;
                  return (
                    <button
                      key={result.streetId}
                      type="button"
                      data-index={idx}
                      className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        idx === activeIndex
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => handleStreetSelect(result)}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">
                          <HighlightMatch
                            text={result.display}
                            highlight={result.highlight}
                          />
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {result.addressCount}
                      </span>
                    </button>
                  );
                })}

                {/* Performance footer */}
                {searchMeta && (
                  <div className="border-t border-border px-3 py-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span>
                      D1: {searchMeta.d1Duration.toFixed(0)}ms /{" "}
                      {searchMeta.d1RowsRead.toLocaleString()} rows
                    </span>
                    <span>
                      R2: {searchMeta.s3Duration.toFixed(0)}ms /{" "}
                      {searchMeta.s3Fetches} fetches
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                handleDirectSearch();
              }}
            >
              <Input
                placeholder={
                  mode === "gnaf"
                    ? "e.g. GANSW706597865"
                    : "e.g. 21/633510"
                }
                value={directQuery}
                onChange={(e) => setDirectQuery(e.target.value)}
                className="font-mono"
              />
              <Button type="submit" disabled={!directQuery.trim()}>
                <Search className="h-4 w-4" />
              </Button>
            </form>
            {(mode === "gnaf" || mode === "lpid") && (
              <p className="mt-2 text-xs text-muted-foreground">
                Examples:{" "}
                {(mode === "gnaf"
                  ? [
                      "GANSW706597865",
                      "GAVIC412717665",
                      "GAQLD425588765",
                      "GAWA_148312575",
                      "GATAS702241259",
                      "GAACT717940975",
                    ]
                  : [
                      "21/633510",
                      "CP/SP58841",
                      "1\\TP800196",
                      "D073064/50",
                      "114588/1",
                      "CANB/GRIF/25/14",
                    ]
                ).map((ex, i) => (
                  <span key={ex}>
                    {i > 0 && <span className="mx-1">&middot;</span>}
                    <button
                      type="button"
                      className="font-mono hover:text-foreground transition-colors"
                      onClick={() => {
                        setDirectQuery(ex);
                      }}
                    >
                      {ex}
                    </button>
                  </span>
                ))}
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <Card className="mb-6 border-destructive/50">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Street address list */}
      {selectedStreet && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{selectedStreet.display}</h2>
            <button
              type="button"
              onClick={() => {
                setSelectedStreet(null);
                setStreetAddresses([]);
                setDropdownOpen(true);
                inputRef.current?.focus();
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Back to results
            </button>
          </div>

          {streetLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!streetLoading && streetAddresses.length > 0 && (
            <div className="rounded-lg border border-border divide-y divide-border">
              {streetAddresses.map((addr) => (
                <Link
                  key={addr.p}
                  to="/address/$gnafId"
                  params={{ gnafId: addr.p }}
                  className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-accent/50 transition-colors no-underline text-foreground"
                >
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm">{addr.s}</span>
                </Link>
              ))}
            </div>
          )}

          {!streetLoading && streetAddresses.length === 0 && !error && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No addresses found
            </p>
          )}
        </div>
      )}

      {/* Empty state */}
      {!selectedStreet && !hasDropdownContent && !error && !searchLoading && (
        <div className="text-center py-12 text-muted-foreground">
          <MapPin className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {mode === "search"
              ? "Start typing to search for an Australian street address"
              : mode === "gnaf"
                ? "Enter a GNAF PID to look up an address"
                : "Enter a legal parcel ID (LPID) to look up addresses"}
          </p>
        </div>
      )}

      {/* Debug panel */}
      {requestLog.length > 0 && (
        <div className="mt-8 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setDebugOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${debugOpen ? "" : "-rotate-90"}`}
            />
            Debug: {requestLog.length} request
            {requestLog.length !== 1 ? "s" : ""} logged
          </button>
          {debugOpen && (
            <div className="mt-3 overflow-auto rounded-lg border border-border">
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">
                      #
                    </th>
                    <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">
                      Query
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      Total
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      D1
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      D1 Rows
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      R2
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      R2 Req
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      Streets
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">
                      Addrs
                    </th>
                    <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {requestLog.map((entry) => (
                    <tr
                      key={entry.id}
                      className={`border-b border-border last:border-0 ${entry.stale ? "opacity-40" : ""}`}
                    >
                      <td className="px-2 py-1 text-muted-foreground">
                        {entry.id}
                      </td>
                      <td className="px-2 py-1 max-w-[140px] truncate">
                        {entry.query}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {entry.totalMs.toFixed(0)}ms
                      </td>
                      <td className="px-2 py-1 text-right">
                        {entry.d1Duration.toFixed(0)}ms
                      </td>
                      <td className="px-2 py-1 text-right">
                        {entry.d1RowsRead.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {entry.s3Duration.toFixed(0)}ms
                      </td>
                      <td className="px-2 py-1 text-right">
                        {entry.s3Fetches}
                      </td>
                      <td className="px-2 py-1 text-right">{entry.streets}</td>
                      <td className="px-2 py-1 text-right">
                        {entry.addresses}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {entry.stale ? (
                          <span
                            className="text-amber-500"
                            title="Stale — superseded by newer request"
                          >
                            stale
                          </span>
                        ) : (
                          <span className="text-green-600" title="Rendered">
                            ok
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
