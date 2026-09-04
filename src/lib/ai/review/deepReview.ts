/**
 * Optional AI (Deep) candidate pass for Review & Continuity. The AI only ever
 * PROPOSES candidates from a bounded structured digest of the ACTIVE manuscript;
 * every candidate is then evidence-verified against real section text and
 * discarded if it can't be located. Verified candidates become normal
 * FindingCandidates (source:'ai') and flow through the SAME review_findings
 * pipeline (dedup + fingerprint reconciliation). No prose/canon writes here.
 */
import { createHash } from 'node:crypto';
import type { ReviewFindingType, ReviewFindingLevel } from '@/lib/types/database';
import type { FindingCandidate } from '@/lib/ai/review/continuity';

type Chap = { id: string; chapter_number: number | null; title: string; sort_order: number };
type Sec = { id: string; chapter_id: string; sort_order: number; title: string | null; content: string };
export type DeepInput = {
  chapters: Chap[];
  sections: Sec[];
  threads: { title: string; status: string; description: string | null }[];
  relationships: { a: string; b: string; current_status: string | null; unresolved_tension: string | null }[];
  canonFacts: { subject: string; fact: string }[];
  timeline: { order: number; chapter_number: number | null; description: string }[];
  characterNames: string[];
};

// claim_basis is the STRUCTURED basis of a candidate — it decides whether the
// finding is allowed to be a strong (Likely Conflict) claim. It is authoritative
// over level_hint: a bounded-retrieval reviewer must not present "I didn't find
// the bridge" as "the bridge doesn't exist".
export type ClaimBasis = 'positive_conflict' | 'absence_based' | 'progression_gap' | 'open_question';
export const CLAIM_BASES: readonly ClaimBasis[] = ['positive_conflict', 'absence_based', 'progression_gap', 'open_question'];
export const ABSENCE_BASES: ReadonlySet<string> = new Set(['absence_based', 'progression_gap']);

