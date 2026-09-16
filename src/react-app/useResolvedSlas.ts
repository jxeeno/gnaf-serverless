import { useEffect, useRef, useState } from "react";
import type { AddressResponse } from "../shared/types";

/**
 * Shard keys are md5(pid), so linked addresses scatter across shards — the 36
 * units of one building land in 36 different ones. There's no batch lookup, so
 * each PID costs a request; callers should pass a bounded page, not a whole
 * list, and the pool below keeps the browser's connections free for the rest of
 * the page.
 */
const CONCURRENCY = 6;

/**
 * Resolve GNAF PIDs to their single-line addresses, one request each.
 *
 * Results accumulate in a ref that survives re-renders, so growing the list
 * (paging in more rows) only fetches what's new. A PID that fails resolves to
 * an empty string and is not retried.
 */
export function useResolvedSlas(pids: string[]): Record<string, string> {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const cache = useRef<Record<string, string>>({});
  // PIDs already requested, so a re-render mid-flight doesn't ask again.
  const requested = useRef<Set<string>>(new Set());
  // Workers outlive the effect run that started them: paging in a second page
  // must not cancel the first page's in-flight requests. Only unmount stops them.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const key = pids.join(",");

  useEffect(() => {
    const todo = pids.filter((pid) => !requested.current.has(pid));
    if (todo.length === 0) return;
    for (const pid of todo) requested.current.add(pid);

    let next = 0;
    const worker = async (): Promise<void> => {
      while (mounted.current) {
        const index = next++;
        if (index >= todo.length) return;
        const pid = todo[index];
        try {
          const res = await fetch(`/api/addresses/${encodeURIComponent(pid)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: AddressResponse = await res.json();
          cache.current[pid] = data.sla;
        } catch {
          cache.current[pid] = "";
        }
        if (mounted.current) setResolved({ ...cache.current });
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker)
    );
    // `key` stands in for `pids`: same PIDs, same work, regardless of identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return resolved;
}
