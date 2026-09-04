/**
 * Deterministic smoke test for the read-only MCP POC development layer.
 * No DB, no network, no LLM — pure functions over synthetic story state.
 * Proves: evidence/signals/candidate-items are emitted; NO arc-movement or
 * quality-judgment language leaks from the deterministic layer; module
 * selection is objective; server instructions carry only always-on modules.
 *
 * Run: npx tsx scripts/mcp-poc-smoke.mts
 */
import { analyzeStoryState, type AnalyzeInput } from '../src/lib/ai/development/analyzeStoryState.ts';
import {
  selectActiveModules,
  buildServerInstructions,
  METHODOLOGY_MODULES
} from '../src/lib/ai/methodology/modules.ts';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`);
  if (!cond) failures++;
};

const input: AnalyzeInput = {
  book: {
    title: 'Awakened',
    genre: 'Christian romance',
    pov: 'third limited',
    tense: 'past',
    description: 'A prophetic love story about trust and calling.',
    target_audience: 'Christian women',
    author_notes: 'Warm, interior, restrained. Faith woven in, never preachy.'
  },
  currentChapter: { id: 'ch5', title: 'The Sting of Sweetness', summary: null, chapter_number: 19 },
  chapterIndex: [
    { id: 'ch1', chapter_number: 14, sort_order: 0 },
    { id: 'ch5', chapter_number: 19, sort_order: 4 }
  ],
  previousChapterEnding: 'Timothy drove home without saying what he felt.\nThe porch light was still on.',
  sectionsSoFar: [{ content: 'Daniella waited.' }],
  currentSectionContent: 'She rehearsed the words she would not say.',
  threads: [
    // moved long ago (elapsed distance), has a planned payoff
    { id: 't1', book_id: 'b', title: 'Open Door', description: null, status: 'Active',
      first_chapter_id: 'ch1', last_chapter_id: 'ch1', planned_payoff: 'Timothy acts on the calling',
      author_notes: null, next_expected_beat: 'act' as any, next_expected_beat_note: null } as any,
    // never recorded a movement, planned payoff
    { id: 't2', book_id: 'b', title: 'Sting of Sweetness', description: null, status: 'Dormant',
      first_chapter_id: null, last_chapter_id: null, planned_payoff: 'she sees the cost of the easy yes',
      author_notes: null, next_expected_beat: null, next_expected_beat_note: null } as any
  ],
  relationships: [
    { id: 'r1', book_id: 'b', character_a_id: 'cA', character_b_id: 'cB', relationship_type: 'romance',
      current_status: 'guarded', history: 'met at church', unresolved_tension: 'neither has named it',
      last_meaningful_interaction: 'the unspoken porch goodbye', notes: null, updated_at: '' } as any
  ],
  characters: [
    { id: 'cA', book_id: 'b', name: 'Timothy', role: 'lead', personality: 'steady', goals: 'to obey the calling', fears: 'being wrong about her' } as any,
    { id: 'cB', book_id: 'b', name: 'Daniella', role: 'lead', personality: 'guarded', goals: 'to be chosen plainly', fears: 'settling' } as any
  ],
  settings: [],
  canonFacts: [
    { id: 'f1', book_id: 'b', fact: 'Daniella distrusts easy promises', fact_type: 'trait', subject_type: 'character', subject_id: 'cB', canon_status: 'author_canon', source_type: 'manual', reality_layer: 'unclassified', reader_knowledge: 'reader_knows', manuscript_status: 'confirmed_in_manuscript' } as any,
    { id: 'f2', book_id: 'b', fact: 'Foreshadow: the ring in the drawer', fact_type: 'note', subject_type: 'general', subject_id: null, canon_status: 'working_note', source_type: 'manual', reality_layer: 'unclassified', reader_knowledge: 'intentionally_hidden', manuscript_status: 'not_checked' } as any,
    { id: 'f3', book_id: 'b', fact: 'The city is coastal', fact_type: 'world', subject_type: 'book', subject_id: null, canon_status: 'author_canon', source_type: 'manual', reality_layer: 'physical_event', reader_knowledge: null, manuscript_status: 'confirmed_in_manuscript' } as any,
    { id: 'f4', book_id: 'b', fact: 'Timothy dreamed of an open door', fact_type: 'event', subject_type: 'character', subject_id: 'cA', canon_status: 'author_canon', source_type: 'manual', reality_layer: 'dream', reader_knowledge: 'reader_knows', manuscript_status: 'confirmed_in_manuscript' } as any
  ],
  timelineEvents: [],
  outlineNodePurpose: 'Bring the unspoken into the open',
  chapterOutline: { purpose: 'They edge toward naming it', chapter_end_state: 'They name what is between them', new_questions_created: 'Does Daniella believe him?\nWhat does Timothy risk?' },
  approvedVoiceExcerpts: ['She rehearsed the words she would not say.']
};

const a = analyzeStoryState(input);
const blob = JSON.stringify(a);

check('emits candidate_items_for_attention', a.candidate_items_for_attention.length >= 2);
check('thread t1 has elapsed distance = 4', a.threads.find((t) => t.id === 't1')?.elapsed_chapters_since_recorded_movement === 4);
check('thread t2 has null elapsed (no recorded movement)', a.threads.find((t) => t.id === 't2')?.elapsed_chapters_since_recorded_movement === null);
check('relationship tension surfaced as candidate', a.candidate_items_for_attention.some((c) => c.kind === 'relationship_with_recorded_tension'));
check('character_facts carry facts-only note, no movement claim', a.character_facts.every((c) => /Facts only/.test(c.note)) && a.character_facts.length === 2);
check('setup/payoff signals present and labeled heuristic', a.setup_payoff_signals.length >= 2 && a.setup_payoff_signals.every((s) => /[Hh]euristic/.test(s.note)));
check('information_state populated (reader_knowledge)', a.information_state.length >= 1);
check('world_rules populated (book-subject physical_event)', a.world_rules.some((w) => /coastal/.test(w.fact)));
check('dream_revelation populated (reality_layer dream)', a.dream_revelation.some((d) => /open door/i.test(d.fact)));
check('development_decisions = author_canon only', a.development_decisions.every((d) => d.canon_status === 'author_canon'));
check('working_notes = working_note only', a.working_notes.length === 1);
check('open_questions include outline questions', a.open_questions.some((q) => /believe him/i.test(q)));
check('voice is ai_derived / runtime (not canon)', a.identity.voice.provenance === 'ai_derived' && a.identity.voice.source === 'runtime_derived');

// The correction: NO literary-judgment / arc-movement wording from deterministic layer.
const forbidden = ["hasn't moved", 'has not moved', 'stalled', 'underdeveloped', 'arc progressed', 'arc moved', 'badly written', 'feels slow', 'poorly', 'weak'];
const leaked = forbidden.filter((w) => blob.toLowerCase().includes(w.toLowerCase()));
check(`no forbidden judgment/arc-movement wording (leaked: ${JSON.stringify(leaked)})`, leaked.length === 0);

// Module selection is objective.
const autoModules = selectActiveModules({ scope: 'section', focus: 'auto', signals: a.presence });
check('auto focus attaches threads+relationships+arc playbooks (presence-based)',
  autoModules.includes('play.threads') && autoModules.includes('play.relationships') && autoModules.includes('play.characterArc'));
check('dream focus attaches dream playbook', selectActiveModules({ scope: 'section', focus: 'dream', signals: a.presence }).includes('play.dreams'));
check('arc focus attaches characterArc, not relationships', (() => { const m = selectActiveModules({ scope: 'section', focus: 'arc', signals: a.presence }); return m.includes('play.characterArc') && !m.includes('play.relationships'); })());

// Server instructions = always-on only (modular; situational playbooks excluded).
const instr = buildServerInstructions();
check('server instructions include master rules + development mode', instr.includes(METHODOLOGY_MODULES['rules.master'].slice(0, 30)) && instr.includes('DEVELOPMENT MODE'));
check('server instructions EXCLUDE situational playbooks (threads/dreams)', !instr.includes('THREAD RESOLUTION play') && !instr.includes('DREAM / REVELATION DEVELOPMENT play'));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — llm_used never set by analyzer (pure function).`);
process.exit(failures === 0 ? 0 : 1);