export type RawAiCandidate = {
  type: string;
  title: string;
  claim: string;
  explanation: string;
  involved_entities?: { kind: string; name: string }[];
  evidence_targets: { chapter_hint?: number | string; quote_or_terms: string }[];
  question_for_writer?: string;
  confidence?: number;
  reasoning_category?: string;
  claim_basis?: string;
  level_hint?: string;
};
export type RawAiResult = { candidates: RawAiCandidate[] };

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n = 160) => { const t = norm(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const EXCERPT = 320;

// --- Bounded, staged context: a per-chapter digest + entity lists. Never the
// whole manuscript verbatim (§14). The model may only quote from these excerpts.
export function buildDeepReviewDigest(input: DeepInput): string {
  const chSorted = [...input.chapters].sort((a, b) => a.sort_order - b.sort_order);
  const secByCh = new Map<string, Sec[]>();
  for (const s of input.sections) { const a = secByCh.get(s.chapter_id) ?? []; a.push(s); secByCh.set(s.chapter_id, a); }
  const chapterBlocks = chSorted.map((c) => {
    const secs = (secByCh.get(c.id) ?? []).sort((a, b) => a.sort_order - b.sort_order);
    const body = secs.map((s) => s.content).join(' ');
    return `Chapter ${c.chapter_number ?? '?'}: ${c.title}\n${clip(body, EXCERPT)}`;
  }).join('\n\n');
  const lines: string[] = [chapterBlocks];
  if (input.characterNames.length) lines.push(`\nCHARACTERS: ${input.characterNames.join(', ')}`);
  if (input.threads.length) lines.push(`\nSTORY THREADS:\n${input.threads.map((t) => `- ${t.title} (${t.status})`).join('\n')}`);
  if (input.relationships.length) lines.push(`\nRELATIONSHIPS:\n${input.relationships.map((r) => `- ${r.a} & ${r.b}${r.current_status ? `: ${r.current_status}` : ''}`).join('\n')}`);
  if (input.canonFacts.length) lines.push(`\nESTABLISHED FACTS:\n${input.canonFacts.slice(0, 40).map((f) => `- ${f.subject}: ${f.fact}`).join('\n')}`);
  return lines.join('\n');
}

export const DEEP_REVIEW_SYSTEM =
  `You are a fiction continuity reviewer. Find only STORY-CONSISTENCY issues that are hard to catch mechanically: character knowledge continuity (knowing something before learning it), subtle timeline problems, abrupt relationship transitions, emotional-continuity gaps between chapters, character-detail contradictions, and clearly-dropped setups. This is NOT copyediting, style, or grammar. ` +
  `Rules: (1) PRECISION OVER QUANTITY — propose at most 6, and only issues you can support with a short VERBATIM quote copied from the provided chapter excerpts. (2) For every candidate, include evidence_targets with the exact quote(s) (copied verbatim from the text above) that show the issue; for a contradiction include BOTH sides. (3) If you cannot quote the text, DO NOT propose it. (4) Do not tell the writer what a character should feel; only flag story progression. (5) Never claim something is wrong — frame as a question the writer decides. (6) Unresolved threads that may continue in a later book are NOT errors. ` +
  `IMPORTANT — you reviewed only a BOUNDED excerpt of the manuscript, so NOT FINDING something does NOT prove it is absent. Classify every candidate with claim_basis: ` +
  `"positive_conflict" = affirmative evidence on BOTH sides that directly contradict (e.g. incompatible ages/dates/parentage/locations, or a character demonstrably knowing something before the chronology allows) — these may be level_hint "likely_conflict" when you can quote both sides; ` +
  `"progression_gap" = a before-state and an after-state are both shown but you did not locate the connecting beat between them; ` +
  `"absence_based" = the concern depends on something you did NOT find; ` +
  `"open_question" = ambiguous rather than contradictory. ` +
  `For progression_gap / absence_based you MUST use level_hint "worth_checking" and calibrated, non-absolute wording — say "I didn't find the transition in the material reviewed" / "this may be established elsewhere", NEVER "this is missing" / "no scene exists" / "the author forgot" / "never shown". Ask whether it is shown elsewhere or another beat would help, rather than asserting it is absent. ` +
  `TIME PASSES between chapters — chapters are chronological. Evidence from a LATER chapter reflects a LATER point in the story. A character talking more or less often, feeling or believing something different, or a relationship being closer or more distant LATER than EARLIER is normal change over time, NOT a contradiction — do NOT mark it positive_conflict or likely_conflict. Only mark positive_conflict when the two states are true at the SAME moment, or the fact cannot change (an age at a fixed date, parentage, where someone was born, an event that already happened). For example, "no contact for two weeks" early and "texting again" many chapters later is progression, not a conflict; someone "baptized before" (backstory) does not conflict with an earlier emotional crisis.`;

export const DEEP_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['knowledge', 'timeline', 'relationship', 'character', 'continuity', 'setup_payoff'] },
          title: { type: 'string' },
          claim: { type: 'string' },
          explanation: { type: 'string' },
          involved_entities: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string' }, name: { type: 'string' } }, required: ['kind', 'name'] } },
          evidence_targets: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { chapter_hint: { type: 'string' }, quote_or_terms: { type: 'string' } }, required: ['quote_or_terms'] } },
          question_for_writer: { type: 'string' },
          confidence: { type: 'number' },
          reasoning_category: { type: 'string' },
          claim_basis: { type: 'string', enum: ['positive_conflict', 'absence_based', 'progression_gap', 'open_question'] },
          level_hint: { type: 'string', enum: ['worth_checking', 'likely_conflict'] }
        },
        required: ['type', 'title', 'explanation', 'evidence_targets']
      }
    }
  },
  required: ['candidates']
};

const STOP = new Set(['the', 'and', 'that', 'with', 'this', 'from', 'they', 'their', 'them', 'have', 'been', 'were', 'what', 'when', 'about', 'into', 'then', 'than', 'there', 'here', 'which', 'would', 'could', 'should', 'because', 'while', 'where']);
function distinctive(q: string): string[] {
  return Array.from(new Set(norm(q).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w))));
}

