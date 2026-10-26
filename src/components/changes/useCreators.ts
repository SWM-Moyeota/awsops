'use client';
import { useEffect, useRef, useState } from 'react';
import type { CreatorLookup } from '@/lib/change-timeline/types';
import { CLIENT_BATCH, chunk, pendingKeys } from './creator-batch';

// keys: `${accountId}:${resourceId}` optionally followed by `|createdAtISO`.
// Returns lookups keyed by `${accountId}:${resourceId}`. Cached per mount.
export function useCreators(keys: string[]): Record<string, CreatorLookup> {
  const [result, setResult] = useState<Record<string, CreatorLookup>>({});
  const asked = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  const signature = keys.join(',');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const todo = pendingKeys(keys, asked.current);
    if (!todo.length) return;
    todo.forEach((k) => asked.current.add(k));
    // Not tied to effect cleanup: responses are merged into the per-mount cache regardless,
    // so a re-run (signature change / strict mode) can never strand requested keys.
    (async () => {
      for (const batch of chunk(todo, CLIENT_BATCH)) {
        try {
          const res = await fetch(`/api/changes/creators?ids=${encodeURIComponent(batch.join(','))}`);
          if (!res.ok) throw new Error('bad');
          const rows: CreatorLookup[] = await res.json();
          if (!mounted.current) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return result;
}
