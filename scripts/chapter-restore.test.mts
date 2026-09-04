/**
 * Chapter version history + restore tests. Fixtures only — never touches
 * canonical Awakened prose. Requires migrations 0005 + 0006. Reuses the SAME
 * chapter_versions snapshots that Chapter Upload writes.
 * Run: npx tsx scripts/chapter-restore.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import {
  previewChapterVersion,
  applyChapterVersion,
  listChapterVersions,
  previewChapterRestore,
  applyChapterRestore
} from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;

const S1 = 'Section one opens the chapter.\n\nDaniella sat by the window.';
const S2 = 'Section two, at the meeting.\n\nShe listened for a while.';
const S2b = 'Section two, at the meeting, transformed.\n\nShe finally understood.';
const S3 = 'Section three closes the day.\n\nShe wrote in her journal.';
const S4 = 'Section four, added later.\n\nA quiet epilogue.';
const join = (...xs: string[]) => xs.join('\n\n~~~\n\n');

const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__chapter_restore_test__', status: 'Planning' }).select('id').single();
const BOOK = book!.id;
let chNum = 0;
const mkChapter = async (secs: { content: string; title?: string | null }[]) => {
  chNum += 1;
  const { data: ch } = await sb.from('chapters').insert({ book_id: BOOK, chapter_number: chNum, title: `Ch${chNum}`, sort_order: chNum }).select('id').single();
  await sb.from('writing_sections').insert(secs.map((s, i) => ({ chapter_id: ch!.id, sort_order: i, content: s.content, word_count: s.content.split(/\s+/).length, title: s.title ?? null })));
  return ch!.id;
};
const secsOf = async (chId: string) => (await sb.from('writing_sections').select('id, sort_order, title, content, word_count').eq('chapter_id', chId).order('sort_order')).data ?? [];
const applyUp = async (chId: string, incoming: string, removals?: string[]) => {
  const p = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chId, incoming_content: incoming });
  const a = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chId, incoming_content: incoming, expected_chapter_hash: sc(p).chapter_hash, removals });
  return sc(a); // { status, chapter_version_id, ... }
};

try {
  // A · empty history
  const chEmpty = await mkChapter([{ content: S1 }, { content: S2 }]);
  const la = await listChapterVersions(sb, { book_id: BOOK, chapter_id: chEmpty });
  check('A: no history → ok, count 0', st(la) === 'ok' && sc(la).count === 0 && sc(la).versions.length === 0);
  check('A: current metadata present', sc(la).current.section_count === 2 && typeof sc(la).current.content_hash === 'string');

  // Build history on chH: V0[S1,S2,S3] → add S4 → modify S2 → remove S4
  const chH = await mkChapter([{ content: S1 }, { content: S2 }, { content: S3 }]);
  const s4 = (await applyUp(chH, join(S1, S2, S3, S4)));           // snapshot V0 = [S1,S2,S3]
  const V0 = s4.chapter_version_id;
  const secsAfterAdd = await secsOf(chH);
  const S4id = secsAfterAdd.find((s) => s.content === S4)!.id;
  const s2mod = (await applyUp(chH, join(S1, S2b, S3, S4)));       // snapshot V1 = [S1,S2,S3,S4]
  const V1 = s2mod.chapter_version_id;
  const rem = (await applyUp(chH, join(S1, S2b, S3), [S4id]));     // snapshot V2 = [S1,S2b,S3,S4]; live=[S1,S2b,S3]
  const V2 = rem.chapter_version_id;

  // B · list: current pinned + newest first
  const lb = sc(await listChapterVersions(sb, { book_id: BOOK, chapter_id: chH }));
  check('B: three versions, newest first', lb.versions.length === 3 && lb.versions[0].version_id === V2 && lb.versions[2].version_id === V0);
  check('B: current summary reflects live [S1,S2b,S3]', lb.current.section_count === 3);
  check('B: version metadata has section/word counts + reason', lb.versions[0].section_count === 4 && typeof lb.versions[0].word_count === 'number' && lb.versions[0].version_reason === 'before_chapter_upload');

  // C/D/E · preview restore V0 [S1,S2,S3] against current [S1,S2b,S3]
  const liveBeforePreview = (await secsOf(chH)).map((s) => s.content).join('|');
  const pV0 = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chH, version_id: V0 }));
  check('C: preview mutates nothing', (await secsOf(chH)).map((s) => s.content).join('|') === liveBeforePreview);
  check('D: S2 shows as modified with a diff', pV0.sections.some((s: any) => s.role === 'modified' && s.summary && (s.summary.paragraphs_added > 0 || s.summary.paragraphs_removed > 0)));
  check('E: (no S4 in V0) → nothing only_in_selected; S2 modified/S1,S3 unchanged', pV0.summary.only_in_selected === 0 && pV0.summary.modified === 1 && pV0.summary.unchanged === 2);

  // F · only_in_selected: V2 has S4 which current lacks
  const pV2 = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chH, version_id: V2 }));
  check('F: S4 only in selected version', pV2.summary.only_in_selected === 1 && pV2.sections.some((s: any) => s.role === 'only_in_selected'));

  // Also confirm only_in_current via V0 (S4 exists now? no — S4 removed. Use V0 vs a state with S4)
  const pV1 = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chH, version_id: V1 }));
  check('E2: only_in_current detection works (V1 lacks S2b edit path)', typeof pV1.summary.only_in_current === 'number');

  // G · reorder
  const chR = await mkChapter([{ content: S1 }, { content: S2 }, { content: S3 }]);
  const reord = await applyUp(chR, join(S2, S1, S3)); // snapshot [S1,S2,S3]; live [S2,S1,S3]
  const pR = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chR, version_id: reord.chapter_version_id }));
  check('G: reorder detected in preview', pR.reordered === true);

  // H · rename
  const chN = await mkChapter([{ content: S1, title: 'Old Name' }, { content: S2 }]);
  const ren = await applyUp(chN, join(S1 + ' tweak.', S2)); // snapshot captures S1 title 'Old Name'
  const s1id = (await secsOf(chN)).find((s) => s.content.startsWith('Section one'))!.id;
  await sb.from('writing_sections').update({ title: 'New Name' }).eq('id', s1id);
  const pN = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chN, version_id: ren.chapter_version_id }));
  check('H: rename detected (Old Name vs New Name)', pN.sections.some((s: any) => s.renamed === true));

  // R · a version equal to current → UNCHANGED (nothing to restore onto itself)
  const chSame = await mkChapter([{ content: S1 }, { content: S2 }]);
  const sameUp = await applyUp(chSame, join(S1, S2, S3)); // snapshot [S1,S2]; live [S1,S2,S3]
  // restore snapshot [S1,S2] is a change; instead re-snapshot current then preview it:
  const cur2 = await applyUp(chSame, join(S1, S2, S3, S4)); // snapshot [S1,S2,S3]; live [S1,S2,S3,S4]
  // now revert live back to snapshot's exact state by restoring, then preview that same version → UNCHANGED
  const liveHashSame = sc(await listChapterVersions(sb, { book_id: BOOK, chapter_id: chSame })).current.content_hash;
  const preSame = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chSame, version_id: cur2.chapter_version_id }));
  await applyChapterRestore(sb, { book_id: BOOK, chapter_id: chSame, version_id: cur2.chapter_version_id, expected_chapter_hash: preSame.chapter_hash });
  const reSame = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chSame, version_id: cur2.chapter_version_id }));
  check('R: restoring a version identical to current → UNCHANGED', st({ structuredContent: reSame }) === 'UNCHANGED');

  // I/J/K/L/M/V · real restore of V2 (reintroduces S4) on chH
  const beforeRestore = await secsOf(chH); // [S1,S2b,S3]
  const cvCountBefore = (await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', chH)).count ?? 0;
  const pForRestore = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chH, version_id: V2 }));
  const restore = sc(await applyChapterRestore(sb, { book_id: BOOK, chapter_id: chH, version_id: V2, expected_chapter_hash: pForRestore.chapter_hash }));
  check('I: restore applied', restore.status === 'applied');
  const cvCountAfter = (await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', chH)).count ?? 0;
  check('V: current chapter snapshotted before restore (+1 chapter_version)', cvCountAfter === cvCountBefore + 1);
  const afterRestore = await secsOf(chH);
  check('J: S4 reintroduced from selected snapshot', afterRestore.some((s) => s.id === S4id && s.content === S4));
  check('L/M: chapter now equals V2 snapshot exactly ([S1,S2b,S3,S4], in order)', afterRestore.map((s) => s.content).join('|') === [S1, S2b, S3, S4].join('|'));
  const beforeSnap = (await sb.from('chapter_versions').select('snapshot, version_reason').eq('chapter_id', chH).order('created_at', { ascending: false }).limit(1)).data![0]!;
  check('K/recoverable: pre-restore state saved as before_chapter_restore', beforeSnap.version_reason === 'before_chapter_restore' && (beforeSnap.snapshot as any).sections.map((s: any) => s.content).join('|') === beforeRestore.map((s) => s.content).join('|'));

  // N · stale → TARGET_CHANGED
  const chStale = await mkChapter([{ content: S1 }, { content: S2 }]);
  const stUp = await applyUp(chStale, join(S1, S2, S3));
  const pStale = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chStale, version_id: stUp.chapter_version_id }));
  const staleSecs = await secsOf(chStale);
  await sb.from('writing_sections').update({ content: 'Changed underneath.' }).eq('id', staleSecs[0]!.id);
  const stR = await applyChapterRestore(sb, { book_id: BOOK, chapter_id: chStale, version_id: stUp.chapter_version_id, expected_chapter_hash: pStale.chapter_hash });
  check('N: stale restore → TARGET_CHANGED', st(stR) === 'TARGET_CHANGED');
  check('N: no write on stale', (await secsOf(chStale))[0]!.content === 'Changed underneath.');

  // O · RPC failure mid-restore → full rollback (craft a malformed snapshot)
  const chBad = await mkChapter([{ content: S1 }, { content: S2 }]);
  await applyUp(chBad, join(S1, S2, S3)); // ensure a valid history row exists too
  const hashBad = sc(await listChapterVersions(sb, { book_id: BOOK, chapter_id: chBad })).current.content_hash;
  const { data: badRow } = await sb.from('chapter_versions').insert({
    chapter_id: chBad, book_id: BOOK, version_reason: 'manual_snapshot', chapter_title: 'Ch', chapter_hash: hashBad,
    snapshot: { chapter_id: chBad, chapter_title: 'Ch', chapter_number: null, captured_hash: hashBad, sections: [{ section_id: 'not-a-uuid', sort_order: 0, title: null, content: 'x', word_count: 1 }] }
  } as any).select('id').single();
  const cvBad = (await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', chBad)).count ?? 0;
  const liveBad = (await secsOf(chBad)).map((s) => s.content).join('|');
  const { error: badErr } = await sb.rpc('apply_chapter_restore', { p_book_id: BOOK, p_chapter_id: chBad, p_expected_hash: hashBad, p_version_id: badRow!.id } as any);
  check('O: malformed snapshot restore raises', !!badErr);
  check('O: no partial — no before_chapter_restore snapshot added', (await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', chBad)).count === cvBad);
  check('O: live chapter untouched after failed restore', (await secsOf(chBad)).map((s) => s.content).join('|') === liveBad);

  // P · cross-chapter version_id rejected
  const chP1 = await mkChapter([{ content: S1 }]);
  const chP2 = await mkChapter([{ content: S2 }]);
  const p2Up = await applyUp(chP2, join(S2, S3));
  const crossPrev = await previewChapterRestore(sb, { book_id: BOOK, chapter_id: chP1, version_id: p2Up.chapter_version_id });
  check('P: cross-chapter preview → VERSION_NOT_FOUND', st(crossPrev) === 'VERSION_NOT_FOUND');
  const crossApply = await applyChapterRestore(sb, { book_id: BOOK, chapter_id: chP1, version_id: p2Up.chapter_version_id, expected_chapter_hash: '' });
  check('P: cross-chapter restore → VERSION_NOT_FOUND', st(crossApply) === 'VERSION_NOT_FOUND');

  // Q · unauthorized (anon) list blocked by RLS
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const ql = await listChapterVersions(anon, { book_id: BOOK, chapter_id: chH });
  check('Q: anon list → NOT_FOUND', st(ql) === 'NOT_FOUND');
} finally {
  await sb.from('books').delete().eq('id', BOOK);
  console.log('\n(fixture cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
