/**
 * Deterministic Review & Continuity engine. Given the assembled ACTIVE
 * manuscript + Story-Intelligence data, it emits evidence-first finding
 * CANDIDATES — never verdicts, never rewrites. Every candidate cites a real
 * chapter/section. Precision over quantity: a source only emits a finding when
 * the stored data objectively supports it. Subtle knowledge/relationship-nuance
 * findings are intentionally left to a later AI candidate source that plugs into
 * the same shape. No LLM here.
 */
import { createHash } from 'node:crypto';
import type {
  ReviewFindingType, ReviewFindingLevel, ReviewEvidenceRef, ReviewEntityRef,
  StoryThread, CanonFact, CanonFactConflict, Relationship, TimelineEvent
} from '@/lib/types/database';

export type FindingCandidate = {
  finding_type: ReviewFindingType;
  level: ReviewFindingLevel;
  title: string;
  explanation: string;
  question: string | null;
  evidence: ReviewEvidenceRef[];
  entities: ReviewEntityRef[];
  confidence: number;
  fingerprint: string;
  evidence_hash: string;
  chapter_id: string | null;
  source?: 'deterministic' | 'ai';
};

type Chap = { id: string; chapter_number: number | null; title: string; sort_order: number };
type Sec = { id: string; chapter_id: string; sort_order: number; title: string | null; content: string };

export type ReviewInput = {
  chapters: Chap[];               // ACTIVE only, any order
  sections: Sec[];                // sections of active chapters
  threads: StoryThread[];
  canonFacts: CanonFact[];
  canonConflicts: CanonFactConflict[];
  relationships: Relationship[];
  timelineEvents: TimelineEvent[];
  characterNames: Map<string, string>; // character_id → name
};

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const clip = (s: string, n = 160) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const DORMANT_GAP = 3; // active chapters since last development before nudging

