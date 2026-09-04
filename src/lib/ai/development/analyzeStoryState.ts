/**
 * analyzeStoryState — the DETERMINISTIC half of the development layer.
 *
 * It assembles the Story Context Model (identity, arc/position, threads,
 * relationships, character facts, information state, setup/payoff SIGNALS,
 * purpose, dream/revelation, world rules, decisions, open questions, working
 * notes) from rows the caller already fetched, and emits three neutral
 * collections:
 *   - evidence[]  — plain facts pulled straight from the data
 *   - signals[]   — objective computed measures (e.g. elapsed chapter distance)
 *   - candidate_items_for_attention[] — objective items a host MIGHT choose to
 *                   raise, each with its factual basis
 *
 * It makes NO literary judgment. It never says an arc "stalled", a pace is
 * "slow", or anything is "underdeveloped". It never claims a character arc has
 * or hasn't moved (there is no structured arc-beat data). Whether any item
 * matters is the host model's interpretation; the writer decides. There is NO
 * LLM call anywhere in this file.
 */

import type {
  Book,
  CanonFact,
  Chapter,
  Character,
  Relationship,
  SettingProfile,
  StoryThread,
  TimelineEvent
} from '@/lib/types/database';

// A neutral surfacing threshold — a count, not a quality judgment. Items below
// it are still returned in the full lists; this only decides what is *also*
// echoed into candidate_items_for_attention for convenience. The host, not
// this code, decides whether a surfaced item actually warrants attention.
const DISTANCE_SURFACING_THRESHOLD = 3;

export type Evidence = { key: string; value: string };
export type Signal = { key: string; value: string; basis: string };
export type CandidateItem = { id: string; kind: string; statement: string; basis: string };

// A pointer telling the host WHICH prose to retrieve and WHY — never the prose
// itself. Structured state says what may matter; the host then pulls the actual
// evidence with get_writing_context (local) or search_manuscript (story-wide),
// so a relevant setup many chapters back (e.g. the Ch4 bee origin while working
// in Ch19) is reachable without shipping the whole manuscript every turn.
export type RetrievalPlanItem = {
  kind: 'thread' | 'character';
  title: string;
  status?: string;
  reason: string;
  suggested_query: string;
  anchor_chapters?: (number | null)[];
};

export interface StoryStateAnalysis {
  scope: 'section';
  identity: {
    title: string;
    genre: string | null;
    audience: string | null;
    pov: string | null;
    tense: string | null;
    premise: string | null;
    voice: {
      provenance: 'ai_derived';
      source: 'runtime_derived';
      note: string;
      author_notes: string | null;
      sample_excerpts: string[];
    };
  };
  arc_position: {
    current_state: { chapter: string; chapter_number: number | null; prose_ends_on: string | null; sections_so_far: number };
    intended_state: { nearest_outline_purpose: string | null; chapter_end_state: string | null; book_premise: string | null };
  };
  threads: {
    id: string;
    title: string;
    status: string;
    planned_payoff: string | null;
    next_expected_beat: string | null;
    last_recorded_chapter_number: number | null;
    elapsed_chapters_since_recorded_movement: number | null;
  }[];
  relationships: {
    a: string | null;
    b: string | null;
    current_status: string | null;
    unresolved_tension: string | null;
    last_meaningful_interaction: string | null;
  }[];
  character_facts: {
    name: string;
    role: string | null;
    wants: string | null;
    fears: string | null;
    note: string;
  }[];
  information_state: { fact: string; reader_knowledge: string | null; reality_layer: string }[];
  setup_payoff_signals: { basis: string; source: string; description: string; note: string }[];
  purpose: { chapter_purpose: string | null; section_purpose: string | null };
  dream_revelation: { fact: string; reality_layer: string }[];
  world_rules: { fact: string }[];
  development_decisions: { fact: string; canon_status: string }[];
  open_questions: string[];
  working_notes: { fact: string }[];
  evidence: Evidence[];
  signals: Signal[];
  candidate_items_for_attention: CandidateItem[];
  retrieval_plan: RetrievalPlanItem[];
  presence: { hasUnresolvedThreads: boolean; hasRelationships: boolean; hasCharacters: boolean };
}

