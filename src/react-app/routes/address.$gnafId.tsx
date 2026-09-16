import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AddressDetail, type DetailTiming } from "../components/AddressDetail";
import { StatePanel } from "../components/blade";
import type { AddressResponse } from "../../shared/types";

export const Route = createFileRoute("/address/$gnafId")({
  component: AddressPage,
});

function AddressPage() {
  const { gnafId } = Route.useParams();
  const [address, setAddress] = useState<AddressResponse | null>(null);
  const [timing, setTiming] = useState<DetailTiming | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAddress(null);
    setTiming(null);
    const started = performance.now();

    fetch(`/api/addresses/${encodeURIComponent(gnafId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: AddressResponse) => {
        if (cancelled) return;
        setAddress(data);
        setTiming({ totalMs: performance.now() - started });
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
    if (!address) return;
    navigator.clipboard.writeText(address.sla);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-hairline bg-cream-panel px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.1em] sm:px-6">
        <Link to="/" className="text-ink no-underline hover:text-blade">
          ← Back to search
        </Link>
        {address && (
          <button type="button" onClick={handleCopy} className="font-bold uppercase text-blade">
            {copied ? "Copied ✓" : "Copy address ⧉"}
          </button>
        )}
      </div>

      <div className="px-4 py-6 sm:px-6 sm:py-7">
        {loading && (
          <StatePanel kind="loading" heading="Fetching shard" detail={gnafId}>
            Reading one of 4,096 R2 shards.
          </StatePanel>
        )}

        {error && (
          <StatePanel kind="error" heading="No such address" detail={gnafId}>
            {error} — check the PID, or search for the address instead.
          </StatePanel>
        )}

        {address && <AddressDetail address={address} timing={timing ?? undefined} />}
      </div>
    </>
  );
}
