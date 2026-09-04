'use client';

import type { DiffLine } from '@/lib/versions/diff';

// Readable Current-vs-New comparison rendered from computeLineDiff. Side-by-side
// on desktop, stacked on mobile. Brand palette: coral-soft = removed, gold-soft
// = added, plain = unchanged (labels make it unambiguous without red/green).
export function SectionVersionDiff({
  diff,
  wordBefore,
  wordAfter,
  summary,
  beforeLabel = 'Current version',
  afterLabel = 'New version'
}: {
  diff: DiffLine[];
  wordBefore: number;
  wordAfter: number;
  summary: { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const current = diff.filter((d) => d.kind !== 'added');
  const incoming = diff.filter((d) => d.kind !== 'removed');
  const delta = wordAfter - wordBefore;

  const Line = ({ d }: { d: DiffLine }) => {
    const base = 'rounded-md px-2.5 py-1.5 text-[15px] leading-7 whitespace-pre-wrap break-words';
    if (d.kind === 'removed') return <p className={`${base} bg-coral-soft text-accent-strong line-through decoration-accent-strong/40`}>{d.text}</p>;
    if (d.kind === 'added') return <p className={`${base} bg-gold-soft text-gold-strong`}>{d.text}</p>;
    return <p className={`${base} text-ink-soft`}>{d.text}</p>;
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
        <span>Current: <b className="text-ink">{wordBefore}</b> words</span>
        <span>New: <b className="text-ink">{wordAfter}</b> words</span>
        <span className={delta === 0 ? '' : delta > 0 ? 'text-gold-strong' : 'text-accent-strong'}>{delta > 0 ? `+${delta}` : delta} words</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-coral-soft" />Removed {summary.paragraphs_removed}</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-gold-soft" />Added {summary.paragraphs_added}</span>
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{beforeLabel}</p>
          <div className="max-h-[46vh] space-y-1 overflow-y-auto rounded-xl border border-line bg-paper p-2">
            {current.length ? current.map((d, i) => <Line key={i} d={d} />) : <p className="p-2 text-sm text-ink-faint">(empty)</p>}
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{afterLabel}</p>
          <div className="max-h-[46vh] space-y-1 overflow-y-auto rounded-xl border border-line bg-paper p-2">
            {incoming.length ? incoming.map((d, i) => <Line key={i} d={d} />) : <p className="p-2 text-sm text-ink-faint">(empty)</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