export interface AnalyzeInput {
  book: Pick<Book, 'title' | 'genre' | 'pov' | 'tense' | 'description'> & {
    target_audience?: string | null;
    author_notes?: string | null;
  };
  currentChapter: Pick<Chapter, 'id' | 'title' | 'summary' | 'chapter_number'>;
  chapterIndex: { id: string; chapter_number: number | null; sort_order: number }[];
  previousChapterEnding: string | null;
  sectionsSoFar: { content: string }[];
  currentSectionContent: string | null;
  threads: StoryThread[];
  relationships: Relationship[];
  characters: Character[];
  settings: SettingProfile[];
  canonFacts: CanonFact[];
  timelineEvents: TimelineEvent[];
  outlineNodePurpose: string | null;
  chapterOutline:
    | { purpose: string | null; chapter_end_state: string | null; new_questions_created: string | null }
    | null;
  approvedVoiceExcerpts: string[];
}

const DREAM_LAYERS = new Set(['dream', 'vision', 'prophecy', 'revelation', 'perception', 'interpretation']);
const OBJECTIVE_LAYERS = new Set(['physical_event', 'narrator_confirmed_fact']);

function lastLine(text: string | null): string | null {
  if (!text) return null;
  const parts = text.trim().split(/\n+/);
  const last = parts[parts.length - 1]?.trim();
  return last ? last.slice(0, 400) : null;
}

