/**
 * Whole-manuscript VOICE CONSISTENCY — deterministic, evidence-first, no LLM.
 *
 * Builds a book-wide voice profile from every ACTIVE section, then measures how
 * far each section drifts from it on objective prose metrics (sentence length,
 * -ly adverb rate, dialogue vs narration, short fragments, very long sentences).
 * A section is surfaced only when it is a statistical OUTLIER (|z| past a
 * threshold) AND the raw difference is materially large — so ordinary variation
 * is not flagged. It never says prose is "bad" or "AI-sounding": it reports the
 * measured difference and asks the writer whether the shift is intentional.
 *
 * Reuses proseSignals' per-section stats; no persistence, no manuscript writes.
 */
import { analyzeSectionProse } from '@/lib/ai/development/proseSignals';

export type VoiceSectionInput = { section_id: string; chapter_id: string; chapter_number: number | null; title: string | null; content: string };

export const VOICE_METRICS = ['avg_words_per_sentence', 'adverb_rate', 'dialogue_ratio', 'fragment_rate', 'long_sentence_rate'] as const;
export type VoiceMetric = (typeof VOICE_METRICS)[number];

const LABEL: Record<VoiceMetric, string> = {
  avg_words_per_sentence: 'sentence length',
  adverb_rate: '-ly adverbs',
  dialogue_ratio: 'dialogue vs narration',
  fragment_rate: 'short fragments',
  long_sentence_rate: 'very long sentences'
};
// Absolute floors so a section isn't flagged for a statistically-large but
// practically-tiny difference (e.g. spread near zero).
const FLOOR: Record<VoiceMetric, number> = {
  avg_words_per_sentence: 4,
  adverb_rate: 0.02,
  dialogue_ratio: 0.15,
  fragment_rate: 0.04,
  long_sentence_rate: 0.06
};

const MIN_WORDS = 120;   // sections shorter than this are too small to compare
const MIN_COMPARABLE = 3; // need at least this many comparable sections for a baseline
const Z_THRESHOLD = 2.0;

type Metrics = Record<VoiceMetric, number>;

function sectionMetrics(section_id: string, content: string): { words: number; metrics: Metrics } {
  const s = analyzeSectionProse(section_id, content).section_stats;
  return {
    words: s.words,
    metrics: {
      avg_words_per_sentence: s.avg_words_per_sentence,
      adverb_rate: s.words ? +(s.adverb_ly / s.words).toFixed(3) : 0,
      dialogue_ratio: s.dialogue_ratio,
      fragment_rate: s.sentences ? +(s.fragments / s.sentences).toFixed(3) : 0,
      long_sentence_rate: s.sentences ? +(s.long_sentences / s.sentences).toFixed(3) : 0
    }
  };
}

export type VoiceOutlierReason = { metric: VoiceMetric; label: string; value: number; baseline: number; delta: number; z: number; direction: 'higher' | 'lower'; text: string };
export type VoiceReport = {
  status: 'ok' | 'insufficient_text';
  detail?: string;
  book_baseline: Metrics | null;
  section_count: number;
  compared_count: number;
  sections: { chapter_number: number | null; title: string | null; section_id: string; chapter_id: string; words: number; metrics: Metrics; comparable: boolean; outlier: boolean; score: number }[];
  outliers: { chapter_number: number | null; title: string | null; section_id: string; chapter_id: string; score: number; question: string; reasons: VoiceOutlierReason[] }[];
  summary: { consistent: boolean; outlier_count: number; note: string };
};

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stddev(xs: number[], m: number): number { return xs.length ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) : 0; }