// Locate a candidate's quote in the ACTIVE sections. Returns the resolved
// evidence (chapter/section/excerpt) or null. Phrase match first, then a
// conservative distinctive-term-overlap fallback.
function locate(sections: Sec[], chById: Map<string, Chap>, quote: string): { chapter_id: string; chapter_number: number | null; section_id: string; context: string } | null {
  const q = norm(quote);
  if (q.length < 10) return null;
  const phrase = q.toLowerCase().slice(0, Math.min(q.length, 60));
  for (const s of sections) {
    const c = norm(s.content).toLowerCase();
    if (q.length >= 12 && c.includes(phrase)) {
      return { chapter_id: s.chapter_id, chapter_number: chById.get(s.chapter_id)?.chapter_number ?? null, section_id: s.id, context: clip(quote, 140) };
    }
  }
  const terms = distinctive(q);
  if (terms.length >= 2) {
    let best: Sec | null = null, bestScore = 0;
    for (const s of sections) {
      const words = new Set(norm(s.content).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/));
      const hit = terms.filter((t) => words.has(t)).length;
      if (hit > bestScore) { bestScore = hit; best = s; }
    }
    if (best && bestScore >= Math.max(2, Math.ceil(terms.length * 0.6))) {
      return { chapter_id: best.chapter_id, chapter_number: chById.get(best.chapter_id)?.chapter_number ?? null, section_id: best.id, context: clip(quote, 140) };
    }
  }
  return null;
}

const TYPE_MAP: Record<string, ReviewFindingType> = { knowledge: 'knowledge', timeline: 'timeline', relationship: 'relationship', character: 'character', continuity: 'continuity', setup_payoff: 'setup_payoff' };

// Bounds for UNTRUSTED candidate payloads (host-generated or provider-generated,
// treated identically). Precision over quantity: a whole-book pass proposes ≤6,
// so 12 is a generous ceiling that still blocks giant/abusive payloads (§14).
export const MAX_HOST_CANDIDATES = 12;
const MAX_EVIDENCE_TARGETS = 6;
const MAX_ENTITIES = 10;
const LIMITS = { title: 300, claim: 500, explanation: 2000, question: 400, entity: 120, kind: 40, quote: 500, category: 60 };

const cap = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

/**
 * Strictly sanitize an UNTRUSTED candidate array (from an MCP host or any
 * provider) into well-formed RawAiCandidates: bound the count, drop malformed
 * entries, and clamp every string/array length. This never trusts the content —
 * the deterministic verifier still has to locate each quote in real text.
 */
