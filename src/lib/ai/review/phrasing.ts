/**
 * Whole-manuscript PHRASING check — deterministic, no LLM. Reuses proseSignals'
 * pattern detectors to surface the tells that read as generic or overwritten
 * (the "not X, but Y" cadence, significance/insistence words, filler, repeated
 * openers). It reports the ACTUAL lines and where they are; it never claims text
 * is "AI-written" and never edits anything. Dialogue is excluded — punchy spoken
 * rhythm is usually intentional.
 */
import { analyzeSectionProse } from '@/lib/ai/development/proseSignals';

export type PhrasingSectionInput = { section_id: string; chapter_id: string; chapter_number: number | null; title: string | null; content: string };

type GroupKey = 'contrast_cadence' | 'insistence' | 'filler' | 'repetition' | 'emphatic';
const GROUP_OF: Record<string, GroupKey> = {
  contrastive_negation: 'contrast_cadence',
  motive_preemption: 'contrast_cadence',
  feeling_clarification: 'contrast_cadence',
  insistence_terms: 'insistence',
  filler_phrases: 'filler',
  repeated_openers: 'repetition',
  repeated_term: 'repetition',
  emphatic_negation_run: 'emphatic',
  fragment_run: 'emphatic'
};
const GROUP_META: Record<GroupKey, { label: string; description: string; tightenable: boolean }> = {
  contrast_cadence: { label: 'The “not X, but Y” cadence', description: 'A recognizable rhythm (“It wasn’t about the words, but the surrender.”) that can read as overwritten when it recurs.', tightenable: true },
  insistence: { label: 'Significance / insistence words', description: 'Words that tell the reader something matters (profound, sacred, palpable, raw…) — often stronger shown than stated.', tightenable: false },
  filler: { label: 'Filler phrases', description: 'Wordy connectors that can usually be trimmed (“in order to”, “began to”, “the sound of”).', tightenable: false },
  repetition: { label: 'Repeated openers & words', description: 'The same sentence-opener or word used several times close together.', tightenable: false },
  emphatic: { label: 'Emphatic fragments', description: 'Runs of very short sentences used for emphasis (“Not now. Not ever.”).', tightenable: false }
};
const GROUP_ORDER: GroupKey[] = ['contrast_cadence', 'insistence', 'filler', 'repetition', 'emphatic'];

export type PhrasingHit = { evidence: string; chapter_number: number | null; chapter_id: string; section_id: string };
export type PhrasingGroup = { key: GroupKey; label: string; description: string; tightenable: boolean; count: number; hits: PhrasingHit[] };
export type PhrasingReport = {
  status: 'ok' | 'empty';
  total: number;
  groups: PhrasingGroup[];
  note: string;
};

const MAX_HITS_PER_GROUP = 8;

export function computePhrasing(input: PhrasingSectionInput[], characterNames: string[] = []): PhrasingReport {
  const buckets = new Map<GroupKey, PhrasingHit[]>();
  const counts = new Map<GroupKey, number>();
  for (const s of input) {
    if (!s.content || !s.content.trim()) continue;
    const report = analyzeSectionProse(s.section_id, s.content, { characterNames });
    for (const p of report.paragraphs) {
      for (const sig of p.signals) {
        if (sig.in_dialogue) continue; // spoken rhythm is intentional
        const g = GROUP_OF[sig.kind];
        if (!g) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
        const arr = buckets.get(g) ?? [];
        if (arr.length < MAX_HITS_PER_GROUP) arr.push({ evidence: sig.evidence, chapter_number: s.chapter_number, chapter_id: s.chapter_id, section_id: s.section_id });
        buckets.set(g, arr);
      }
    }
  }
  const groups: PhrasingGroup[] = GROUP_ORDER
    .filter((g) => (counts.get(g) ?? 0) > 0)
    .map((g) => ({ key: g, ...GROUP_META[g], count: counts.get(g) ?? 0, hits: buckets.get(g) ?? [] }));
  const total = groups.reduce((a, g) => a + g.count, 0);
  return {
    status: groups.length ? 'ok' : 'empty',
    total,
    groups,
    note: groups.length
      ? `${total} phrasing pattern${total === 1 ? '' : 's'} to look at — these read as generic or overwritten when frequent. You decide what's intentional.`
      : 'No recurring generic-phrasing patterns stood out.'
  };
}