export function computeVoiceConsistency(input: VoiceSectionInput[]): VoiceReport {
  const rows = input.map((s) => ({ ...s, ...sectionMetrics(s.section_id, s.content) }));
  const comparable = rows.filter((r) => r.words >= MIN_WORDS);

  if (comparable.length < MIN_COMPARABLE) {
    return {
      status: 'insufficient_text',
      detail: `Need at least ${MIN_COMPARABLE} sections of ~${MIN_WORDS}+ words to compare voice. Keep writing and check back.`,
      book_baseline: null, section_count: rows.length, compared_count: comparable.length,
      sections: rows.map((r) => ({ chapter_number: r.chapter_number, title: r.title, section_id: r.section_id, chapter_id: r.chapter_id, words: r.words, metrics: r.metrics, comparable: r.words >= MIN_WORDS, outlier: false, score: 0 })),
      outliers: [], summary: { consistent: true, outlier_count: 0, note: 'Not enough written yet to judge voice consistency.' }
    };
  }

  // Word-weighted book baseline over ALL comparable sections — this is what we
  // show as "your usual" voice.
  const baseline = {} as Metrics;
  const totalWords = comparable.reduce((a, r) => a + r.words, 0);
  for (const m of VOICE_METRICS) {
    baseline[m] = +(comparable.reduce((a, r) => a + r.metrics[m] * r.words, 0) / (totalWords || 1)).toFixed(3);
  }

  // Score each section LEAVE-ONE-OUT: compare it to the OTHER comparable
  // sections, so a single outlier can't inflate the spread it's judged against.
  const sections = rows.map((r) => {
    const isComparable = r.words >= MIN_WORDS;
    const reasons: VoiceOutlierReason[] = [];
    if (isComparable) {
      const others = comparable.filter((o) => o.section_id !== r.section_id);
      const ow = others.reduce((a, o) => a + o.words, 0) || 1;
      for (const m of VOICE_METRICS) {
        const oMean = +(others.reduce((a, o) => a + o.metrics[m] * o.words, 0) / ow).toFixed(3);
        const oSd = +stddev(others.map((o) => o.metrics[m]), oMean).toFixed(4);
        const delta = +(r.metrics[m] - oMean).toFixed(3);
        const z = oSd > 0 ? +(delta / oSd).toFixed(2) : (Math.abs(delta) >= FLOOR[m] ? Math.sign(delta) * 99 : 0);
        if (Math.abs(z) >= Z_THRESHOLD && Math.abs(delta) >= FLOOR[m]) {
          const direction: 'higher' | 'lower' = delta > 0 ? 'higher' : 'lower';
          reasons.push({ metric: m, label: LABEL[m], value: r.metrics[m], baseline: oMean, delta, z, direction, text: reasonText(m, r.metrics[m], oMean, direction) });
        }
      }
    }
    const score = +reasons.reduce((a, x) => a + Math.min(Math.abs(x.z), 20), 0).toFixed(2);
    return { chapter_number: r.chapter_number, title: r.title, section_id: r.section_id, chapter_id: r.chapter_id, words: r.words, metrics: r.metrics, comparable: isComparable, outlier: reasons.length > 0, score, reasons };
  });

  const outliers = sections
    .filter((s) => s.outlier)
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ chapter_number: s.chapter_number, title: s.title, section_id: s.section_id, chapter_id: s.chapter_id, score: s.score, reasons: s.reasons, question: 'Is this shift intentional for this moment, or worth a look so the voice reads consistently?' }));

  return {
    status: 'ok',
    book_baseline: baseline,
    section_count: rows.length,
    compared_count: comparable.length,
    sections: sections.map(({ reasons, ...rest }) => rest),
    outliers,
    summary: {
      consistent: outliers.length === 0,
      outlier_count: outliers.length,
      note: outliers.length === 0
        ? `Your voice reads consistently across the ${comparable.length} sections compared.`
        : `${outliers.length} section(s) read noticeably different from the rest of your book — check whether that's intentional.`
    }
  };
}

function reasonText(m: VoiceMetric, value: number, baseline: number, dir: 'higher' | 'lower'): string {
  const more = dir === 'higher';
  switch (m) {
    case 'avg_words_per_sentence':
      return `Sentences run ${more ? 'longer' : 'shorter'} here — about ${value} words vs. your usual ~${baseline}.`;
    case 'adverb_rate':
      return `${more ? 'More' : 'Fewer'} -ly adverbs than usual (${value} vs. ~${baseline} per word).`;
    case 'dialogue_ratio':
      return `${more ? 'More dialogue' : 'More narration'} than the rest of the book (dialogue ${value} vs. ~${baseline}).`;
    case 'fragment_rate':
      return `${more ? 'More' : 'Fewer'} short fragments than usual (${value} vs. ~${baseline} per sentence).`;
    case 'long_sentence_rate':
      return `${more ? 'More' : 'Fewer'} very long sentences than usual (${value} vs. ~${baseline} per sentence).`;
  }
}