export function sanitizeHostCandidates(raw: unknown): { candidates: RawAiCandidate[]; rejectedMalformed: number; truncated: boolean } {
  const arr = Array.isArray(raw) ? raw : [];
  const truncated = arr.length > MAX_HOST_CANDIDATES;
  const bounded = arr.slice(0, MAX_HOST_CANDIDATES);
  const candidates: RawAiCandidate[] = [];
  let rejectedMalformed = 0;
  for (const item of bounded) {
    const o = (item ?? {}) as Record<string, unknown>;
    const type = cap(o.type, 40);
    const title = cap(o.title, LIMITS.title);
    const explanation = cap(o.explanation, LIMITS.explanation);
    const targetsIn = Array.isArray(o.evidence_targets) ? o.evidence_targets : [];
    const evidence_targets = targetsIn
      .map((t) => { const q = cap((t as Record<string, unknown>)?.quote_or_terms, LIMITS.quote); const ch = (t as Record<string, unknown>)?.chapter_hint; return q ? { quote_or_terms: q, chapter_hint: typeof ch === 'string' || typeof ch === 'number' ? ch : undefined } : null; })
      .filter((t): t is NonNullable<typeof t> => !!t)
      .slice(0, MAX_EVIDENCE_TARGETS);
    if (!type || !title || !explanation || evidence_targets.length === 0) { rejectedMalformed++; continue; } // required fields (§13)
    const entitiesIn = Array.isArray(o.involved_entities) ? o.involved_entities : [];
    const involved_entities = entitiesIn
      .map((e) => { const kind = cap((e as Record<string, unknown>)?.kind, LIMITS.kind); const name = cap((e as Record<string, unknown>)?.name, LIMITS.entity); return kind && name ? { kind, name } : null; })
      .filter((e): e is NonNullable<typeof e> => !!e)
      .slice(0, MAX_ENTITIES);
    const level_hint = o.level_hint === 'likely_conflict' || o.level_hint === 'worth_checking' ? o.level_hint : undefined;
    const claim_basis = typeof o.claim_basis === 'string' && (CLAIM_BASES as readonly string[]).includes(o.claim_basis) ? o.claim_basis : undefined;
    candidates.push({
      type, title, explanation,
      claim: cap(o.claim, LIMITS.claim) ?? '',
      involved_entities,
      evidence_targets,
      question_for_writer: cap(o.question_for_writer, LIMITS.question),
      confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : undefined,
      reasoning_category: cap(o.reasoning_category, LIMITS.category),
      claim_basis,
      level_hint
    });
  }
  return { candidates, rejectedMalformed, truncated };
}

// --- Absence-confidence guard -----------------------------------------------
// Bounded retrieval means "I didn't find X" is NOT "X is absent". These helpers
// keep absence-dependent findings honest: cap their level, calibrate wording,
// and try a broader search for the missing bridge before surfacing anything.

// Chapters are chronological. When a finding's two sides sit this many chapters
// apart, they describe different POINTS IN TIME — a change of a mutable state
// (how often people talk, someone's feelings/faith, a relationship's closeness)
// across that span is normal progression, not a same-moment contradiction.
const TEMPORAL_GAP = 3;
const MUTABLE_STATE_TYPES: ReadonlySet<ReviewFindingType> = new Set(['relationship', 'character', 'knowledge', 'continuity']);

function claimBasisOf(cand: RawAiCandidate): ClaimBasis | 'unknown' {
  return typeof cand.claim_basis === 'string' && (CLAIM_BASES as readonly string[]).includes(cand.claim_basis) ? (cand.claim_basis as ClaimBasis) : 'unknown';
}

// Transition/bridge vocabulary for a targeted broader check over the FULL active
// manuscript (not just the excerpt). Deliberately multiword/specific to avoid
// false "bridge found". A bridge = a section mentioning an involved name AND a
// transition phrase (relationship) or a learn/reveal phrase (knowledge).
const REL_BRIDGE = ['broke up', 'broke it off', 'break up', 'breakup', 'ended things', 'ended it', 'split up', 'called it off', 'stopped seeing', 'no longer together', 'back together', 'got together', 'asked her out', 'asked him out', 'started dating', 'moved on from'];
const KNOW_BRIDGE = ['told her', 'told him', 'learned', 'found out', 'discovered', 'revealed', 'confided', 'confessed', 'admitted', 'showed her', 'showed him', 'explained to her', 'explained to him'];
const PAYOFF_BRIDGE = ['opened', 'revealed', 'returned', 'came back', 'used it', 'paid off', 'fulfilled', 'resolved', 'finally'];
const lc = (s: string) => norm(s).toLowerCase();

function bridgeLocated(allSections: Sec[], cand: RawAiCandidate, type: ReviewFindingType): boolean {
  const names = (cand.involved_entities ?? []).map((e) => lc(e.name)).filter((n) => n.length >= 3);
  if (type === 'setup_payoff') {
    const objs = distinctive(`${cand.title} ${cand.claim ?? ''}`);
    if (objs.length === 0) return false;
    return allSections.some((s) => { const c = lc(s.content); return objs.some((o) => c.includes(o)) && PAYOFF_BRIDGE.some((k) => c.includes(k)); });
  }
  if (names.length === 0) return false; // can't run a targeted search without a subject
  const kws = type === 'knowledge' ? KNOW_BRIDGE : [...REL_BRIDGE, ...KNOW_BRIDGE];
  return allSections.some((s) => { const c = lc(s.content); return names.some((n) => c.includes(n)) && kws.some((k) => c.includes(k)); });
}

