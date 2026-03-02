import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AddressDetail } from "../components/AddressDetail";
import type { AddressResponse } from "../../shared/types";

export const Route = createFileRoute("/lotdp/$lotdpId")({
  component: LotDpPage,
});

function LotDpPage() {
  const { lotdpId } = Route.useParams();
  const [results, setResults] = useState<AddressResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResults([]);
    setPage(0);

    fetch(`/api/addresses?lotdp=${encodeURIComponent(lotdpId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setResults(Array.isArray(data) ? data : [data]);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lotdpId]);

  const totalPages = results.length;
  const currentResult = results[page];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/">
          <Button variant="ghost" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" /> Search
          </Button>
        </Link>
        <Badge variant="outline" className="font-mono text-xs">
          Lot/DP: {lotdpId}
        </Badge>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
            <p className="text-xs text-muted-foreground mt-2 font-mono">{lotdpId}</p>
          </CardContent>
        </Card>
      )}

      {!loading && results.length > 0 && (
        <>
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {results.length} address{results.length !== 1 ? "es" : ""} found
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm tabular-nums">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Address list sidebar for multi-result */}
          {totalPages > 1 && (
            <div className="rounded-lg border border-border divide-y divide-border">
              {results.map((r, i) => (
                <button
                  key={r.pid}
                  type="button"
                  onClick={() => setPage(i)}
                  className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors cursor-pointer ${
                    i === page
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                >
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm truncate">{r.sla}</span>
                </button>
              ))}
            </div>
          )}

          {currentResult && (
            <Card>
              <CardContent className="pt-6">
                <AddressDetail address={currentResult} />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {!loading && results.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          <MapPin className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No addresses found for this Lot/DP reference</p>
        </div>
      )}
    </div>
  );
}