export function computeContinuityFindings(input: ReviewInput): FindingCandidate[] {
  const out: FindingCandidate[] = [];
  const chById = new Map(input.chapters.map((c) => [c.id, c]));
  const orderOf = (chapterId: string | null): number | null => { if (!chapterId) return null; const c = chById.get(chapterId); return c ? c.sort_order : null; };
  const maxOrder = input.chapters.reduce((m, c) => Math.max(m, c.sort_order), -1);
  const chapterRef = (chapterId: string | null, context: string): ReviewEvidenceRef => {
    const c = chapterId ? chById.get(chapterId) : undefined;
    return { chapter_id: chapterId ?? null, chapter_number: c?.chapter_number ?? null, context };
  };

  // --- A. Story threads → unresolved storyline / setup-payoff ---------------
  // A parked thread (sequel / later-in-book) is intentional and NOT nudged.
  for (const t of input.threads) {
    if (t.status === 'Resolved') continue;
    const parked = t.next_expected_beat === 'sequel' || t.next_expected_beat === 'later_in_book';
    const lastOrder = orderOf(t.last_chapter_id);
    const elapsed = lastOrder != null && maxOrder >= 0 ? maxOrder - lastOrder : null;
    const ev: ReviewEvidenceRef[] = [];
    if (t.last_chapter_id) ev.push(chapterRef(t.last_chapter_id, `Last development of "${t.title}".`));
    const entities: ReviewEntityRef[] = [{ kind: 'thread', id: t.id, name: t.title }];

    // Setup with a planned payoff not yet marked resolved.
    if (t.planned_payoff && !parked) {
      out.push({
        finding_type: 'setup_payoff', level: 'open_question',
        title: `Setup to pay off: “${t.title}”`,
        explanation: `This thread has a planned payoff (“${clip(t.planned_payoff, 120)}”) and isn't marked resolved yet${elapsed != null ? `; last developed ${elapsed} chapter(s) ago` : ''}.`,
        question: 'Is this meant to pay off in this book, or continue later?',
        evidence: ev, entities, confidence: 0.6,
        fingerprint: `setup_payoff:thread:${t.id}`,
        evidence_hash: md5(`${t.status}|${t.last_chapter_id ?? ''}|${t.planned_payoff}`),
        chapter_id: t.last_chapter_id ?? null
      });
      continue; // one primary finding per thread
    }
    // Dormant, or active-but-quiet for a while (and not intentionally parked).
    const quiet = t.status === 'Dormant' || (elapsed != null && elapsed >= DORMANT_GAP);
    if (quiet && !parked) {
      out.push({
        finding_type: 'plot_thread', level: 'open_question',
        title: `Open storyline: “${t.title}”`,
        explanation: `${t.status === 'Dormant' ? 'This thread is marked dormant' : `This thread hasn't developed in ${elapsed} chapter(s)`}${t.description ? ` — ${clip(t.description, 120)}` : ''}.`,
        question: 'Resolve it in this book, carry it forward intentionally, or add a reminder?',
        evidence: ev, entities, confidence: 0.5,
        fingerprint: `plot_thread:thread:${t.id}`,
        evidence_hash: md5(`${t.status}|${t.last_chapter_id ?? ''}|${elapsed ?? ''}`),
        chapter_id: t.last_chapter_id ?? null
      });
    }
  }

  // --- B. Canon conflicts → likely continuity/character conflict ------------
  const factById = new Map(input.canonFacts.map((f) => [f.id, f]));
  const secById = new Map(input.sections.map((s) => [s.id, s]));
  for (const cf of input.canonConflicts) {
    if (cf.resolved_at) continue; // writer already handled it
    const fact = factById.get(cf.canon_fact_id);
    if (!fact) continue;
    const sec = cf.section_id ? secById.get(cf.section_id) : undefined;
    const isChar = fact.subject_type === 'character';
    const name = isChar && fact.subject_id ? input.characterNames.get(fact.subject_id) : undefined;
    out.push({
      finding_type: isChar ? 'character' : 'continuity',
      level: 'likely_conflict',
      title: `Possible conflict${name ? `: ${name}` : ''}`,
      explanation: `Story Canon says “${clip(fact.fact, 120)}”, but the manuscript reads: “${clip(cf.conflicting_excerpt, 120)}”.${cf.description ? ` ${clip(cf.description, 100)}` : ''}`,
      question: 'Is this intentional (e.g. time has passed), or should one passage be revised?',
      evidence: sec ? [{ chapter_id: sec.chapter_id, chapter_number: chById.get(sec.chapter_id)?.chapter_number ?? null, section_id: sec.id, context: clip(cf.conflicting_excerpt) }] : [{ chapter_id: null, chapter_number: null, context: clip(cf.conflicting_excerpt) }],
      entities: name ? [{ kind: 'character', id: fact.subject_id, name }] : [],
      confidence: 0.75,
      fingerprint: `continuity:conflict:${cf.id}`,
      evidence_hash: md5(cf.conflicting_excerpt ?? ''),
      chapter_id: sec?.chapter_id ?? null
    });
  }

  // --- C. Timeline events out of order vs chapter order ---------------------
  const tlOrdered = [...input.timelineEvents].filter((e) => e.chapter_id).sort((a, b) => a.event_order - b.event_order);
  for (let i = 1; i < tlOrdered.length; i++) {
    const prev = tlOrdered[i - 1]!, cur = tlOrdered[i]!;
    const po = orderOf(prev.chapter_id), co = orderOf(cur.chapter_id);
    if (po == null || co == null) continue;
    if (co < po) {
      out.push({
        finding_type: 'timeline', level: 'worth_checking',
        title: 'Possible timeline ordering issue',
        explanation: `“${clip(cur.event_description, 90)}” is timed after “${clip(prev.event_description, 90)}”, but appears in an earlier chapter.`,
        question: 'Is the event order intentional, or should the sequence be adjusted?',
        evidence: [chapterRef(prev.chapter_id, clip(prev.event_description, 120)), chapterRef(cur.chapter_id, clip(cur.event_description, 120))],
        entities: [], confidence: 0.45,
        fingerprint: `timeline:pair:${[prev.id, cur.id].sort().join('~')}`,
        evidence_hash: md5(`${po}<${co}`),
        chapter_id: cur.chapter_id ?? null
      });
    }
  }

  // --- D. Repetition: the same passage appears in two different chapters -----
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Map<string, Sec>();
  for (const s of input.sections) {
    const key = norm(s.content);
    if (key.length < 80) continue; // ignore trivial/short blocks
    const prior = seen.get(key);
    if (prior && prior.chapter_id !== s.chapter_id) {
      out.push({
        finding_type: 'repetition', level: 'worth_checking',
        title: 'Repeated passage',
        explanation: 'Nearly identical text appears in two chapters — this may be intentional (a motif) or an accidental duplication.',
        question: 'Keep both, or revise one?',
        evidence: [chapterRef(prior.chapter_id, clip(prior.content)), chapterRef(s.chapter_id, clip(s.content))],
        entities: [], confidence: 0.5,
        fingerprint: `repetition:pair:${[prior.id, s.id].sort().join('~')}`,
        evidence_hash: md5(key.slice(0, 200)),
        chapter_id: s.chapter_id
      });
    } else if (!prior) {
      seen.set(key, s);
    }
  }

  // --- E. Relationships with explicitly noted unresolved tension ------------
  for (const r of input.relationships) {
    if (!r.unresolved_tension || !r.unresolved_tension.trim()) continue;
    const a = input.characterNames.get(r.character_a_id) ?? 'Someone';
    const b = input.characterNames.get(r.character_b_id) ?? 'someone';
    const anchorSec = r.last_meaningful_interaction ? secById.get(r.last_meaningful_interaction) : undefined;
    out.push({
      finding_type: 'relationship', level: 'open_question',
      title: `Unresolved between ${a} & ${b}`,
      explanation: `Their relationship has noted unresolved tension: “${clip(r.unresolved_tension, 120)}”.`,
      question: 'Does this get addressed in this book, or is it intentionally left open?',
      evidence: anchorSec ? [{ chapter_id: anchorSec.chapter_id, chapter_number: chById.get(anchorSec.chapter_id)?.chapter_number ?? null, section_id: anchorSec.id, context: 'Last meaningful interaction.' }] : [],
      entities: [{ kind: 'character', id: r.character_a_id, name: a }, { kind: 'character', id: r.character_b_id, name: b }],
      confidence: 0.45,
      fingerprint: `relationship:pair:${[r.character_a_id, r.character_b_id].sort().join('~')}`,
      evidence_hash: md5(r.unresolved_tension),
      chapter_id: anchorSec?.chapter_id ?? null
    });
  }

  return out;
}
