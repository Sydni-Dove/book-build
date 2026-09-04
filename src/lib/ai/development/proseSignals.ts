/**
 * proseSignals — the DETERMINISTIC foundation for Prose & Voice Health and
 * Targeted Revision. It splits a section into stable paragraph ANCHORS and
 * emits objective SIGNALS + measurable STATS per paragraph, plus a runtime
 * VOICE BASELINE computed from writer-approved excerpts.
 *
 * It makes NO literary judgment. It never says prose is "wordy", "flowery",
 * "overwritten", "AI-sounding", or "drifting" — it only reports patterns and
 * measurements (e.g. "3 consecutive short sentences beginning with 'Not'",
 * "avg 28 words/sentence", "adverb rate 0.09 vs baseline 0.04"). The HOST model
 * interprets these into CRAFT CONCERN / VOICE DRIFT / AUTHOR PREFERENCE and the
 * KEEP/TRIM/REWORK/CUT_CANDIDATE/MOVE classifications; the WRITER decides.
 * There is NO LLM call and NO persistence here. Voice baseline is ai_derived
 * inference, never canon.
 */

// ---- Anchors (runtime; no paragraph table) --------------------------------
export type ParagraphAnchor = {
  id: string; // `${section_id}:p${index}:${hash}` — stable to reordering via hash
  index: number;
  char_start: number;
  char_end: number;
  text_hash: string;
  excerpt: string;
};

export type ProseSignal = { kind: string; evidence: string; count?: number; in_dialogue?: boolean };

export type ParagraphStats = {
  words: number;
  sentences: number;
  avg_words_per_sentence: number;
  max_sentence_words: number;
  long_sentences: number; // > 30 words
  fragments: number; // <= 3 words
  adverb_ly: number;
  dialogue_ratio: number; // 0..1 of characters inside quotes
};

export type ParagraphReport = { anchor: ParagraphAnchor; stats: ParagraphStats; signals: ProseSignal[] };

export type VoiceBaseline = {
  provenance: 'ai_derived';
  source: 'runtime_derived';
  note: string;
  sample_paragraphs: number;
  avg_words_per_sentence: number;
  adverb_rate: number; // -ly adverbs / words
  dialogue_ratio: number;
  fragment_rate: number; // fragments / sentences
  comma_rate: number; // commas / sentence
  mean_paragraph_words: number;
};

export type ProseSignalsReport = {
  section_id: string;
  paragraphs: ParagraphReport[];
  section_stats: ParagraphStats & { paragraphs: number };
  voice_baseline: VoiceBaseline | null;
  drift_deltas: Record<string, { value: number; baseline: number; delta: number }> | null;
  meta: { llm_used: false };
};

// Tiny non-crypto hash (djb2) → hex, so this stays environment-agnostic.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const STOP = new Set(['the','a','an','and','or','but','of','to','in','on','at','for','with','as','it','is','was','were','she','he','they','her','his','their','that','this','had','have','has','not','be','been','so','if','then','there','out','up','down','into','over','him','them','you','i','we','me','my','your','our','from','by','about','just','like','no']);

const INSISTENCE = ['authentic','genuine','sacred','holy','real','raw','powerful','profound','meaningful','undeniable','palpable','tangible','pure','honest','vulnerable'];
const FILLERS = ['in order to','the fact that','began to','started to','was able to','were able to','in a way','sort of','kind of','a bit of','the sound of','the feeling of'];
// -ly words that usually aren't manner adverbs
const LY_NONADVERB = new Set(['only','family','reply','holy','ugly','early','lonely','likely','lovely','friendly','silly','daily','ally','rally','italy','apply','supply','bully','fully']);

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])["'”’)\]]?\s+/).map((s) => s.trim()).filter(Boolean);
}
function wordCount(s: string): number { const t = s.trim(); return t ? t.split(/\s+/).length : 0; }

