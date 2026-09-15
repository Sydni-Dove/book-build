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

// --- Voice Pass swaps: stacked intensity, abstract description, long speech --
// Swap #1 — ornamental intensifiers travelling in groups.
check('intensity: stacked in one sentence', kindsOf('The walls stretched endlessly, lined with gleaming weapons and shining armor.').kinds.includes('stacked_intensity'));
check('intensity: spread across a paragraph', kindsOf('She stood in a vast armory. The light was dazzling. The ceiling was towering.').kinds.includes('stacked_intensity'));
check('intensity: single ornamental word NOT flagged', !kindsOf('The garment was dazzling white.').kinds.includes('stacked_intensity'));
// Swap #3 — a person described in abstractions instead of behavior.
check('descriptor: "imposing yet warm"', kindsOf('His presence was imposing yet warm, and people trusted him.').kinds.includes('abstract_descriptor'));
check('descriptor: two abstractions in one sentence', kindsOf('She was regal, statuesque, and everyone noticed.').kinds.includes('abstract_descriptor'));
check('descriptor: ordinary yet/but NOT flagged', !kindsOf('It was raining but she went anyway.').kinds.includes('abstract_descriptor'));
// Swap #2A — long DIVINE / prophetic speech (flag), short divine speech (silent),
// and ordinary long dramatic dialogue with no divine cue (silent).
check('divine: long declaration flagged', kindsOf('"You are a wonder to the world. You will stand before leaders and rulers. Leadership rests on you like a garment. I give you access to the King."').kinds.includes('long_divine_speech'));
check('divine: first-person markers flagged', kindsOf('"With Me all things are possible. You have My angels backing you. My Spirit is always in you. Boldly declare My Name."').kinds.includes('long_divine_speech'));
check('divine: short divine speech NOT flagged', !kindsOf('"Be not afraid, my daughter," He said.').kinds.includes('long_divine_speech'));
check('divine: long ordinary dramatic dialogue NOT flagged', !kindsOf('"I waited for you at the station for an hour. I called twice and you never picked up. I thought something had happened to you. I was terrified, and you just forgot. How could you do that to me again?"').kinds.some((k) => k === 'long_divine_speech' || k === 'long_teaching_speech'));
// Swap #2B — long TEACHING dialogue (character explaining/interpreting).
check('teaching: long quoted teaching flagged', kindsOf('"The armor of God is not literal. Each piece represents a spiritual truth. The belt of truth means honesty before God. The breastplate stands for the righteousness given by grace. This is why Paul lists them in order for us."').kinds.includes('long_teaching_speech'));
// Swap #4 — long UNQUOTED teaching / exposition run (narration) flags; concrete
// action and concrete description stay silent.
check('exposition: narrated teaching run flagged', kindsOf('The armor of God is not literal. Each piece represents a spiritual truth. The belt of truth means honesty before God. The breastplate represents the righteousness given by grace. This is why the order matters, and therefore the believer puts on each piece daily.').kinds.includes('long_exposition_run'));
check('exposition: concrete action NOT flagged', !kindsOf('She ran down the hall. The door slammed behind her. Her bag caught on the railing. She yanked it free and kept going. The stairwell was dark.').kinds.includes('long_exposition_run'));
check('exposition: narrative causation NOT flagged', !kindsOf('She left because she was tired. She cried because it hurt. She stayed home because the roads were bad. She called because she missed him. She waited because she had to.').kinds.includes('long_exposition_run'));
// Generic scene-setting — stock dramatic shorthand flags; concrete scene-specific
// sensory detail stays silent.
check('scene-setting: "her heart pounded" flagged', kindsOf('She reached the top step and her heart pounded.').kinds.includes('generic_scene_setting'));
check('scene-setting: "the wind howled" flagged', kindsOf('The wind howled through the empty streets.').kinds.includes('generic_scene_setting'));
check('scene-setting: concrete sensory detail NOT flagged', !kindsOf('The hallway smelled faintly of coffee, old hymnals, and wood polish.').kinds.includes('generic_scene_setting'));

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
