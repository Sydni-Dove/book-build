-- 0006_chapter_restore.sql
-- Transactional restore of a whole chapter to a stored chapter_versions snapshot.
-- Mirrors apply_chapter_version's safety: validate the chapter is unchanged since
-- the comparison, snapshot the CURRENT chapter first (before_chapter_restore),
-- then reconcile the live sections to EXACTLY the selected snapshot — update
-- surviving sections, re-insert sections that were later removed (preserving
-- their original section_id), and delete sections that did not exist in the
-- snapshot — all in ONE transaction. Because the current chapter is snapshotted
-- first, a restore is itself reversible (restore forward again).

create or replace function apply_chapter_restore(
  p_book_id uuid,
  p_chapter_id uuid,
  p_expected_hash text,
  p_version_id uuid
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_chapter chapters%rowtype;
  v_hash text;
  v_snapshot jsonb;
  v_cur_snapshot jsonb;
  v_cv_id uuid;
  v_sec jsonb;
  v_snap_ids uuid[];
  v_updated int := 0;
  v_inserted int := 0;
  v_deleted int := 0;
begin
  select * into v_chapter from chapters where id = p_chapter_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_chapter.book_id <> p_book_id then raise exception 'WRONG_RELATIONSHIP'; end if;

  v_hash := chapter_state_hash(p_chapter_id);
  if p_expected_hash is not null and p_expected_hash <> '' and p_expected_hash <> v_hash then
    raise exception 'TARGET_CHANGED';
  end if;

  select snapshot into v_snapshot from chapter_versions where id = p_version_id and chapter_id = p_chapter_id;
  if v_snapshot is null then raise exception 'VERSION_NOT_FOUND'; end if;

  -- snapshot the CURRENT chapter FIRST (recoverable forward)
  select jsonb_build_object(
    'chapter_id', p_chapter_id,
    'chapter_title', v_chapter.title,
    'chapter_number', v_chapter.chapter_number,
    'captured_hash', v_hash,
    'sections', coalesce(jsonb_agg(jsonb_build_object(
        'section_id', s.id, 'sort_order', s.sort_order, 'title', s.title,
        'content', s.content, 'word_count', s.word_count
      ) order by s.sort_order, s.id), '[]'::jsonb)
  ) into v_cur_snapshot
  from writing_sections s where s.chapter_id = p_chapter_id;

  insert into chapter_versions(chapter_id, book_id, version_reason, chapter_title, chapter_hash, snapshot)
  values (p_chapter_id, p_book_id, 'before_chapter_restore', v_chapter.title, v_hash, v_cur_snapshot)
  returning id into v_cv_id;

  -- section ids that should exist after restore (the snapshot's set)
  select array_agg((e->>'section_id')::uuid) into v_snap_ids
  from jsonb_array_elements(v_snapshot->'sections') e;

  -- delete live sections that were added AFTER the snapshot
  delete from writing_sections
    where chapter_id = p_chapter_id and not (id = any(coalesce(v_snap_ids, '{}'::uuid[])));
  get diagnostics v_deleted = row_count;

  -- reconcile each snapshot section: update if it survives, else re-insert
  -- (keeping the original section_id so identity/order/history line up)
  for v_sec in select value from jsonb_array_elements(v_snapshot->'sections') loop
    update writing_sections set
        content = v_sec->>'content',
        title = nullif(v_sec->>'title', ''),
        sort_order = (v_sec->>'sort_order')::int,
        word_count = (v_sec->>'word_count')::int
      where id = (v_sec->>'section_id')::uuid and chapter_id = p_chapter_id;
    if found then
      v_updated := v_updated + 1;
    else
      insert into writing_sections(id, chapter_id, sort_order, title, content, word_count, status)
      values ((v_sec->>'section_id')::uuid, p_chapter_id, (v_sec->>'sort_order')::int,
              nullif(v_sec->>'title', ''), v_sec->>'content', (v_sec->>'word_count')::int, 'Draft');
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  -- the chapter snapshot owns the chapter title, so restore it too
  update chapters set title = coalesce(v_snapshot->>'chapter_title', v_chapter.title) where id = p_chapter_id;

  return jsonb_build_object(
    'status', 'applied',
    'restore_snapshot_id', v_cv_id,
    'restored_from_version_id', p_version_id,
    'updated', v_updated, 'inserted', v_inserted, 'deleted', v_deleted,
    'chapter_hash', v_hash
  );
end;
$$;
