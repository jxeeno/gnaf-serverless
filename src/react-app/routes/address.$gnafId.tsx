import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AddressDetail, type DetailTiming } from "../components/AddressDetail";
import { Container, StatePanel } from "../components/blade";
import type { AddressResponse } from "../../shared/types";

export const Route = createFileRoute("/address/$gnafId")({
  component: AddressPage,
});

function AddressPage() {
  const { gnafId } = Route.useParams();
  // The last lookup's outcome, tagged with the PID it was for. Until the
  // lookup for the current PID finishes, the page shows it as loading.
  const [result, setResult] = useState<{
    gnafId: string;
    address?: AddressResponse;
    timing?: DetailTiming;
    error?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const current = result?.gnafId === gnafId ? result : null;
  const loading = current === null;
  const address = current?.address ?? null;
  const timing = current?.timing ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    let cancelled = false;
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
        setResult({ gnafId, address: data, timing: { totalMs: performance.now() - started } });
      })
      .catch((err) => {
        if (!cancelled) setResult({ gnafId, error: err.message });
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
      <div className="border-b border-hairline bg-cream-panel">
        <Container className="flex items-center justify-between gap-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.1em]">
        <Link to="/" className="text-ink no-underline hover:text-blade">
          ← Back to search
        </Link>
        {address && (
          <button type="button" onClick={handleCopy} className="font-bold uppercase text-blade">
            {copied ? "Copied ✓" : "Copy address ⧉"}
          </button>
        )}
        </Container>
      </div>

      <Container className="py-6 sm:py-7">
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
      </Container>
    </>
  );
}
