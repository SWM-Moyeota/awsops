'use client';
import { useEffect, useRef, useState } from 'react';
import type { CreatorLookup } from '@/lib/change-timeline/types';

const BATCH = 200;

// keys: `${accountId}:${resourceId}` optionally followed by `|createdAtISO`.
// Returns lookups keyed by `${accountId}:${resourceId}`. Cached per mount.
export function useCreators(keys: string[]): Record<string, CreatorLookup> {
  const [result, setResult] = useState<Record<string, CreatorLookup>>({});
  const asked = useRef<Set<string>>(new Set());
  const signature = keys.join(',');

  useEffect(() => {
    const todo = Array.from(new Set(keys)).filter((k) => k && !asked.current.has(k));
    if (!todo.length) return;
    todo.forEach((k) => asked.current.add(k));
    let cancelled = false;
    (async () => {
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        try {
          const res = await fetch(`/api/changes/creators?ids=${encodeURIComponent(batch.join(','))}`);
          if (!res.ok) throw new Error('bad');
          const rows: CreatorLookup[] = await res.json();
          if (cancelled) return;
          setResult((prev) => {
            const next = { ...prev };
            for (const r of rows) next[r.key] = r;
            return next;
          });
        } catch {
          batch.forEach((k) => asked.current.delete(k)); // allow retry on next change
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return result;
}
