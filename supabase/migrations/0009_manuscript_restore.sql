-- 0009_manuscript_restore.sql
-- Transactional whole-book restore to a stored manuscript_snapshots checkpoint.
-- KEEP-only: chapters cannot yet be safely deactivated, so a chapter that exists
-- NOW but not in the selected snapshot is PRESERVED (never deleted) — it is only
-- re-ordered to sit after the restored chapters. Within each chapter that the
-- snapshot covers, sections are reconciled EXACTLY to the snapshot (0007-safe:
-- removed sections detach their history, re-inserted originals reconnect it).
-- Snapshot-first, so a restore is itself reversible. If a snapshot chapter id no
-- longer exists, we STOP (CHAPTER_REACTIVATION_REQUIRED) rather than guess.

create or replace function apply_manuscript_restore(
  p_book_id uuid,
  p_snapshot_id uuid,
  p_expected_hash text
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_title text; v_hash text; v_snapshot jsonb; v_cur_snapshot jsonb; v_ms_id uuid;
  v_ch jsonb; v_sec jsonb; v_extra record;
  v_sec_ids uuid[]; v_snap_ch_ids uuid[];
  v_max_order int; v_extra_order int; v_tmp int;
  v_cc int; v_sc int; v_wc int;
  v_ch_restored int := 0; v_sec_restored int := 0; v_sec_reinserted int := 0; v_sec_removed int := 0; v_kept int := 0;
  v_snap_book_title text;
begin
  select title into v_title from books where id = p_book_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  select snapshot into v_snapshot from manuscript_snapshots where id = p_snapshot_id and book_id = p_book_id;
  if v_snapshot is null then raise exception 'VERSION_NOT_FOUND'; end if;
  if jsonb_typeof(v_snapshot->'chapters') <> 'array' then raise exception 'MALFORMED_SNAPSHOT'; end if;

  v_hash := manuscript_state_hash(p_book_id);
  if p_expected_hash is not null and p_expected_hash <> '' and p_expected_hash <> v_hash then
    raise exception 'TARGET_CHANGED';
  end if;

  -- every snapshot chapter must still exist (no safe recreation yet)
  select array_agg((c->>'chapter_id')::uuid) into v_snap_ch_ids from jsonb_array_elements(v_snapshot->'chapters') c;
  if exists (
    select 1 from unnest(coalesce(v_snap_ch_ids, '{}'::uuid[])) as x(cid)
    where not exists (select 1 from chapters ch where ch.id = x.cid and ch.book_id = p_book_id)
  ) then
    raise exception 'CHAPTER_REACTIVATION_REQUIRED';
  end if;

  -- snapshot the CURRENT whole manuscript first (recoverable forward)
  select jsonb_build_object(
    'book_id', p_book_id, 'book_title', v_title, 'manuscript_hash', v_hash,
    'chapters', coalesce((select jsonb_agg(jsonb_build_object(
        'chapter_id', c.id, 'chapter_number', c.chapter_number, 'title', c.title, 'sort_order', c.sort_order,
        'sections', coalesce((select jsonb_agg(jsonb_build_object('section_id', s.id, 'sort_order', s.sort_order, 'title', s.title, 'content', s.content, 'word_count', s.word_count) order by s.sort_order, s.id) from writing_sections s where s.chapter_id = c.id), '[]'::jsonb)
      ) order by c.sort_order, c.id) from chapters c where c.book_id = p_book_id), '[]'::jsonb)
  ) into v_cur_snapshot;
  select count(*) into v_cc from chapters where book_id = p_book_id;
  select count(*), coalesce(sum(word_count), 0) into v_sc, v_wc from writing_sections where chapter_id in (select id from chapters where book_id = p_book_id);
  insert into manuscript_snapshots(book_id, version_reason, source, book_title, manuscript_hash, chapter_count, section_count, word_count, snapshot)
  values (p_book_id, 'before_manuscript_restore', 'restore', v_title, v_hash, v_cc, v_sc, v_wc, v_cur_snapshot)
  returning id into v_ms_id;

  -- restore book title from the snapshot
  v_snap_book_title := v_snapshot->>'book_title';
  if v_snap_book_title is not null then update books set title = v_snap_book_title where id = p_book_id; end if;

  -- restore each snapshot chapter's metadata + reconcile its sections
  for v_ch in select value from jsonb_array_elements(v_snapshot->'chapters') loop
    update chapters set
        title = v_ch->>'title',
        chapter_number = nullif(v_ch->>'chapter_number', '')::int,
        sort_order = (v_ch->>'sort_order')::int
      where id = (v_ch->>'chapter_id')::uuid and book_id = p_book_id;
    v_ch_restored := v_ch_restored + 1;

    select array_agg((e->>'section_id')::uuid) into v_sec_ids from jsonb_array_elements(v_ch->'sections') e;
    delete from writing_sections
      where chapter_id = (v_ch->>'chapter_id')::uuid and not (id = any(coalesce(v_sec_ids, '{}'::uuid[])));
    get diagnostics v_tmp = row_count; v_sec_removed := v_sec_removed + v_tmp;

    for v_sec in select value from jsonb_array_elements(v_ch->'sections') loop
      update writing_sections set
          content = v_sec->>'content', title = nullif(v_sec->>'title', ''),
          sort_order = (v_sec->>'sort_order')::int, word_count = (v_sec->>'word_count')::int
        where id = (v_sec->>'section_id')::uuid and chapter_id = (v_ch->>'chapter_id')::uuid;
      if found then
        v_sec_restored := v_sec_restored + 1;
      else
        insert into writing_sections(id, chapter_id, sort_order, title, content, word_count, status)
        values ((v_sec->>'section_id')::uuid, (v_ch->>'chapter_id')::uuid, (v_sec->>'sort_order')::int,
                nullif(v_sec->>'title', ''), v_sec->>'content', (v_sec->>'word_count')::int, 'Draft');
        v_sec_reinserted := v_sec_reinserted + 1;
      end if;
    end loop;
  end loop;

  -- KEEP-only: extra current chapters (not in the snapshot) are preserved and
  -- moved to sit AFTER the restored chapters, in their current relative order.
  select coalesce(max((c->>'sort_order')::int), -1) into v_max_order from jsonb_array_elements(v_snapshot->'chapters') c;
  v_extra_order := v_max_order + 1;
  for v_extra in select id from chapters where book_id = p_book_id and not (id = any(coalesce(v_snap_ch_ids, '{}'::uuid[]))) order by sort_order, id loop
    update chapters set sort_order = v_extra_order where id = v_extra.id;
    v_extra_order := v_extra_order + 1; v_kept := v_kept + 1;
  end loop;

  return jsonb_build_object(
    'status', 'applied', 'restore_snapshot_id', v_ms_id, 'restored_from_snapshot_id', p_snapshot_id,
    'chapters_restored', v_ch_restored, 'sections_restored', v_sec_restored,
    'sections_reinserted', v_sec_reinserted, 'sections_removed', v_sec_removed,
    'chapters_kept', v_kept, 'manuscript_hash', v_hash
  );
end;
$$;
