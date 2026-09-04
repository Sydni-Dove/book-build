import type { WritingSection } from '@/lib/types/database';

/**
 * Previous sections rendered as continuous prose — no card borders, no
 * per-section chrome. The chapter should read like a chapter, even though
 * it's stored as many small rows (spec: "do not visually fragment the
 * manuscript too aggressively").
 */
export function ChapterReader({ sections }: { sections: WritingSection[] }) {
  if (sections.length === 0) return null;
  return (
    <div className="manuscript-textarea select-text space-y-5 text-ink-soft">
      {sections.map((s) => (
        <div key={s.id} className="whitespace-pre-wrap">
          {s.content || <span className="italic text-ink-faint">(empty section)</span>}
        </div>
      ))}
    </div>
  );
}
