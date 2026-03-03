import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PlaceDetail, type PlaceResponse } from "../components/PlaceDetail";

export const Route = createFileRoute("/place/$placeId")({
  component: PlacePage,
});

function PlacePage() {
  const { placeId } = Route.useParams();
  const [place, setPlace] = useState<PlaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlace(null);

    fetch(`/api/places/${encodeURIComponent(placeId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: PlaceResponse) => {
        if (!cancelled) setPlace(data);
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
  }, [placeId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/">
          <Button variant="ghost" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" /> Search
          </Button>
        </Link>
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
            <p className="text-xs text-muted-foreground mt-2 font-mono">{placeId}</p>
          </CardContent>
        </Card>
      )}

      {place && (
        <Card>
          <CardContent className="pt-6">
            <PlaceDetail place={place} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
