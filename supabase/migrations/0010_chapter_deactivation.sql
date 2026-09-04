-- 0010_chapter_deactivation.sql
-- Safe ACTIVE vs INACTIVE chapter membership. Removing a chapter from the active
-- manuscript sets chapters.archived_at (a plain column update — cascades NOTHING),
-- so chapter_versions, scenes, outlines/beats, writing_sections + their history,
-- and all story/canon/timeline references stay attached. Reactivation clears it.
-- Chosen over is_active (carries WHEN it left; matches 0007's timestamp idiom;
-- partial-index friendly) and over reusing status (workflow state, orthogonal).
-- Existing rows keep archived_at = null → all currently ACTIVE (Awakened 21/34).

alter table chapters add column if not exists archived_at timestamptz;
create index if not exists chapters_active_idx on chapters(book_id) where archived_at is null;

-- The current manuscript = ACTIVE chapters only. Hash must ignore inactive ones.
create or replace function manuscript_state_hash(p_book_id uuid) returns text
language sql stable as $$
  select md5(coalesce(string_agg(
    c.id::text || ':' || c.sort_order::text || ':' || coalesce(c.chapter_number::text, '') || ':' || coalesce(c.title, '') || '#' ||
    coalesce((select string_agg(s.id::text || ':' || s.sort_order::text || ':' || coalesce(s.title, '') || ':' || md5(s.content), '|'
                     order by s.sort_order, s.id)
              from writing_sections s where s.chapter_id = c.id), ''),
    '||' order by c.sort_order, c.id), ''))
  from chapters c where c.book_id = p_book_id and c.archived_at is null;
$$;

-- Standalone deactivate / reactivate (reversible; never delete). Used by the
-- manuscript RPCs below and available for direct/version operations.
create or replace function deactivate_chapter(p_book_id uuid, p_chapter_id uuid) returns jsonb
language plpgsql security invoker as $$
declare v_book uuid;
begin
  select book_id into v_book from chapters where id = p_chapter_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_book <> p_book_id then raise exception 'WRONG_RELATIONSHIP'; end if;
  update chapters set archived_at = now() where id = p_chapter_id and book_id = p_book_id and archived_at is null;
  return jsonb_build_object('status', 'deactivated', 'chapter_id', p_chapter_id);
end; $$;

create or replace function reactivate_chapter(p_book_id uuid, p_chapter_id uuid, p_sort_order int) returns jsonb
language plpgsql security invoker as $$
declare v_book uuid;
begin
  select book_id into v_book from chapters where id = p_chapter_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_book <> p_book_id then raise exception 'WRONG_RELATIONSHIP'; end if;
  update chapters set archived_at = null, sort_order = coalesce(p_sort_order, sort_order)
    where id = p_chapter_id and book_id = p_book_id;
  return jsonb_build_object('status', 'reactivated', 'chapter_id', p_chapter_id);
end; $$;

