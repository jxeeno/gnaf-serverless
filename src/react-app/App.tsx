import React, { useState, useCallback, useRef, useEffect } from "react";
import { Search, MapPin, Hash, FileJson, Table, ChevronLeft, ChevronRight, Loader2, Github, Building2, X, ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AddressResponse } from "../shared/types";
import { AddressMap } from "./AddressMap";

interface SearchResult {
  streetId: number;
  display: string;
  streetName: string;
  locality: string;
  state: string;
  postcode: string;
  addressCount: number;
}

interface SearchAddressResult {
  pid: string;
  sla: string;
  streetId: number;
}

interface StreetAddress {
  /** GNAF PID */
  p: string;
  /** Single line address */
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

function AddressDetail({ address }: { address: AddressResponse }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="font-mono text-xs">{address.pid}</Badge>
          {address.precedence && (
            <Badge variant={address.precedence === "primary" ? "default" : "outline"}>
              {address.precedence}
            </Badge>
          )}
          {address.lpid && (
            <Badge variant="outline" className="font-mono text-xs">Lot/DP: {address.lpid}</Badge>
          )}
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{address.sla}</h2>
        {address.ssla && (
          <p className="text-sm text-muted-foreground">{address.ssla}</p>
        )}
      </div>

      <Tabs defaultValue="details" className="w-full">
        <TabsList className="w-full grid grid-cols-3">
          <TabsTrigger value="details" className="gap-1.5"><Table className="h-3.5 w-3.5" /> Details</TabsTrigger>
          <TabsTrigger value="map" className="gap-1.5"><MapPin className="h-3.5 w-3.5" /> Map</TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5"><FileJson className="h-3.5 w-3.5" /> JSON</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Address</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {address.mla.map((line, i) => (
                  <p key={i} className="text-sm font-medium">{line}</p>
                ))}
                {address.smla && (
                  <div className="pt-2 mt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-1">Short form</p>
                    {address.smla.map((line, i) => (
                      <p key={i} className="text-sm">{line}</p>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Location</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {address.geocoding.geocodes.map((g, i) => (
                  <div key={i} className="grid grid-cols-[80px_1fr] gap-1">
                    <span className="text-muted-foreground">Latitude</span>
                    <span className="font-mono">{g.latitude}</span>
                    <span className="text-muted-foreground">Longitude</span>
                    <span className="font-mono">{g.longitude}</span>
                    <span className="text-muted-foreground">Type</span>
                    <span>{g.type.name}</span>
                  </div>
                ))}
                <div className="grid grid-cols-[80px_1fr] gap-1 pt-1 border-t">
                  <span className="text-muted-foreground">Level</span>
                  <span>{address.geocoding.level.name}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Street</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                  {address.structured.number && (
                    <>
                      <span className="text-muted-foreground">Number</span>
                      <span>
                        {[address.structured.number.prefix, address.structured.number.number, address.structured.number.suffix].filter(Boolean).join("")}
                        {address.structured.number.last && (
                          <span> - {[address.structured.number.last.prefix, address.structured.number.last.number, address.structured.number.last.suffix].filter(Boolean).join("")}</span>
                        )}
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground">Name</span>
                  <span>{address.structured.street.name}</span>
                  {address.structured.street.type && (
                    <>
                      <span className="text-muted-foreground">Type</span>
                      <span>{address.structured.street.type.code} ({address.structured.street.type.name})</span>
                    </>
                  )}
                  {address.structured.street.suffix && (
                    <>
                      <span className="text-muted-foreground">Suffix</span>
                      <span>{address.structured.street.suffix.name} ({address.structured.street.suffix.code})</span>
                    </>
                  )}
                  {address.structured.street.class && (
                    <>
                      <span className="text-muted-foreground">Class</span>
                      <span>{address.structured.street.class.name}</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Locality & State</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Locality</span>
                  <span>{address.structured.locality.name}</span>
                  {address.structured.locality.class && (
                    <>
                      <span className="text-muted-foreground">Class</span>
                      <span>{address.structured.locality.class.name}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Postcode</span>
                  <span>{address.structured.postcode ?? "\u2014"}</span>
                  <span className="text-muted-foreground">State</span>
                  <span>{address.structured.state.name} ({address.structured.state.abbreviation})</span>
                  <span className="text-muted-foreground">Confidence</span>
                  <span>{address.structured.confidence}</span>
                </div>
              </CardContent>
            </Card>

            {(address.structured.flat || address.structured.level || address.structured.buildingName || address.structured.lotNumber) && (
              <Card className="sm:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Additional Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                    {address.structured.buildingName && (
                      <>
                        <span className="text-muted-foreground">Building</span>
                        <span>{address.structured.buildingName}</span>
                      </>
                    )}
                    {address.structured.flat && (
                      <>
                        <span className="text-muted-foreground">Flat/Unit</span>
                        <span>
                          {address.structured.flat.type.name}{" "}
                          {[address.structured.flat.prefix, address.structured.flat.number, address.structured.flat.suffix].filter(v => v != null).join("")}
                        </span>
                      </>
                    )}
                    {address.structured.level && (
                      <>
                        <span className="text-muted-foreground">Level</span>
                        <span>
                          {address.structured.level.type.name}{" "}
                          {[address.structured.level.prefix, address.structured.level.number, address.structured.level.suffix].filter(v => v != null).join("")}
                        </span>
                      </>
                    )}
                    {address.structured.lotNumber && (
                      <>
                        <span className="text-muted-foreground">Lot</span>
                        <span>
                          {[address.structured.lotNumber.prefix, address.structured.lotNumber.number, address.structured.lotNumber.suffix].filter(Boolean).join("")}
                        </span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="map" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-hidden rounded-lg">
              <AddressMap
                latitude={address.geocoding.geocodes[0]?.latitude}
                longitude={address.geocoding.geocodes[0]?.longitude}
                label={address.sla}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <pre className="text-xs font-mono bg-muted p-4 rounded-lg overflow-auto max-h-[600px] whitespace-pre-wrap break-all">
                {JSON.stringify(address, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Highlight matching portions of text */
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const tokens = query.toUpperCase().split(/[\s,/]+/).filter(Boolean);
  const upperText = text.toUpperCase();

  // Find all match ranges
  const ranges: [number, number][] = [];
  for (const token of tokens) {
    let idx = 0;
    while ((idx = upperText.indexOf(token, idx)) !== -1) {
      ranges.push([idx, idx + token.length]);
      idx += token.length;
    }
  }

  if (ranges.length === 0) return <>{text}</>;

  // Merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  const parts: React.ReactElement[] = [];
  let prev = 0;
  for (const [start, end] of merged) {
    if (prev < start) {
      parts.push(<span key={prev}>{text.slice(prev, start)}</span>);
    }
    parts.push(<mark key={start} className="bg-primary/15 text-foreground rounded-sm px-0.5">{text.slice(start, end)}</mark>);
    prev = end;
  }
  if (prev < text.length) {
    parts.push(<span key={prev}>{text.slice(prev)}</span>);
  }

  return <>{parts}</>;
}

export default function App() {
  const [mode, setMode] = useState<"search" | "gnaf" | "lotdp">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressResponse[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAddresses, setSearchAddresses] = useState<SearchAddressResult[]>([]);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [selectedStreet, setSelectedStreet] = useState<SearchResult | null>(null);
  const [streetAddresses, setStreetAddresses] = useState<StreetAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<AddressResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
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
  const dropdownItems: Array<{ type: "address"; data: SearchAddressResult } | { type: "street"; data: SearchResult }> = [];
  for (const addr of searchAddresses) {
    dropdownItems.push({ type: "address", data: addr });
  }
  for (const street of searchResults) {
    dropdownItems.push({ type: "street", data: street });
  }

  const hasDropdownContent = dropdownItems.length > 0;
  const showDropdown = mode === "search" && dropdownOpen && hasDropdownContent && !selectedStreet && !selectedAddress;

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
      // Abort any in-flight request
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

        const data: { streets: SearchResult[]; addresses: SearchAddressResult[] } = await res.json();

        const meta: SearchMeta = {
          d1RowsRead: parseInt(res.headers.get("X-D1-Rows-Read") ?? "0", 10),
          d1Duration: parseFloat(res.headers.get("X-D1-Duration-Ms") ?? "0"),
          s3Fetches: parseInt(res.headers.get("X-R2-Fetches") ?? "0", 10),
          s3Duration: parseFloat(res.headers.get("X-R2-Duration-Ms") ?? "0"),
        };

        // Log the request regardless of staleness
        setRequestLog((prev) => [
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
        ].slice(0, 50));

        // Stale check: if a newer request has been issued, discard this result
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
        setActiveIndex((prev) => Math.min(prev + 1, dropdownItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        const item = dropdownItems[activeIndex];
        if (item.type === "address") {
          handleAddressSelect((item.data as SearchAddressResult).pid);
        } else {
          handleStreetSelect(item.data as SearchResult);
        }
      } else if (e.key === "Escape") {
        setDropdownOpen(false);
      }
    },
    [showDropdown, activeIndex, dropdownItems]
  );

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Load all addresses on a street
  const handleStreetSelect = useCallback(async (street: SearchResult) => {
    setSelectedStreet(street);
    setStreetAddresses([]);
    setSelectedAddress(null);
    setDropdownOpen(false);
    setLoading(true);
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
      setLoading(false);
    }
  }, []);

  // Load full address detail
  const handleAddressSelect = useCallback(async (pid: string) => {
    setSelectedAddress(null);
    setDropdownOpen(false);
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/addresses/${encodeURIComponent(pid)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data: AddressResponse = await res.json();
      setSelectedAddress(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Direct lookup (GNAF PID / Lot/DP modes)
  const handleDirectSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setResults([]);
    setPage(0);

    try {
      const url = mode === "gnaf"
        ? `/api/addresses/${encodeURIComponent(q)}`
        : `/api/addresses?lotdp=${encodeURIComponent(q)}`;

      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      setResults(Array.isArray(data) ? data : [data]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [query, mode]);

  const handleModeChange = (newMode: "search" | "gnaf" | "lotdp") => {
    setMode(newMode);
    setQuery("");
    setResults([]);
    setSearchResults([]);
    setSearchAddresses([]);
    setSearchMeta(null);
    setSelectedStreet(null);
    setStreetAddresses([]);
    setSelectedAddress(null);
    setError(null);
    setPage(0);
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
    setSelectedAddress(null);
    setError(null);
    setDropdownOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handleBackToResults = () => {
    setSelectedAddress(null);
    setSelectedStreet(null);
    setStreetAddresses([]);
    setDropdownOpen(true);
    inputRef.current?.focus();
  };

  const totalPages = results.length;
  const currentResult = results[page];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <MapPin className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">GNAF Lookup</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Australian address lookup powered by the Geocoded National Address File
          </p>
          <a
            href="https://github.com/jxeeno/gnaf-serverless"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Github className="h-3.5 w-3.5" />
            View on GitHub
          </a>
        </div>

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
              variant={mode === "lotdp" ? "default" : "outline"}
              size="sm"
              onClick={() => handleModeChange("lotdp")}
              className="gap-1.5"
            >
              <MapPin className="h-3.5 w-3.5" />
              Lot/DP
            </Button>
          </div>

          {mode === "search" ? (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search for an address, e.g. 113 Canberra Avenue Griffith"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (selectedAddress || selectedStreet) {
                    setSelectedAddress(null);
                    setSelectedStreet(null);
                    setStreetAddresses([]);
                  }
                }}
                onFocus={() => { if (hasDropdownContent) setDropdownOpen(true); }}
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
                      <button
                        key={addr.pid}
                        type="button"
                        data-index={idx}
                        className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors cursor-pointer ${
                          idx === activeIndex
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent/50"
                        }`}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => handleAddressSelect(addr.pid)}
                      >
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">
                          <HighlightMatch text={addr.sla} query={query} />
                        </span>
                      </button>
                    );
                  })}

                  {searchResults.length > 0 && (
                    <div className={`px-3 py-2 ${searchAddresses.length > 0 ? "border-t border-border" : ""}`}>
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
                            <HighlightMatch text={result.display} query={query} />
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
                      <span>D1: {searchMeta.d1Duration.toFixed(0)}ms / {searchMeta.d1RowsRead.toLocaleString()} rows</span>
                      <span>R2: {searchMeta.s3Duration.toFixed(0)}ms / {searchMeta.s3Fetches} fetches</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                handleDirectSearch();
              }}
            >
              <Input
                placeholder={mode === "gnaf" ? "e.g. GAACT717940975" : "e.g. CANB/GRIF/25/14"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="font-mono"
              />
              <Button type="submit" disabled={loading || !query.trim()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </form>
          )}
        </div>

        {error && (
          <Card className="mb-6 border-destructive/50">
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Address detail from search (direct click or via street) */}
        {mode === "search" && selectedAddress && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBackToResults}
              >
                <ChevronLeft className="h-4 w-4 mr-1" /> Back to results
              </Button>
            </div>
            <Card>
              <CardContent className="pt-6">
                <AddressDetail address={selectedAddress} />
              </CardContent>
            </Card>
          </div>
        )}

        {/* Selected street: show address list */}
        {mode === "search" && selectedStreet && !selectedAddress && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBackToResults}
              >
                <ChevronLeft className="h-4 w-4 mr-1" /> Back to results
              </Button>
            </div>
            <Card className="mb-4">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{selectedStreet.display}</span>
                  <Badge variant="secondary" className="text-xs">
                    {streetAddresses.length} address{streetAddresses.length !== 1 ? "es" : ""}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && streetAddresses.length > 0 && (
              <div className="space-y-1">
                {streetAddresses.map((addr) => (
                  <Card
                    key={addr.p}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => handleAddressSelect(addr.p)}
                  >
                    <CardContent className="py-2.5 px-4">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm">{addr.s}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Direct lookup results (GNAF PID / Lot/DP) */}
        {mode !== "search" && results.length > 0 && (
          <div className="space-y-4">
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {results.length} address{results.length !== 1 ? "es" : ""} found
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm tabular-nums">{page + 1} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {currentResult && (
              <Card key={currentResult.pid}>
                <CardContent className="pt-6">
                  <AddressDetail address={currentResult} />
                </CardContent>
              </Card>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </div>
        )}

        {!loading && !searchLoading && !error && results.length === 0 && !hasDropdownContent && !selectedStreet && !selectedAddress && (
          <div className="text-center py-12 text-muted-foreground">
            <MapPin className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {mode === "search"
                ? "Start typing to search for an Australian street address"
                : "Enter a GNAF PID or Lot/DP reference to look up an address"}
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
              <ChevronDown className={`h-3 w-3 transition-transform ${debugOpen ? "" : "-rotate-90"}`} />
              Debug: {requestLog.length} request{requestLog.length !== 1 ? "s" : ""} logged
            </button>
            {debugOpen && (
              <div className="mt-3 overflow-auto rounded-lg border border-border">
                <table className="w-full text-[11px] font-mono">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">#</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Query</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Total</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">D1</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">D1 Rows</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">R2</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">R2 Req</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Streets</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Addrs</th>
                      <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requestLog.map((entry) => (
                      <tr
                        key={entry.id}
                        className={`border-b border-border last:border-0 ${entry.stale ? "opacity-40" : ""}`}
                      >
                        <td className="px-2 py-1 text-muted-foreground">{entry.id}</td>
                        <td className="px-2 py-1 max-w-[140px] truncate">{entry.query}</td>
                        <td className="px-2 py-1 text-right">{entry.totalMs.toFixed(0)}ms</td>
                        <td className="px-2 py-1 text-right">{entry.d1Duration.toFixed(0)}ms</td>
                        <td className="px-2 py-1 text-right">{entry.d1RowsRead.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right">{entry.s3Duration.toFixed(0)}ms</td>
                        <td className="px-2 py-1 text-right">{entry.s3Fetches}</td>
                        <td className="px-2 py-1 text-right">{entry.streets}</td>
                        <td className="px-2 py-1 text-right">{entry.addresses}</td>
                        <td className="px-2 py-1 text-center">
                          {entry.stale ? (
                            <span className="text-amber-500" title="Stale — superseded by newer request">stale</span>
                          ) : (
                            <span className="text-green-600" title="Rendered">ok</span>
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
      </div>
    </div>
  );
}