// Replace absolute absence language with calibrated, bounded-retrieval wording.
const ABSOLUTE_PATTERNS: [RegExp, string][] = [
  [/\bthe (author|writer) forgot(?: to[^.]*)?\b/gi, 'it may not be shown in the passages reviewed'],
  [/\b(there is|there's) no scene\b/gi, 'no connecting scene was located in the material reviewed'],
  [/\bno scene exists\b/gi, 'no connecting scene was located in the material reviewed'],
  [/\bnever (explained|shown|established|mentioned|described)\b/gi, "wasn't $1 in the material reviewed"],
  [/\bwas never\b/gi, "wasn't, in the material reviewed,"],
  [/\bthe manuscript does(?:n't| not)\b/gi, "the reviewed passages don't"],
  [/\bthis is missing\b/gi, 'this wasn’t located in the material reviewed'],
  [/\b(is|are|was|were) missing\b/gi, '$1 not located in the material reviewed'],
  [/\bdoes(?:n't| not) exist\b/gi, "wasn't located in the material reviewed"]
];
function softenAbsolutes(s: string): string { let t = s ?? ''; for (const [re, rep] of ABSOLUTE_PATTERNS) t = t.replace(re, rep); return t; }
const HEDGED = /material reviewed|passages reviewed|didn'?t find|not located|wasn'?t (?:visible|located|shown)|may (?:already )?be established elsewhere/i;

function calibrateAbsenceWording(title: string, explanation: string): { title: string; explanation: string; question: string } {
  let ex = softenAbsolutes(explanation ?? '');
  if (!HEDGED.test(ex)) ex = `${ex}${/[.!?]\s*$/.test(ex) ? '' : '.'} I didn’t find this in the material reviewed.`;
  return { title: softenAbsolutes(title ?? ''), explanation: ex, question: 'Is this shown elsewhere, or would another beat help make the progression clearer?' };
}

// Verify + convert raw candidates into FindingCandidates, reporting discards.
// Discards anything whose evidence can't be located; dedupes against
// deterministic subjects. Provider-agnostic: identical whether the candidates
// came from OpenAI or from an MCP host. Enforces the absence-confidence guard.
export function verifyAiCandidatesDetailed(input: DeepInput, sections: Sec[], raw: RawAiResult, deterministicSubjects: Set<string>): { kept: FindingCandidate[]; discarded: { title: string; reason: string }[] } {
  const chById = new Map(input.chapters.map((c) => [c.id, c]));
  const allSections = input.sections; // FULL active manuscript, for the broader bridge search
  const out: FindingCandidate[] = [];
  const discarded: { title: string; reason: string }[] = [];
  const seenFp = new Set<string>();
  const drop = (t: string, reason: string) => discarded.push({ title: clip(t || '(untitled)', 90), reason });
  for (const cand of (raw.candidates ?? [])) {
    const type = TYPE_MAP[cand.type];
    if (!type) { drop(cand.title, 'unknown_type'); continue; }
    const resolved = (cand.evidence_targets ?? []).map((t) => locate(sections, chById, t.quote_or_terms)).filter((x): x is NonNullable<typeof x> => !!x);
    if (resolved.length === 0) { drop(cand.title, 'no_evidence_located'); continue; } // no evidence → no finding (§3/§5)
    if (cand.level_hint === 'likely_conflict' && resolved.length < 2) { drop(cand.title, 'one_sided_conflict'); continue; } // strong claim needs both sides

    const basis = claimBasisOf(cand);
    const isAbsence = ABSENCE_BASES.has(basis);
    // Broader targeted check: for an absence/progression claim, look across the
    // WHOLE active manuscript for the bridge. If found, the concern is answered.
    if (isAbsence && bridgeLocated(allSections, cand, type)) { drop(cand.title, 'bridge_located'); continue; }

    // Temporal-progression guard: if the two sides are quoted from chapters far
    // apart, they describe different points in the timeline. For a mutable
    // state (relationship/character/knowledge/continuity) that is a change over
    // time, NOT a contradiction — so it can never be Likely Conflict.
    const chNums = resolved.map((r) => r.chapter_number).filter((n): n is number => typeof n === 'number');
    const chapterSpan = chNums.length >= 2 ? Math.max(...chNums) - Math.min(...chNums) : 0;
    const temporalProgression = chapterSpan >= TEMPORAL_GAP && MUTABLE_STATE_TYPES.has(type);

    // Confidence CEILING (server is the authority): only an affirmative
    // positive_conflict with both sides quoted, at the SAME point in time, may
    // be Likely Conflict. Absence/progression claims and cross-timeline state
    // changes can never exceed Worth Checking, even if the model asked for
    // Likely Conflict; unknown/unclassified basis is treated conservatively.
    let level: ReviewFindingLevel =
      basis === 'positive_conflict' && resolved.length >= 2 && cand.level_hint === 'likely_conflict' ? 'likely_conflict'
        : isAbsence ? 'worth_checking'
          : type === 'setup_payoff' ? 'open_question'
            : 'worth_checking';
    if (level === 'likely_conflict' && temporalProgression) level = 'worth_checking';

    const entities = (cand.involved_entities ?? []).map((e) => ({ kind: e.kind, name: e.name }));
    const subjectKey = `${type}:${(entities[0]?.name ?? cand.title).toLowerCase().slice(0, 40)}`;
    if (deterministicSubjects.has(subjectKey)) { drop(cand.title, 'duplicate_of_deterministic'); continue; } // dedupe vs deterministic (§12)
    const fp = `ai:${type}:${md5(subjectKey)}`;
    if (seenFp.has(fp)) { drop(cand.title, 'duplicate_candidate'); continue; }
    seenFp.add(fp);

    // Wording calibration + confidence cap for absence/progression findings and
    // for cross-timeline state changes (reframed as a "change over time" question).
    let title = cand.title, explanation = cand.explanation, question = cand.question_for_writer ?? null;
    let confidence = typeof cand.confidence === 'number' ? Math.max(0, Math.min(1, cand.confidence)) : 0.5;
    if (isAbsence || temporalProgression) {
      const c = calibrateAbsenceWording(title, explanation);
      title = c.title; explanation = c.explanation;
      question = temporalProgression
        ? 'These read as different states at different points in the story — is that an intended change over time, or should a beat show the shift?'
        : c.question;
      confidence = Math.min(confidence, 0.6);
    }

    out.push({
      finding_type: type, level,
      title: clip(title, 90),
      explanation: clip(explanation, 400),
      question: question ? clip(question, 200) : 'Is this intentional, or should it be revised?',
      evidence: resolved.slice(0, 3).map((r) => ({ chapter_id: r.chapter_id, chapter_number: r.chapter_number, section_id: r.section_id, context: r.context })),
      entities,
      confidence,
      fingerprint: fp,
      evidence_hash: md5(resolved.map((r) => r.context).join('|')),
      chapter_id: resolved[0]!.chapter_id,
      source: 'ai'
    });
  }
  return { kept: out, discarded };
}

// Verify + convert raw AI candidates into FindingCandidates. Discards anything
// whose evidence can't be located; dedupes against deterministic subjects.
export function verifyAiCandidates(input: DeepInput, sections: Sec[], raw: RawAiResult, deterministicSubjects: Set<string>): FindingCandidate[] {
  return verifyAiCandidatesDetailed(input, sections, raw, deterministicSubjects).kept;
}
