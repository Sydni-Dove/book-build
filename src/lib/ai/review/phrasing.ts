/**
 * Whole-manuscript PHRASING check — deterministic, no LLM. Reuses proseSignals'
 * pattern detectors to surface the tells that read as generic or overwritten
 * (the "not X, but Y" cadence, significance/insistence words, filler, repeated
 * openers). For each hit it resolves the ACTUAL sentence from the manuscript so
 * the writer can read it, jump to the chapter, and ask for a tighter rewrite —
 * exactly like the voice-consistency flags. It never claims text is "AI-written"
 * and never edits anything. Dialogue is excluded — spoken rhythm is intentional.
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
const GROUP_META: Record<GroupKey, { label: string; description: string }> = {
  contrast_cadence: { label: 'The “not X, but Y” cadence', description: 'A recognizable rhythm (“It wasn’t about the words, but the surrender.”) that can read as overwritten when it recurs.' },
  insistence: { label: 'Significance / insistence words', description: 'Words that tell the reader something matters (profound, sacred, palpable, raw…) — often stronger shown than stated.' },
  filler: { label: 'Filler phrases', description: 'Wordy connectors that can usually be trimmed (“in order to”, “began to”, “the sound of”).' },
  repetition: { label: 'Repeated openers & words', description: 'The same sentence-opener or word used several times close together.' },
  emphatic: { label: 'Emphatic fragments', description: 'Runs of very short sentences used for emphasis (“Not now. Not ever.”).' }
};
const GROUP_ORDER: GroupKey[] = ['contrast_cadence', 'insistence', 'filler', 'repetition', 'emphatic'];

export type PhrasingHit = { pattern: string; sentence: string; chapter_number: number | null; chapter_id: string; section_id: string };
export type PhrasingGroup = { key: GroupKey; label: string; description: string; tightenable: boolean; count: number; hits: PhrasingHit[] };
export type PhrasingReport = { status: 'ok' | 'empty'; total: number; groups: PhrasingGroup[]; note: string };

const MAX_HITS_PER_GROUP = 6;

function splitSentences(text: string): string[] {
  return (text ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?…])["'”’)\]]?\s+/).map((s) => s.trim()).filter(Boolean);
}
const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstQuoted = (s: string) => s.match(/["“']([^"”']+)["”']/)?.[1] ?? null;

// Resolve a signal's summary evidence to the actual sentence in the section so
// the writer sees real prose (and it can be tightened), not just a label.
function resolveSentence(sentences: string[], kind: string, evidence: string): string | null {
  const has = (needle: string) => { const n = needle.toLowerCase(); return sentences.find((s) => s.toLowerCase().includes(n)) ?? null; };
  switch (kind) {
    case 'contrastive_negation':
    case 'motive_preemption':
    case 'feeling_clarification':
    case 'emphatic_negation_run':
      return has(evidence.replace(/…$/, '').slice(0, 30)) ?? evidence; // evidence is real prose
    case 'insistence_terms': {
      const term = evidence.split(',')[0]?.trim();
      return term ? has(term) : null;
    }
    case 'filler_phrases': {
      const phrase = evidence.split(';')[0]?.trim();
      return phrase ? has(phrase) : null;
    }
    case 'repeated_term': {
      const term = firstQuoted(evidence);
      return term ? has(term) : null;
    }
    case 'repeated_openers': {
      const word = firstQuoted(evidence);
      return word ? (sentences.find((s) => s.toLowerCase().startsWith(word.toLowerCase())) ?? null) : null;
    }
    case 'fragment_run': {
      const run = sentences.filter((s) => s.trim().split(/\s+/).length <= 3).slice(0, 3);
      return run.length ? run.join(' ') : null;
    }
    default:
      return evidence || null;
  }
}

export function computePhrasing(input: PhrasingSectionInput[], characterNames: string[] = []): PhrasingReport {
  const buckets = new Map<GroupKey, PhrasingHit[]>();
  const counts = new Map<GroupKey, number>();
  const seen = new Map<GroupKey, Set<string>>();
  for (const s of input) {
    if (!s.content || !s.content.trim()) continue;
    const sentences = splitSentences(s.content);
    const report = analyzeSectionProse(s.section_id, s.content, { characterNames });
    for (const p of report.paragraphs) {
      for (const sig of p.signals) {
        if (sig.in_dialogue) continue; // spoken rhythm is intentional
        const g = GROUP_OF[sig.kind];
        if (!g) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
        const sentence = resolveSentence(sentences, sig.kind, sig.evidence);
        if (!sentence) continue;
        const arr = buckets.get(g) ?? [];
        const dedupe = seen.get(g) ?? new Set<string>();
        const key = clip(sentence).toLowerCase();
        if (arr.length < MAX_HITS_PER_GROUP && !dedupe.has(key)) {
          dedupe.add(key);
          arr.push({ pattern: clip(sig.evidence, 80), sentence: clip(sentence), chapter_number: s.chapter_number, chapter_id: s.chapter_id, section_id: s.section_id });
        }
        buckets.set(g, arr); seen.set(g, dedupe);
      }
    }
  }
  const groups: PhrasingGroup[] = GROUP_ORDER
    .filter((g) => (counts.get(g) ?? 0) > 0 && (buckets.get(g)?.length ?? 0) > 0)
    .map((g) => ({ key: g, ...GROUP_META[g], tightenable: true, count: counts.get(g) ?? 0, hits: buckets.get(g) ?? [] }));
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