-- apply_manuscript_version: snapshot ACTIVE manuscript only; support EXPLICIT
-- chapter removals via deactivation (never delete). New 12th param.
drop function if exists apply_manuscript_version(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb);
create or replace function apply_manuscript_version(
  p_book_id uuid,
  p_expected_hash text,
  p_source text,
  p_source_filename text,
  p_chapter_updates jsonb,
  p_new_chapters jsonb,
  p_section_updates jsonb,
  p_section_inserts jsonb,
  p_section_removals jsonb,
  p_chapter_reorder jsonb,
  p_section_reorder jsonb,
  p_chapter_deactivations jsonb
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_title text; v_hash text; v_snapshot jsonb; v_ms_id uuid;
  v_chapter_count int; v_section_count int; v_word_count int;
  v_rec jsonb; v_sec jsonb; v_new_ch_id uuid;
  v_upd_ch int := 0; v_new_ch int := 0; v_upd_sec int := 0; v_ins_sec int := 0; v_rem_sec int := 0; v_reord int := 0; v_deact int := 0;
begin
  select title into v_title from books where id = p_book_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  v_hash := manuscript_state_hash(p_book_id);
  if p_expected_hash is not null and p_expected_hash <> '' and p_expected_hash <> v_hash then
    raise exception 'TARGET_CHANGED';
  end if;

  -- snapshot the ACTIVE manuscript only
  select jsonb_build_object(
    'book_id', p_book_id, 'book_title', v_title, 'manuscript_hash', v_hash,
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
          'chapter_id', c.id, 'chapter_number', c.chapter_number, 'title', c.title, 'sort_order', c.sort_order,
          'sections', coalesce((select jsonb_agg(jsonb_build_object(
              'section_id', s.id, 'sort_order', s.sort_order, 'title', s.title, 'content', s.content, 'word_count', s.word_count
            ) order by s.sort_order, s.id) from writing_sections s where s.chapter_id = c.id), '[]'::jsonb)
        ) order by c.sort_order, c.id)
      from chapters c where c.book_id = p_book_id and c.archived_at is null), '[]'::jsonb)
  ) into v_snapshot;
  select count(*) into v_chapter_count from chapters where book_id = p_book_id and archived_at is null;
  select count(*), coalesce(sum(word_count), 0) into v_section_count, v_word_count
    from writing_sections where chapter_id in (select id from chapters where book_id = p_book_id and archived_at is null);

  insert into manuscript_snapshots(book_id, version_reason, source, source_filename, book_title, manuscript_hash, chapter_count, section_count, word_count, snapshot)
  values (p_book_id, 'before_manuscript_upload', nullif(p_source, ''), nullif(p_source_filename, ''), v_title, v_hash, v_chapter_count, v_section_count, v_word_count, v_snapshot)
  returning id into v_ms_id;

  for v_rec in select value from jsonb_array_elements(coalesce(p_chapter_updates, '[]'::jsonb)) loop
    update chapters set title = coalesce(v_rec->>'title', title), chapter_number = coalesce((v_rec->>'chapter_number')::int, chapter_number), sort_order = coalesce((v_rec->>'sort_order')::int, sort_order)
      where id = (v_rec->>'chapter_id')::uuid and book_id = p_book_id;
    if found then v_upd_ch := v_upd_ch + 1; end if;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_new_chapters, '[]'::jsonb)) loop
    insert into chapters(book_id, chapter_number, title, sort_order, status)
    values (p_book_id, (v_rec->>'chapter_number')::int, nullif(v_rec->>'title', ''), (v_rec->>'sort_order')::int, 'Drafting')
    returning id into v_new_ch_id;
    v_new_ch := v_new_ch + 1;
    for v_sec in select value from jsonb_array_elements(coalesce(v_rec->'sections', '[]'::jsonb)) loop
      insert into writing_sections(chapter_id, sort_order, title, content, word_count, status)
      values (v_new_ch_id, (v_sec->>'sort_order')::int, nullif(v_sec->>'title', ''), v_sec->>'content', (v_sec->>'word_count')::int, 'Draft');
      v_ins_sec := v_ins_sec + 1;
    end loop;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_section_updates, '[]'::jsonb)) loop
    update writing_sections set content = v_rec->>'content', word_count = (v_rec->>'word_count')::int
      where id = (v_rec->>'section_id')::uuid and chapter_id in (select id from chapters where book_id = p_book_id);
    if found then v_upd_sec := v_upd_sec + 1; end if;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_section_inserts, '[]'::jsonb)) loop
    if (v_rec->>'chapter_id')::uuid in (select id from chapters where book_id = p_book_id) then
      insert into writing_sections(chapter_id, sort_order, title, content, word_count, status)
      values ((v_rec->>'chapter_id')::uuid, (v_rec->>'sort_order')::int, nullif(v_rec->>'title', ''), v_rec->>'content', (v_rec->>'word_count')::int, 'Draft');
      v_ins_sec := v_ins_sec + 1;
    end if;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_section_removals, '[]'::jsonb)) loop
    delete from writing_sections where id = (v_rec#>>'{}')::uuid and chapter_id in (select id from chapters where book_id = p_book_id);
    if found then v_rem_sec := v_rem_sec + 1; end if;
  end loop;

  -- EXPLICIT chapter removals → deactivate (never delete)
  for v_rec in select value from jsonb_array_elements(coalesce(p_chapter_deactivations, '[]'::jsonb)) loop
    update chapters set archived_at = now() where id = (v_rec#>>'{}')::uuid and book_id = p_book_id and archived_at is null;
    if found then v_deact := v_deact + 1; end if;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_chapter_reorder, '[]'::jsonb)) loop
    update chapters set sort_order = (v_rec->>'sort_order')::int where id = (v_rec->>'chapter_id')::uuid and book_id = p_book_id;
    if found then v_reord := v_reord + 1; end if;
  end loop;
  for v_rec in select value from jsonb_array_elements(coalesce(p_section_reorder, '[]'::jsonb)) loop
    update writing_sections set sort_order = (v_rec->>'sort_order')::int where id = (v_rec->>'section_id')::uuid and chapter_id in (select id from chapters where book_id = p_book_id);
    if found then v_reord := v_reord + 1; end if;
  end loop;

  return jsonb_build_object('status', 'applied', 'manuscript_snapshot_id', v_ms_id,
    'chapters_updated', v_upd_ch, 'chapters_added', v_new_ch, 'chapters_deactivated', v_deact,
    'sections_updated', v_upd_sec, 'sections_added', v_ins_sec, 'sections_removed', v_rem_sec, 'reordered', v_reord, 'manuscript_hash', v_hash);
end;
$$;