function paragraphStats(text: string): ParagraphStats {
  const sentences = splitSentences(text);
  const sWords = sentences.map(wordCount);
  const words = wordCount(text);
  const adverb_ly = (text.toLowerCase().match(/\b[a-z]+ly\b/g) ?? []).filter((w) => !LY_NONADVERB.has(w)).length;
  // dialogue: characters inside straight or curly double quotes
  const dq = [...text.matchAll(/[“"]([^”"]*)[”"]/g)].reduce((n, m) => n + m[1]!.length, 0);
  return {
    words,
    sentences: sentences.length,
    avg_words_per_sentence: sentences.length ? +(words / sentences.length).toFixed(1) : 0,
    max_sentence_words: sWords.length ? Math.max(...sWords) : 0,
    long_sentences: sWords.filter((w) => w > 30).length,
    fragments: sWords.filter((w) => w > 0 && w <= 3).length,
    adverb_ly,
    dialogue_ratio: text.length ? +(dq / text.length).toFixed(2) : 0
  };
}

// Objective pattern detectors. Each returns evidence text — NOT a verdict.
function paragraphSignals(text: string, names: Set<string>): ProseSignal[] {
  const signals: ProseSignal[] = [];
  const sentences = splitSentences(text);

  // Emphatic negation / manufactured-significance triads: >=2 consecutive short
  // sentences beginning with Not/No, optionally capped by "Just/Only ...".
  let run: string[] = [];
  const flushRun = () => {
    if (run.length >= 2) signals.push({ kind: 'emphatic_negation_run', evidence: run.join(' '), count: run.length });
    run = [];
  };
  for (const s of sentences) {
    if (/^(not|no)\b/i.test(s) && wordCount(s) <= 5) run.push(s);
    else { if (run.length >= 2 && /^(just|only)\b/i.test(s) && wordCount(s) <= 5) run.push(s); flushRun(); }
  }
  flushRun();

  // Contrastive-negation family (an author-avoidance pattern for THIS author):
  // a negative statement immediately corrected/contrasted by a parallel clause,
  // often compressed into a thematic conclusion. Each branch requires the
  // CORRECTIVE follow-up — so ordinary standalone negation ("He wasn't home.",
  // "She didn't answer.") is NOT matched. The host, not this code, decides
  // whether a match is the disliked rhetorical habit or ordinary factual contrast.
  const contrastive = [
    // Thematic single-sentence emphasis: "It/That/This was/is not X, but Y" —
    // HIGH PRECISION on purpose: the impersonal subject ("It was not …") is the
    // rhetorical-cadence marker. This deliberately does NOT match ordinary
    // functional contrast like "She called not to take him back, but to clear
    // the air", "He came to apologize, not to argue", or "not carnal, but
    // mighty" (Scripture) — those are grammatical contrast, not the habit.
    ...text.matchAll(/\b(?:it|that|this)\s+(?:was|is)\s+not\s+(?:about\s+)?[^,.]{1,30},\s*but\s+(?:about\s+)?[^,.]{1,45}/gi),
    // "It/She/He/They wasn't X. It/She/He/They was Y." (thematic contrast)
    ...text.matchAll(/\b(?:it|she|he|they)\s+(?:wasn['’]t|weren['’]t|isn['’]t|aren['’]t)\s+[^.]{1,50}\.\s*(?:it|she|he|they)\s+(?:was|were|is|are)\b[^.]{0,50}/gi),
    // "subject didn't need/want X. subject needed/wanted/just Y."
    ...text.matchAll(/\b(?:didn['’]t|doesn['’]t|don['’]t)\s+(?:need|want|require|seek)\b[^.]{1,40}\.\s*(?:she|he|they|it|[A-Z][a-z]+)\s+(?:needed|wanted|required|sought|just|simply|only)\b[^.]{0,50}/gi),
    // diminishing corrective: "… wasn't/didn't X. Not really/quite/exactly."
    ...text.matchAll(/\b(?:wasn['’]t|weren['’]t|isn['’]t|didn['’]t|couldn['’]t)\b[^.]{1,40}\.\s*Not\s+(?:really|quite|exactly|entirely|anymore)\b/gi)
  ].map((m) => m[0].trim());
  for (const e of contrastive) signals.push({ kind: 'contrastive_negation', evidence: e.replace(/\s+/g, ' ').slice(0, 120) });

  // Motive pre-emption / reader hand-holding. The "not because … reframe"
  // now spans the connector as "but" OR an em/en-dash, semicolon, or sentence
  // break followed by "because" — so "Not because X—because Y", "…; because Y",
  // and "…. Because Y." are caught alongside the original "…, but Y".
  const motive = [
    ...text.matchAll(/\bnot because\b[^.;—–]{0,60}?(?:,?\s+but\b|[—–]\s*because\b|;\s*because\b|\.\s+because\b)[^.]{0,50}/gi),
    ...text.matchAll(/\b(?:wasn['’]t|weren['’]t)\s+(?:trying|meaning|being)\b[^.]{0,50}/gi),
    ...text.matchAll(/\bit wasn['’]t that\b[^.]{0,50}/gi),
    ...text.matchAll(/\bdidn['’]t mean to\b[^.]{0,40}/gi),
    ...text.matchAll(/\bnot that (?:he|she|they|it)\s+(?:was|were)\b[^.]{0,40}/gi)
  ].map((m) => m[0].trim());
  for (const e of motive) signals.push({ kind: 'motive_preemption', evidence: e.replace(/\s+/g, ' ').slice(0, 120) });

  // Feeling clarification: "felt X, not Y" — narrow (requires a perception verb
  // + adjective + ", not" + word) to stay a low-false-positive neutral signal.
  const feeling = [...text.matchAll(/\b(?:felt|feeling|feels|seemed|sounded|looked)\s+\w+,\s+not\s+\w+/gi)].map((m) => m[0].trim());
  for (const e of feeling) signals.push({ kind: 'feeling_clarification', evidence: e.slice(0, 120) });

  // Insistence / significance terms (narrator asserting meaning).
  const insist = INSISTENCE.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
  if (insist.length) signals.push({ kind: 'insistence_terms', evidence: insist.join(', '), count: insist.length });

  // Filler phrases (wordiness signal).
  const fillers = FILLERS.filter((p) => text.toLowerCase().includes(p));
  if (fillers.length) signals.push({ kind: 'filler_phrases', evidence: fillers.join('; '), count: fillers.length });

  // Fragment run (>=3 consecutive fragments used for emphasis).
  let frag = 0, fragMax = 0;
  for (const s of sentences) { if (wordCount(s) <= 3) { frag++; fragMax = Math.max(fragMax, frag); } else frag = 0; }
  if (fragMax >= 3) signals.push({ kind: 'fragment_run', evidence: `${fragMax} consecutive short sentences`, count: fragMax });

  // Repeated sentence openers (same first word 3+ times).
  const openers: Record<string, number> = {};
  for (const s of sentences) { const w = (s.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z’']/g, ''); if (w) openers[w] = (openers[w] ?? 0) + 1; }
  for (const [w, n] of Object.entries(openers)) if (n >= 3) signals.push({ kind: 'repeated_openers', evidence: `${n} sentences begin with "${w}"`, count: n });

  // Repeated content word (3+), excluding stopwords and character names.
  const freq: Record<string, number> = {};
  for (const raw of text.toLowerCase().split(/[^a-z’']+/)) {
    const w = raw.replace(/^['’]|['’]$/g, '');
    if (w.length < 4 || STOP.has(w) || names.has(w)) continue;
    freq[w] = (freq[w] ?? 0) + 1;
  }
  for (const [w, n] of Object.entries(freq)) if (n >= 3) signals.push({ kind: 'repeated_term', evidence: `"${w}" ×${n}`, count: n });

  return signals;
}

export function splitParagraphs(sectionId: string, content: string): { anchor: ParagraphAnchor; text: string }[] {
  const out: { anchor: ParagraphAnchor; text: string }[] = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g; // paragraphs = blank-line separated blocks
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(content))) {
    const text = m[0].trim();
    if (!text) continue;
    const h = hash(text.replace(/\s+/g, ' '));
    out.push({
      anchor: {
        id: `${sectionId}:p${index}:${h}`,
        index,
        char_start: m.index,
        char_end: m.index + m[0].length,
        text_hash: h,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 120)
      },
      text
    });
    index++;
  }
  return out;
}

export function computeVoiceBaseline(excerpts: string[]): VoiceBaseline | null {
  const paras = excerpts.flatMap((e) => splitParagraphs('baseline', e).map((p) => p.text));
  if (paras.length < 2) return null;
  let words = 0, sentences = 0, adverbs = 0, dialogueChars = 0, chars = 0, fragments = 0, commas = 0;
  for (const p of paras) {
    const st = paragraphStats(p);
    words += st.words; sentences += st.sentences; adverbs += st.adverb_ly; fragments += st.fragments;
    dialogueChars += st.dialogue_ratio * p.length; chars += p.length;
    commas += (p.match(/,/g) ?? []).length;
  }
  return {
    provenance: 'ai_derived',
    source: 'runtime_derived',
    note: 'Runtime voice baseline from approved manuscript excerpts. An inference for comparison, NOT canon and NOT an AI-detection claim.',
    sample_paragraphs: paras.length,
    avg_words_per_sentence: sentences ? +(words / sentences).toFixed(1) : 0,
    adverb_rate: words ? +(adverbs / words).toFixed(3) : 0,
    dialogue_ratio: chars ? +(dialogueChars / chars).toFixed(2) : 0,
    fragment_rate: sentences ? +(fragments / sentences).toFixed(3) : 0,
    comma_rate: sentences ? +(commas / sentences).toFixed(2) : 0,
    mean_paragraph_words: +(words / paras.length).toFixed(1)
  };
}

export function analyzeSectionProse(
  sectionId: string,
  content: string,
  opts: { baseline?: VoiceBaseline | null; characterNames?: string[] } = {}
): ProseSignalsReport {
  const names = new Set((opts.characterNames ?? []).map((n) => n.toLowerCase()));
  const paras = splitParagraphs(sectionId, content);
  const paragraphs: ParagraphReport[] = paras.map(({ anchor, text }) => {
    const stats = paragraphStats(text);
    // A majority-quoted paragraph is dialogue; annotate each signal so the host
    // is nudged to weigh deliberate spoken rhythm before flagging. Reuses the
    // dialogue ratio already computed — no schema, no extra pass.
    const in_dialogue = stats.dialogue_ratio >= 0.5;
    const signals = paragraphSignals(text, names).map((s) => ({ ...s, in_dialogue }));
    return { anchor, stats, signals };
  });

  // Section aggregate.
  const agg = paragraphs.reduce(
    (a, p) => {
      a.words += p.stats.words; a.sentences += p.stats.sentences; a.long_sentences += p.stats.long_sentences;
      a.fragments += p.stats.fragments; a.adverb_ly += p.stats.adverb_ly; a.max_sentence_words = Math.max(a.max_sentence_words, p.stats.max_sentence_words);
      a.dlg += p.stats.dialogue_ratio * p.anchor.excerpt.length; a.chars += p.anchor.excerpt.length;
      return a;
    },
    { words: 0, sentences: 0, long_sentences: 0, fragments: 0, adverb_ly: 0, max_sentence_words: 0, dlg: 0, chars: 0 }
  );
  const section_stats = {
    paragraphs: paragraphs.length,
    words: agg.words,
    sentences: agg.sentences,
    avg_words_per_sentence: agg.sentences ? +(agg.words / agg.sentences).toFixed(1) : 0,
    max_sentence_words: agg.max_sentence_words,
    long_sentences: agg.long_sentences,
    fragments: agg.fragments,
    adverb_ly: agg.adverb_ly,
    dialogue_ratio: agg.chars ? +(agg.dlg / agg.chars).toFixed(2) : 0
  };

  // Objective deltas vs baseline (host interprets whether a delta = drift).
  let drift_deltas: ProseSignalsReport['drift_deltas'] = null;
  const b = opts.baseline;
  if (b) {
    const adverbRate = section_stats.words ? +(section_stats.adverb_ly / section_stats.words).toFixed(3) : 0;
    const fragRate = section_stats.sentences ? +(section_stats.fragments / section_stats.sentences).toFixed(3) : 0;
    drift_deltas = {
      avg_words_per_sentence: { value: section_stats.avg_words_per_sentence, baseline: b.avg_words_per_sentence, delta: +(section_stats.avg_words_per_sentence - b.avg_words_per_sentence).toFixed(1) },
      adverb_rate: { value: adverbRate, baseline: b.adverb_rate, delta: +(adverbRate - b.adverb_rate).toFixed(3) },
      dialogue_ratio: { value: section_stats.dialogue_ratio, baseline: b.dialogue_ratio, delta: +(section_stats.dialogue_ratio - b.dialogue_ratio).toFixed(2) },
      fragment_rate: { value: fragRate, baseline: b.fragment_rate, delta: +(fragRate - b.fragment_rate).toFixed(3) }
    };
  }

  return { section_id: sectionId, paragraphs, section_stats, voice_baseline: b ?? null, drift_deltas, meta: { llm_used: false } };
}
