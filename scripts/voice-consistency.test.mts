/**
 * Whole-manuscript voice-consistency engine (deterministic, no DB, no LLM).
 * Run: npx tsx scripts/voice-consistency.test.mts
 */
import { computeVoiceConsistency, type VoiceSectionInput } from '../src/lib/ai/review/voiceConsistency.ts';

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) fail++; };

// Long narration, ~22-word sentences, little dialogue, no fragments.
const narration = (seed: string) =>
  Array.from({ length: 9 }, (_, i) =>
    `The ${seed} moved quietly through the long corridor while she considered what the message from the council might mean for number ${i}.`
  ).join(' ');

// Dialogue-heavy: many short quoted fragments — high dialogue ratio, many
// fragments, tiny average sentence length.
const dialogue = Array.from({ length: 40 }, () => `"No." "Wait." "Why?" "Because." "I can't." "You have to." "Not now."`).join(' ');

const sec = (id: string, ch: number, content: string): VoiceSectionInput => ({ section_id: id, chapter_id: `c${ch}`, chapter_number: ch, title: `Ch${ch}`, content });

// --- Consistent book: five similar narration sections ---
const consistent = computeVoiceConsistency([
  sec('s1', 1, narration('shadow')), sec('s2', 2, narration('figure')),
  sec('s3', 3, narration('stranger')), sec('s4', 4, narration('visitor')), sec('s5', 5, narration('watcher'))
]);
check('consistent book → status ok', consistent.status === 'ok');
check('consistent book → no outliers, consistent=true', consistent.summary.consistent === true && consistent.outliers.length === 0);
check('consistent book → baseline computed', consistent.book_baseline !== null && consistent.book_baseline!.avg_words_per_sentence > 10);

// --- One clearly different (dialogue/fragment-heavy) section is flagged ---
const withOutlier = computeVoiceConsistency([
  sec('s1', 1, narration('shadow')), sec('s2', 2, narration('figure')),
  sec('s3', 3, narration('stranger')), sec('s4', 4, narration('visitor')),
  sec('s5', 5, dialogue)
]);
check('outlier book → exactly 1 outlier surfaced', withOutlier.outliers.length === 1);
check('outlier book → it is the dialogue section (s5)', withOutlier.outliers[0]?.section_id === 's5');
check('outlier book → cites specific drifting metrics', (withOutlier.outliers[0]?.reasons.length ?? 0) >= 1);
check('outlier book → flags dialogue and/or sentence-length difference', withOutlier.outliers[0]!.reasons.some((r) => ['dialogue_ratio', 'avg_words_per_sentence', 'fragment_rate'].includes(r.metric)));
check('outlier book → wording is a question, never a verdict', /worth a look|intentional/i.test(withOutlier.outliers[0]!.question) && !/\bbad\b|wrong|AI-|poor/i.test(JSON.stringify(withOutlier.outliers[0])));
check('outlier book → normal sections not flagged', withOutlier.sections.filter((s) => s.outlier).length === 1);

// --- Insufficient text ---
const thin = computeVoiceConsistency([sec('s1', 1, narration('shadow')), sec('s2', 2, 'Too short.')]);
check('insufficient → status insufficient_text', thin.status === 'insufficient_text' && thin.summary.consistent === true);

// --- Short sections excluded from comparison but still counted ---
const withShort = computeVoiceConsistency([
  sec('s1', 1, narration('a')), sec('s2', 2, narration('b')), sec('s3', 3, narration('c')),
  sec('s4', 4, 'A short stub of a section.')
]);
check('short section excluded from comparison', withShort.status === 'ok' && withShort.compared_count === 3 && withShort.section_count === 4);
check('short section is not an outlier', !withShort.sections.find((s) => s.section_id === 's4')?.outlier);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