export function analyzeStoryState(input: AnalyzeInput): StoryStateAnalysis {
  const evidence: Evidence[] = [];
  const signals: Signal[] = [];
  const candidates: CandidateItem[] = [];

  const nameById = new Map(input.characters.map((c) => [c.id, c.name] as const));
  const sortByChapterId = new Map(input.chapterIndex.map((c) => [c.id, c.sort_order] as const));
  const numberByChapterId = new Map(input.chapterIndex.map((c) => [c.id, c.chapter_number] as const));
  const currentSort = sortByChapterId.get(input.currentChapter.id) ?? null;

  // --- Identity -------------------------------------------------------------
  evidence.push({ key: 'book.title', value: input.book.title });
  if (input.book.genre) evidence.push({ key: 'book.genre', value: input.book.genre });

  // --- Threads. `input.threads` is ALL threads; the unresolved list surfaces
  //     only Active/Dormant, but every thread feeds the retrieval plan below. --
  const unresolved = input.threads.filter((t) => t.status === 'Active' || t.status === 'Dormant');
  const threads = unresolved.map((t) => {
    const lastSort = t.last_chapter_id ? sortByChapterId.get(t.last_chapter_id) ?? null : null;
    const lastNumber = t.last_chapter_id ? numberByChapterId.get(t.last_chapter_id) ?? null : null;

    // Elapsed inactivity is only objectively calculable when the thread's last
    // recorded chapter is at or before the analysis point. When it extends to
    // or beyond the current point, we report a neutral "recorded through"
    // signal — never an inactivity/"no movement" claim.
    let elapsed: number | null = null;
    if (lastSort != null && currentSort != null) {
      if (lastSort <= currentSort) {
        elapsed = currentSort - lastSort;
        signals.push({
          key: `thread.recorded.${t.id}`,
          value: elapsed === 0
            ? `recorded through chapter ${lastNumber}`
            : `last recorded through chapter ${lastNumber} (${elapsed} chapter(s) earlier)`,
          basis: `thread last_chapter=${lastNumber}; analysis chapter position ${currentSort}`
        });
      } else {
        signals.push({
          key: `thread.recorded.${t.id}`,
          value: `recorded through chapter ${lastNumber} (at or beyond the current point)`,
          basis: `thread last_chapter=${lastNumber} >= analysis chapter position ${currentSort}`
        });
      }
    } else if (t.last_chapter_id == null) {
      signals.push({
        key: `thread.recorded.${t.id}`,
        value: 'no chapter anchor recorded',
        basis: 'thread has no last_chapter_id set'
      });
    }

    // Surface an attention candidate ONLY when inactivity is objectively
    // calculable (last recorded at/before the current point) and exceeds the
    // neutral threshold. Never surface based on a thread that runs to/past here.
    if (!!t.planned_payoff && elapsed != null && elapsed >= DISTANCE_SURFACING_THRESHOLD) {
      candidates.push({
        id: `thread:${t.id}`,
        kind: 'thread_with_planned_payoff',
        statement: `Thread "${t.title}" (${t.status}) has a planned payoff and was last recorded ${elapsed} chapter(s) before this point.`,
        basis: `planned_payoff set; last_chapter=${lastNumber}`
      });
    }

    return {
      id: t.id,
      title: t.title,
      status: t.status,
      planned_payoff: t.planned_payoff,
      next_expected_beat: t.next_expected_beat,
      last_recorded_chapter_number: lastNumber,
      elapsed_chapters_since_recorded_movement: elapsed
    };
  });

  // --- Retrieval plan (pointers only, no prose): which passages the host
  //     should pull and why. Includes unresolved threads AND any thread
  //     (incl. resolved) anchored near the current chapter — so a payoff at the
  //     current chapter surfaces its far-earlier origin. --------------------
  const currentNum = input.currentChapter.chapter_number;
  const nearCurrent = (n: number | null) => n != null && currentNum != null && Math.abs(n - currentNum) <= 2;
  const STOP = new Set(['and', 'the', 'to', 'for', 'of', 'with', 'a', 'an', 'in', 'on', 'is', 'as', 'at', 'by', 'her', 'his']);
  const keywordsFromTitle = (title: string) =>
    [...new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))]
      .slice(0, 6)
      .join('|');

  const retrieval_plan: RetrievalPlanItem[] = [];
  for (const t of input.threads) {
    const firstNum = t.first_chapter_id ? numberByChapterId.get(t.first_chapter_id) ?? null : null;
    const lastNum = t.last_chapter_id ? numberByChapterId.get(t.last_chapter_id) ?? null : null;
    const isUnresolved = t.status === 'Active' || t.status === 'Dormant';
    const anchoredHere = nearCurrent(firstNum) || nearCurrent(lastNum);
    if (!isUnresolved && !anchoredHere) continue;
    retrieval_plan.push({
      kind: 'thread',
      title: t.title,
      status: t.status,
      reason: isUnresolved
        ? `Unresolved thread — retrieve its origin (Ch ${firstNum ?? '?'}) and last recorded point (Ch ${lastNum ?? '?'}) to reason about its open payoff.`
        : `${t.status} thread anchored near the current chapter — retrieve its origin (Ch ${firstNum ?? '?'}) to reason about the payoff happening here.`,
      suggested_query: keywordsFromTitle(t.title),
      anchor_chapters: [firstNum, lastNum]
    });
  }
  for (const c of input.characters.slice(0, 6)) {
    retrieval_plan.push({
      kind: 'character',
      title: c.name,
      reason: `When the discussion concerns ${c.name}, retrieve their key passages by name.`,
      suggested_query: c.name
    });
  }

  // --- Relationships (facts only; no distance — no structured chapter ref) --
  const relationships = input.relationships.map((r) => {
    const a = nameById.get(r.character_a_id) ?? null;
    const b = nameById.get(r.character_b_id) ?? null;
    if (r.unresolved_tension) {
      candidates.push({
        id: `relationship:${r.id}`,
        kind: 'relationship_with_recorded_tension',
        statement: `Relationship ${a ?? '?'} / ${b ?? '?'} has recorded unresolved tension.`,
        basis: `unresolved_tension: ${r.unresolved_tension.slice(0, 160)}`
      });
    }
    return {
      a,
      b,
      current_status: r.current_status,
      unresolved_tension: r.unresolved_tension,
      last_meaningful_interaction: r.last_meaningful_interaction
    };
  });

  // --- Character FACTS only (never an arc-movement claim) --------------------
  const character_facts = input.characters.slice(0, 12).map((c) => ({
    name: c.name,
    role: c.role,
    wants: c.goals ?? null,
    fears: c.fears ?? null,
    note: 'Facts only. Arc shape and whether this arc has moved are literary judgments for the host — Book Build stores no arc-beat data.'
  }));

  // --- Canon-derived tiers --------------------------------------------------
  const information_state = input.canonFacts
    .filter((f) => f.reader_knowledge)
    .slice(0, 12)
    .map((f) => ({ fact: f.fact, reader_knowledge: f.reader_knowledge, reality_layer: f.reality_layer }));

  const dream_revelation = input.canonFacts
    .filter((f) => DREAM_LAYERS.has(f.reality_layer))
    .slice(0, 10)
    .map((f) => ({ fact: f.fact, reality_layer: f.reality_layer }));

  const world_rules = input.canonFacts
    .filter((f) => f.subject_type === 'book' && OBJECTIVE_LAYERS.has(f.reality_layer))
    .slice(0, 10)
    .map((f) => ({ fact: f.fact }));

  const development_decisions = input.canonFacts
    .filter((f) => f.canon_status === 'author_canon')
    .slice(0, 15)
    .map((f) => ({ fact: f.fact, canon_status: f.canon_status }));

  const working_notes = input.canonFacts
    .filter((f) => f.canon_status === 'working_note')
    .slice(0, 15)
    .map((f) => ({ fact: f.fact }));

  // --- Setup/payoff SIGNALS (heuristic, clearly labeled) --------------------
  const setup_payoff_signals: StoryStateAnalysis['setup_payoff_signals'] = [];
  for (const t of input.threads) {
    if (t.planned_payoff) {
      setup_payoff_signals.push({
        basis: 'story_thread.planned_payoff',
        source: `thread:${t.id}`,
        description: `"${t.title}" → planned payoff: ${t.planned_payoff}`,
        note: 'Heuristic signal derived from a thread, not a confirmed first-class setup/payoff record.'
      });
    }
  }
  for (const n of working_notes) {
    if (/set ?up|payoff|foreshadow|plant|callback/i.test(n.fact)) {
      setup_payoff_signals.push({
        basis: 'working_note keyword',
        source: 'working_note',
        description: n.fact.slice(0, 200),
        note: 'Heuristic signal from a working note; not a confirmed setup. Do not assume abandonment.'
      });
    }
  }

  // --- Open questions -------------------------------------------------------
  const open_questions: string[] = [];
  if (input.chapterOutline?.new_questions_created) {
    for (const q of input.chapterOutline.new_questions_created.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      open_questions.push(q);
    }
  }
  for (const t of input.threads) {
    if (t.next_expected_beat) open_questions.push(`Thread "${t.title}" expects next: ${t.next_expected_beat}`);
  }

  const presence = {
    hasUnresolvedThreads: unresolved.length > 0,
    hasRelationships: input.relationships.length > 0,
    hasCharacters: input.characters.length > 0
  };

  return {
    scope: 'section',
    identity: {
      title: input.book.title,
      genre: input.book.genre,
      audience: input.book.target_audience ?? null,
      pov: input.book.pov,
      tense: input.book.tense,
      premise: input.book.description,
      voice: {
        provenance: 'ai_derived',
        source: 'runtime_derived',
        note: 'Runtime-derived voice inference (author_notes + approved excerpts). Not canon; treat as a style hint, not a rule.',
        author_notes: input.book.author_notes ?? null,
        sample_excerpts: input.approvedVoiceExcerpts.slice(0, 3)
      }
    },
    arc_position: {
      current_state: {
        chapter: input.currentChapter.title,
        chapter_number: input.currentChapter.chapter_number,
        prose_ends_on: lastLine(input.currentSectionContent) ?? lastLine(input.previousChapterEnding),
        sections_so_far: input.sectionsSoFar.length
      },
      intended_state: {
        nearest_outline_purpose: input.outlineNodePurpose ?? input.chapterOutline?.purpose ?? null,
        chapter_end_state: input.chapterOutline?.chapter_end_state ?? null,
        book_premise: input.book.description
      }
    },
    threads,
    relationships,
    character_facts,
    information_state,
    setup_payoff_signals,
    purpose: {
      chapter_purpose: input.chapterOutline?.purpose ?? input.currentChapter.summary ?? null,
      section_purpose: null
    },
    dream_revelation,
    world_rules,
    development_decisions,
    open_questions,
    working_notes,
    evidence,
    signals,
    candidate_items_for_attention: candidates,
    retrieval_plan,
    presence
  };
}
