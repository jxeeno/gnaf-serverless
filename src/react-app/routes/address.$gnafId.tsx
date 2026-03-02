import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, Loader2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AddressDetail } from "../components/AddressDetail";
import type { AddressResponse } from "../../shared/types";

export const Route = createFileRoute("/address/$gnafId")({
  component: AddressPage,
});

function AddressPage() {
  const { gnafId } = Route.useParams();
  const [address, setAddress] = useState<AddressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAddress(null);

    fetch(`/api/addresses/${encodeURIComponent(gnafId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: AddressResponse) => {
        if (!cancelled) setAddress(data);
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
  }, [gnafId]);

  const handleCopy = () => {
    if (address) {
      navigator.clipboard.writeText(address.sla);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/">
          <Button variant="ghost" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" /> Search
          </Button>
        </Link>
        {address && (
          <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5 text-muted-foreground">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy address"}
          </Button>
        )}
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
            <p className="text-xs text-muted-foreground mt-2 font-mono">{gnafId}</p>
          </CardContent>
        </Card>
      )}

      {address && (
        <Card>
          <CardContent className="pt-6">
            <AddressDetail address={address} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
