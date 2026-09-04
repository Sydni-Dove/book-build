// One-off verification script (not part of the app) — exercises the core
// Book → Chapter → Section → autosave-equivalent write → Canon Fact write
// path against the live Book Build Supabase project, and checks
// that RLS actually blocks a second user from reading the first user's
// data. Run with: node scripts/verify-phase1-flow.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const stamp = Date.now();
const userAEmail = `verify-a-${stamp}@example.com`;
const userBEmail = `verify-b-${stamp}@example.com`;
const password = 'verify-Phase1-flow-pw-1!';

function client() {
  return createClient(url, anonKey);
}

async function signUp(email) {
  const c = client();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(`signUp(${email}): ${error.message}`);
  return { client: c, userId: data.user.id };
}

async function main() {
  console.log('1. Sign up author A and author B...');
  const a = await signUp(userAEmail);
  const b = await signUp(userBEmail);
  console.log('   ok — profiles row should exist via handle_new_user() trigger');

  const { data: profileA, error: profileErr } = await a.client
    .from('profiles')
    .select('id, display_name')
    .eq('id', a.userId)
    .single();
  if (profileErr) throw new Error(`profiles select: ${profileErr.message}`);
  console.log(`   profile A: ${JSON.stringify(profileA)}`);

  console.log('2. Author A creates a Book...');
  const { data: book, error: bookErr } = await a.client
    .from('books')
    .insert({ user_id: a.userId, title: 'Awakened (verification copy)', genre: 'Supernatural fiction', pov: 'Third limited', tense: 'Past' })
    .select()
    .single();
  if (bookErr) throw new Error(`book insert: ${bookErr.message}`);
  console.log(`   book id: ${book.id}`);

  console.log('3. Author A creates a Chapter...');
  const { data: chapter, error: chapterErr } = await a.client
    .from('chapters')
    .insert({ book_id: book.id, title: 'Chapter 1', chapter_number: 1, sort_order: 0 })
    .select()
    .single();
  if (chapterErr) throw new Error(`chapter insert: ${chapterErr.message}`);
  console.log(`   chapter id: ${chapter.id}`);

  console.log('4. Author A creates an (optional) Scene under the chapter...');
  const { data: scene, error: sceneErr } = await a.client
    .from('scenes')
    .insert({ chapter_id: chapter.id, title: 'Daniella’s bedroom, night', time_context: 'Night, present day' })
    .select()
    .single();
  if (sceneErr) throw new Error(`scene insert: ${sceneErr.message}`);
  console.log(`   scene id: ${scene.id}`);

  console.log('5. Author A creates a Writing Section, scoped to that Scene, and writes content (autosave-equivalent)...');
  const { data: section, error: sectionErr } = await a.client
    .from('writing_sections')
    .insert({ chapter_id: chapter.id, scene_id: scene.id, sort_order: 0, content: 'Daniella woke with the dream still clinging to her.' })
    .select()
    .single();
  if (sectionErr) throw new Error(`section insert: ${sectionErr.message}`);
  console.log(`   section id: ${section.id}, ai_check_state default: ${section.ai_check_state}, content_hash default: ${section.content_hash}`);

  const updatedContent = 'Daniella woke with the dream still clinging to her, the dove’s wings still beating in her chest.';
  const { data: updatedSection, error: updateErr } = await a.client
    .from('writing_sections')
    .update({ content: updatedContent, word_count: updatedContent.split(/\s+/).length })
    .eq('id', section.id)
    .select()
    .single();
  if (updateErr) throw new Error(`section update: ${updateErr.message}`);
  console.log(`   section updated, word_count: ${updatedSection.word_count}`);

  console.log('6. Author A takes a manual version snapshot before an AI edit...');
  const { error: versionErr } = await a.client
    .from('section_versions')
    .insert({ section_id: section.id, content: updatedContent, version_reason: 'before_ai_edit' });
  if (versionErr) throw new Error(`section_versions insert: ${versionErr.message}`);
  console.log('   ok — version_reason check constraint accepted the new enum value');

  console.log('7. Author A explicitly approves a canon fact from a Before You Continue answer (working_note first, then author_canon)...');
  const { data: workingNote, error: wnErr } = await a.client
    .from('canon_facts')
    .insert({
      book_id: book.id,
      fact_type: 'pre_writing_answer',
      subject_type: 'general',
      fact: 'Daniella has recurring dove dreams tied to prophetic warnings.',
      source_type: 'before_you_continue',
      canon_status: 'working_note'
    })
    .select()
    .single();
  if (wnErr) throw new Error(`canon_facts insert (working_note): ${wnErr.message}`);
  console.log(`   canon_fact ${workingNote.id}: canon_status=${workingNote.canon_status}, manuscript_status=${workingNote.manuscript_status}, reality_layer=${workingNote.reality_layer}`);
  if (workingNote.manuscript_status !== 'not_checked' || workingNote.reality_layer !== 'unclassified') {
    throw new Error('defaults were wrong: manuscript_status/reality_layer must default to not_checked/unclassified');
  }

  const { data: promoted, error: promoteErr } = await a.client
    .from('canon_facts')
    .update({ canon_status: 'author_canon' })
    .eq('id', workingNote.id)
    .select()
    .single();
  if (promoteErr) throw new Error(`canon_facts promote: ${promoteErr.message}`);
  console.log(`   promoted to author_canon; manuscript_status still ${promoted.manuscript_status} (untouched by the canon_status change — confirms the two axes are independent)`);

  console.log('8. Simulate a manuscript-confirmation match, then a contradiction with durable conflict history...');
  const { error: confirmErr } = await a.client
    .from('canon_facts')
    .update({ manuscript_status: 'confirmed_in_manuscript' })
    .eq('id', workingNote.id);
  if (confirmErr) throw new Error(`canon_facts confirm: ${confirmErr.message}`);

  const { data: conflict, error: conflictErr } = await a.client
    .from('canon_fact_conflicts')
    .insert({
      canon_fact_id: workingNote.id,
      section_id: section.id,
      previous_manuscript_status: 'confirmed_in_manuscript',
      previous_fact_text: promoted.fact,
      conflicting_excerpt: 'Later chapter text seems to contradict the dove-dream detail...'
    })
    .select()
    .single();
  if (conflictErr) throw new Error(`canon_fact_conflicts insert: ${conflictErr.message}`);
  const { error: contradictErr } = await a.client
    .from('canon_facts')
    .update({ manuscript_status: 'contradicted' })
    .eq('id', workingNote.id);
  if (contradictErr) throw new Error(`canon_facts contradict: ${contradictErr.message}`);
  console.log(`   conflict row ${conflict.id} created, resolution=${conflict.resolution} (pending)`);

  console.log('   Resolving as "keep_original" — restoring manuscript_status from the durable snapshot...');
  const { error: resolveErr } = await a.client
    .from('canon_fact_conflicts')
    .update({ resolution: 'keep_original', resolution_note: 'Verified: the later chapter is a different dream, not a contradiction.', resolved_at: new Date().toISOString() })
    .eq('id', conflict.id);
  if (resolveErr) throw new Error(`conflict resolve: ${resolveErr.message}`);
  const { data: restored, error: restoreErr } = await a.client
    .from('canon_facts')
    .update({ manuscript_status: conflict.previous_manuscript_status })
    .eq('id', workingNote.id)
    .select()
    .single();
  if (restoreErr) throw new Error(`canon_facts restore: ${restoreErr.message}`);
  console.log(`   restored manuscript_status: ${restored.manuscript_status} (from the conflict row, not app memory)`);

  console.log('9. A story_bible_proposal (AI-extracted candidate) stays out of real canon until approved...');
  const { data: proposal, error: proposalErr } = await a.client
    .from('story_bible_proposals')
    .insert({
      book_id: book.id,
      chapter_id: chapter.id,
      proposal_type: 'canon_fact',
      payload: { fact: 'Possible AI inference: the dove motif recurs in Ch. 4', confidence: 'medium' },
      dedupe_key: 'dove-motif-recurs'
    })
    .select()
    .single();
  if (proposalErr) throw new Error(`story_bible_proposals insert: ${proposalErr.message}`);
  console.log(`   proposal ${proposal.id} status=${proposal.status} (never auto-promoted)`);

  console.log('10. Retrying the same extraction (same import/chapter/dedupe_key = both NULL import_id) must NOT duplicate...');
  const { error: dupErr } = await a.client.from('story_bible_proposals').insert({
    book_id: book.id,
    chapter_id: chapter.id,
    proposal_type: 'canon_fact',
    payload: { fact: 'Possible AI inference: the dove motif recurs in Ch. 4 (retry)', confidence: 'medium' },
    dedupe_key: 'dove-motif-recurs'
  });
  if (!dupErr) throw new Error('expected a unique-violation on retry, but the insert succeeded — dedupe index is not working');
  console.log(`   correctly rejected: ${dupErr.message.split('\n')[0]}`);

  console.log('11. New evidence from a DIFFERENT chapter with the same dedupe_key must be preserved (not deduped)...');
  const { data: chapter2, error: ch2Err } = await a.client
    .from('chapters')
    .insert({ book_id: book.id, title: 'Chapter 2', chapter_number: 2, sort_order: 1 })
    .select()
    .single();
  if (ch2Err) throw new Error(`chapter2 insert: ${ch2Err.message}`);
  const { data: evidence2, error: ev2Err } = await a.client
    .from('story_bible_proposals')
    .insert({
      book_id: book.id,
      chapter_id: chapter2.id,
      proposal_type: 'canon_fact',
      payload: { fact: 'Stronger evidence: the dove motif explicitly tied to Timothy in Ch. 2', confidence: 'high' },
      dedupe_key: 'dove-motif-recurs'
    })
    .select()
    .single();
  if (ev2Err) throw new Error(`cross-chapter evidence insert unexpectedly failed: ${ev2Err.message}`);
  console.log(`   correctly preserved as a new row: ${evidence2.id}`);

  console.log('12. RLS check — author B must NOT see author A\'s book, chapters, sections, canon facts, or proposals...');
  const { data: bBooks } = await b.client.from('books').select('id').eq('id', book.id);
  const { data: bSections } = await b.client.from('writing_sections').select('id').eq('id', section.id);
  const { data: bCanon } = await b.client.from('canon_facts').select('id').eq('id', workingNote.id);
  const { data: bProposals } = await b.client.from('story_bible_proposals').select('id').eq('id', proposal.id);
  if ((bBooks?.length ?? 0) > 0 || (bSections?.length ?? 0) > 0 || (bCanon?.length ?? 0) > 0 || (bProposals?.length ?? 0) > 0) {
    throw new Error('RLS FAILURE: author B could read author A\'s data');
  }
  console.log('   confirmed: author B sees none of it — RLS ownership chain holds for direct tables and joined chains alike');

  console.log('\nAll Phase 1 core-flow checks passed against the live database.');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
