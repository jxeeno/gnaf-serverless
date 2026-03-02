import { useState, useCallback, useRef, useEffect } from "react";
import { Search, MapPin, Hash, FileJson, Table, ChevronLeft, ChevronRight, Loader2, Github, Building2 } from "lucide-react";
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

export default function App() {
  const [mode, setMode] = useState<"search" | "gnaf" | "lotdp">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressResponse[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAddresses, setSearchAddresses] = useState<SearchAddressResult[]>([]);
  const [selectedStreet, setSelectedStreet] = useState<SearchResult | null>(null);
  const [streetAddresses, setStreetAddresses] = useState<StreetAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<AddressResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search for autocomplete mode
  useEffect(() => {
    if (mode !== "search") return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchAddresses([]);
      setSelectedStreet(null);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/addresses/search?q=${encodeURIComponent(q)}&limit=10`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const data: { streets: SearchResult[]; addresses: SearchAddressResult[] } = await res.json();
        setSearchResults(data.streets);
        setSearchAddresses(data.addresses);
        setSelectedStreet(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setSearchResults([]);
        setSearchAddresses([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode]);

  // Load all addresses on a street
  const handleStreetSelect = useCallback(async (street: SearchResult) => {
    setSelectedStreet(street);
    setStreetAddresses([]);
    setSelectedAddress(null);
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

  // Load full address detail when an address is selected from the street list
  const handleAddressSelect = useCallback(async (pid: string) => {
    setSelectedAddress(null);
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
    setSelectedStreet(null);
    setStreetAddresses([]);
    setSelectedAddress(null);
    setError(null);
    setPage(0);
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

        <Card className="mb-6">
          <CardContent className="pt-6">
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
                <Input
                  placeholder="Search for an address, e.g. 28 Murray Road Christmas Island"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {searchLoading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
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
                  placeholder={mode === "gnaf" ? "e.g. GAOT_718710337" : "e.g. 41/37U/22"}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="font-mono"
                />
                <Button type="submit" disabled={loading || !query.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {error && (
          <Card className="mb-6 border-destructive/50">
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Search autocomplete results */}
        {mode === "search" && !selectedStreet && !selectedAddress && (searchResults.length > 0 || searchAddresses.length > 0) && (
          <div className="space-y-2 mb-6">
            {searchAddresses.length > 0 && (
              <>
                <p className="text-sm text-muted-foreground">
                  {searchAddresses.length} address{searchAddresses.length !== 1 ? "es" : ""}
                </p>
                {searchAddresses.map((addr) => (
                  <Card
                    key={addr.pid}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => handleAddressSelect(addr.pid)}
                  >
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center gap-2 min-w-0">
                        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium truncate">{addr.sla}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
            {searchResults.length > 0 && (
              <>
                <p className="text-sm text-muted-foreground mt-4">
                  {searchResults.length} street{searchResults.length !== 1 ? "s" : ""}
                </p>
                {searchResults.map((result) => (
                  <Card
                    key={result.streetId}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => handleStreetSelect(result)}
                  >
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm font-medium truncate">{result.display}</span>
                        </div>
                        <Badge variant="secondary" className="text-xs shrink-0">
                          {result.addressCount} address{result.addressCount !== 1 ? "es" : ""}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </div>
        )}

        {/* Address detail from search results (no street selected) */}
        {mode === "search" && !selectedStreet && selectedAddress && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedAddress(null)}
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

        {/* Selected street: show address list or full detail */}
        {mode === "search" && selectedStreet && (
          <div className="space-y-4">
            {selectedAddress ? (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedAddress(null);
                    }}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back to {selectedStreet.display}
                  </Button>
                </div>
                <Card>
                  <CardContent className="pt-6">
                    <AddressDetail address={selectedAddress} />
                  </CardContent>
                </Card>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedStreet(null);
                      setStreetAddresses([]);
                    }}
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
              </>
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

        {!loading && !searchLoading && !error && results.length === 0 && searchResults.length === 0 && searchAddresses.length === 0 && !selectedStreet && !selectedAddress && (
          <div className="text-center py-12 text-muted-foreground">
            <MapPin className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {mode === "search"
                ? "Start typing to search for an Australian street address"
                : "Enter a GNAF PID or Lot/DP reference to look up an address"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
