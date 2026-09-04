/**
 * Prose-signals foundation + author-avoidance detector tests. Deterministic
 * detectors emit pattern EVIDENCE only (no verdicts, no AI-detection). Includes
 * a LIVE scan of real Awakened prose. Run: npx tsx scripts/prose-signals.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { analyzeSectionProse } from '../src/lib/ai/development/proseSignals.ts';

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`); if (!cond) failures++; };

// Each case is its own paragraph (blank-line separated). Returns the signal kinds for para 0.
function kindsOf(paragraph: string): { kinds: string[]; inDialogue: boolean } {
  const r = analyzeSectionProse('t', paragraph, { characterNames: [] });
  const p = r.paragraphs[0];
  return { kinds: (p?.signals ?? []).map((s) => s.kind), inDialogue: !!p?.signals[0]?.in_dialogue };
}

// --- motive_preemption: all four connector forms ---------------------------
check('motive: but form', kindsOf('Not because she was suspicious, but because she wanted to be discerning.').kinds.includes('motive_preemption'));
check('motive: em-dash form', kindsOf('Not because something is wrong with you—because God built you to carry it.').kinds.includes('motive_preemption'));
check('motive: semicolon form', kindsOf('Not because she was tired; because she was scared of the answer.').kinds.includes('motive_preemption'));
check('motive: sentence-break form', kindsOf('She stayed. Not because she wanted to. Because she had to.').kinds.includes('motive_preemption'));

// --- contrastive-negation family -------------------------------------------
check('contrastive: It wasn’t X. It was Y.', kindsOf('It wasn’t fear. It was something deeper.').kinds.includes('contrastive_negation'));
check('contrastive: didn’t need X. needed Y.', kindsOf('She didn’t need answers. She needed peace.').kinds.includes('contrastive_negation'));
check('contrastive: wasn’t X. Not really.', kindsOf('She wasn’t angry. Not really.').kinds.includes('contrastive_negation'));
check('contrastive: thematic "It was not X, but Y"', kindsOf('It was not about being right, but about being heard.').kinds.includes('contrastive_negation'));

// --- emphatic negation stack + feeling clarification -----------------------
check('emphatic_negation_run: Not X. Not Y. Just Z.', kindsOf('Not “perfect.” Not manufactured. Just grounded.').kinds.includes('emphatic_negation_run'));
check('feeling_clarification: felt X, not Y', kindsOf('She felt nervous, not fearful, as she walked in.').kinds.includes('feeling_clarification'));

// --- in_dialogue hint -------------------------------------------------------
check('in_dialogue TRUE inside quoted speech', kindsOf('“It was not fear, but something deeper,” she said quietly to herself.').inDialogue === true);
check('in_dialogue FALSE in narration', kindsOf('It wasn’t fear. It was something deeper.').inDialogue === false);

// --- negative controls: ordinary standalone negation must NOT match --------
const avoid = new Set(['motive_preemption', 'contrastive_negation', 'emphatic_negation_run', 'feeling_clarification']);
for (const control of ['He wasn’t home.', 'She didn’t answer.', 'No one came.', 'They weren’t ready for the storm.']) {
  const k = kindsOf(control).kinds;
  check(`negative control ignored: "${control}"`, !k.some((x) => avoid.has(x)));
}
// Ordinary functional contrast must NOT be strong-flagged as author-avoidance.
for (const control of ['She called not to take him back, but to clear the air.', 'He came to apologize, not to argue.', 'The weapons are not carnal, but mighty through God.']) {
  const k = kindsOf(control).kinds;
  check(`ordinary contrast NOT strong-flagged: "${control.slice(0, 34)}…"`, !k.includes('contrastive_negation'));
}

// --- LIVE scan of real Awakened prose --------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  const sb = createClient<Database>(url, key, { auth: { persistSession: false } });
  const BOOK = '69c4e5ca-2529-4aab-9126-32873894d804';
  const { data: chapters } = await sb.from('chapters').select('id, chapter_number').eq('book_id', BOOK);
  const numById = new Map((chapters ?? []).map((c) => [c.id, c.chapter_number] as const));
  const { data: secs } = await sb.from('writing_sections').select('id, chapter_id, content').in('chapter_id', (chapters ?? []).map((c) => c.id));
  const found: { ch: number | null | undefined; kind: string; ev: string; dlg: boolean }[] = [];
  let paragraphs = 0;
  for (const s of secs ?? []) {
    const r = analyzeSectionProse(s.id, s.content ?? '', { characterNames: [] });
    paragraphs += r.paragraphs.length;
    for (const p of r.paragraphs) for (const sig of p.signals)
      if (avoid.has(sig.kind)) found.push({ ch: numById.get(s.chapter_id), kind: sig.kind, ev: sig.evidence, dlg: !!sig.in_dialogue });
  }
  const byKind: Record<string, number> = {};
  for (const f of found) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  console.log(`\n=== LIVE scan: ${paragraphs} paragraphs across the book ===`);
  console.log('author-avoidance signals by kind:', JSON.stringify(byKind));
  console.log('narration (in_dialogue=false) sample:');
  for (const f of found.filter((x) => !x.dlg).slice(0, 8)) console.log(`  [Ch${f.ch}] ${f.kind}: ${f.ev.slice(0, 70)}`);
  console.log('dialogue (in_dialogue=true) sample:');
  for (const f of found.filter((x) => x.dlg).slice(0, 4)) console.log(`  [Ch${f.ch}] ${f.kind}: ${f.ev.slice(0, 70)}`);
  check('LIVE: found real author-avoidance patterns', found.length > 0);
} else {
  console.log('\n(LIVE scan skipped — no service key)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
