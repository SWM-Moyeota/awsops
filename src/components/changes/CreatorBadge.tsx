'use client';
import type { CreatorLookup } from '@/lib/change-timeline/types';
import { creatorDetail, creatorSubject, creatorText } from './creator-text';

const COLORS = ['#3182f6', '#8b5cf6', '#00d68f', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1', '#f97316'];

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return COLORS[h % COLORS.length];
}

export default function CreatorBadge({ lookup }: { lookup?: CreatorLookup }) {
  if (!lookup) return <span style={{ color: '#6b7684' }}>…</span>;
  if (lookup.status !== 'found' || !lookup.actor) {
    return <span style={{ color: '#6b7684', fontSize: 13 }}>{creatorText(lookup)}</span>;
  }
  const name = lookup.actor.name;
  const subject = creatorSubject(lookup).slice(name.length);
  const detail = creatorDetail(lookup);
  return (
    <span className="inline-flex items-center gap-2" style={{ fontFamily: 'Pretendard, sans-serif' }}>
      <span
        style={{ width: 24, height: 24, borderRadius: '50%', background: colorFor(name), color: '#fff', fontSize: 12, fontWeight: 700 }}
        className="inline-grid place-items-center flex-none"
      >
        {Array.from(name)[0]?.toUpperCase() ?? '?'}
      </span>
      <span style={{ color: '#b0b8c1', fontSize: 13 }}>
        <b style={{ color: '#f2f4f6' }}>{name}</b>{subject} 만들었어요{detail ? ` · ${detail}` : ''}
      </span>
    </span>
  );
}