-- apply_manuscript_restore: reactivate archived chapters the snapshot needs;
-- deactivate active chapters the snapshot lacks; snapshot ACTIVE only. This
-- reproduces EXACT historical active membership (no physical deletion).
create or replace function apply_manuscript_restore(
  p_book_id uuid, p_snapshot_id uuid, p_expected_hash text
) returns jsonb
language plpgsql security invoker as $$
declare
  v_title text; v_hash text; v_snapshot jsonb; v_cur_snapshot jsonb; v_ms_id uuid;
  v_ch jsonb; v_sec jsonb; v_sec_ids uuid[]; v_snap_ch_ids uuid[]; v_tmp int;
  v_cc int; v_sc int; v_wc int;
  v_ch_restored int := 0; v_sec_restored int := 0; v_sec_reinserted int := 0; v_sec_removed int := 0; v_reactivated int := 0; v_deactivated int := 0;
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

  -- every snapshot chapter must still EXIST as a row (active OR archived).
  -- Archived rows are fine — they will be reactivated. Only a genuinely absent
  -- id blocks (we never fabricate a new chapter identity).
  select array_agg((c->>'chapter_id')::uuid) into v_snap_ch_ids from jsonb_array_elements(v_snapshot->'chapters') c;
  if exists (
    select 1 from unnest(coalesce(v_snap_ch_ids, '{}'::uuid[])) as x(cid)
    where not exists (select 1 from chapters ch where ch.id = x.cid and ch.book_id = p_book_id)
  ) then
    raise exception 'CHAPTER_REACTIVATION_REQUIRED';
  end if;

  -- snapshot the current ACTIVE manuscript first
  select jsonb_build_object(
    'book_id', p_book_id, 'book_title', v_title, 'manuscript_hash', v_hash,
    'chapters', coalesce((select jsonb_agg(jsonb_build_object(
        'chapter_id', c.id, 'chapter_number', c.chapter_number, 'title', c.title, 'sort_order', c.sort_order,
        'sections', coalesce((select jsonb_agg(jsonb_build_object('section_id', s.id, 'sort_order', s.sort_order, 'title', s.title, 'content', s.content, 'word_count', s.word_count) order by s.sort_order, s.id) from writing_sections s where s.chapter_id = c.id), '[]'::jsonb)
      ) order by c.sort_order, c.id) from chapters c where c.book_id = p_book_id and c.archived_at is null), '[]'::jsonb)
  ) into v_cur_snapshot;
  select count(*) into v_cc from chapters where book_id = p_book_id and archived_at is null;
  select count(*), coalesce(sum(word_count), 0) into v_sc, v_wc from writing_sections where chapter_id in (select id from chapters where book_id = p_book_id and archived_at is null);
  insert into manuscript_snapshots(book_id, version_reason, source, book_title, manuscript_hash, chapter_count, section_count, word_count, snapshot)
  values (p_book_id, 'before_manuscript_restore', 'restore', v_title, v_hash, v_cc, v_sc, v_wc, v_cur_snapshot) returning id into v_ms_id;

  v_snap_book_title := v_snapshot->>'book_title';
  if v_snap_book_title is not null then update books set title = v_snap_book_title where id = p_book_id; end if;

  -- restore + REACTIVATE each snapshot chapter, reconcile its sections
  for v_ch in select value from jsonb_array_elements(v_snapshot->'chapters') loop
    update chapters set archived_at = null, title = v_ch->>'title', chapter_number = nullif(v_ch->>'chapter_number', '')::int, sort_order = (v_ch->>'sort_order')::int
      where id = (v_ch->>'chapter_id')::uuid and book_id = p_book_id;
    v_ch_restored := v_ch_restored + 1;

    select array_agg((e->>'section_id')::uuid) into v_sec_ids from jsonb_array_elements(v_ch->'sections') e;
    delete from writing_sections where chapter_id = (v_ch->>'chapter_id')::uuid and not (id = any(coalesce(v_sec_ids, '{}'::uuid[])));
    get diagnostics v_tmp = row_count; v_sec_removed := v_sec_removed + v_tmp;

    for v_sec in select value from jsonb_array_elements(v_ch->'sections') loop
      update writing_sections set content = v_sec->>'content', title = nullif(v_sec->>'title', ''), sort_order = (v_sec->>'sort_order')::int, word_count = (v_sec->>'word_count')::int
        where id = (v_sec->>'section_id')::uuid and chapter_id = (v_ch->>'chapter_id')::uuid;
      if found then v_sec_restored := v_sec_restored + 1;
      else
        insert into writing_sections(id, chapter_id, sort_order, title, content, word_count, status)
        values ((v_sec->>'section_id')::uuid, (v_ch->>'chapter_id')::uuid, (v_sec->>'sort_order')::int, nullif(v_sec->>'title', ''), v_sec->>'content', (v_sec->>'word_count')::int, 'Draft');
        v_sec_reinserted := v_sec_reinserted + 1;
      end if;
    end loop;
  end loop;

  -- DEACTIVATE active chapters not represented in the snapshot (reversible)
  update chapters set archived_at = now() where book_id = p_book_id and archived_at is null and not (id = any(coalesce(v_snap_ch_ids, '{}'::uuid[])));
  get diagnostics v_deactivated = row_count;

  return jsonb_build_object('status', 'applied', 'restore_snapshot_id', v_ms_id, 'restored_from_snapshot_id', p_snapshot_id,
    'chapters_restored', v_ch_restored, 'chapters_deactivated', v_deactivated,
    'sections_restored', v_sec_restored, 'sections_reinserted', v_sec_reinserted, 'sections_removed', v_sec_removed, 'manuscript_hash', v_hash);
end;
$$;
