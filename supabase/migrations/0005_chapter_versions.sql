-- 0005_chapter_versions.sql
-- Chapter-level version snapshots + a single transactional apply for Chapter
-- Upload. Mirrors the section_versions philosophy (snapshot-first, owner-scoped
-- RLS) but at the chapter grain: one row captures the WHOLE chapter (metadata +
-- every section's identity, order, title, content) as a recoverable manifest.
-- The apply RPC runs in one transaction so a chapter can never end up half old /
-- half new. Backs the (later) Chapter Version History + Restore slice.

create table if not exists chapter_versions (
  id uuid primary key default uuid_generate_v4(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  book_id uuid not null references books(id) on delete cascade,
  version_reason text not null default 'before_chapter_upload'
    check (version_reason in ('before_chapter_upload', 'manual_snapshot', 'before_chapter_restore')),
  chapter_title text,
  chapter_hash text,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists chapter_versions_chapter_id_idx on chapter_versions(chapter_id);

alter table chapter_versions enable row level security;
create policy "own chapter versions" on chapter_versions for all
  using (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));

-- Deterministic concurrency token for a chapter: hash of its ordered sections
-- (id + sort_order + content hash). Changes whenever any child section's
-- content or order changes — the chapter row's own updated_at is NOT enough.
-- The TS layer computes the identical value (md5 over the same string) so a
-- stale apply is detected without trusting the chapter row.
create or replace function chapter_state_hash(p_chapter_id uuid) returns text
language sql stable as $$
  select md5(coalesce(
    string_agg(s.id::text || ':' || s.sort_order::text || ':' || md5(s.content), '|'
               order by s.sort_order, s.id),
    ''))
  from writing_sections s where s.chapter_id = p_chapter_id;
$$;

-- Atomic chapter apply. Validates the chapter is unchanged since preview,
-- snapshots the CURRENT chapter into chapter_versions, then applies the
-- writer-approved section updates / inserts / explicit removals / reorder — all
-- in one transaction. Any raise rolls the whole thing back. SECURITY INVOKER so
-- RLS still scopes every touched row to the caller; every write is additionally
-- guarded by chapter_id = p_chapter_id so nothing outside this chapter can move.
create or replace function apply_chapter_version(
  p_book_id uuid,
  p_chapter_id uuid,
  p_expected_hash text,
  p_updates jsonb,    -- [{ section_id, content, word_count }]
  p_inserts jsonb,    -- [{ title, content, word_count, sort_order }]
  p_order jsonb,      -- [{ section_id, sort_order }]
  p_removals jsonb,   -- [ section_id, ... ]  (writer explicitly opted in)
  p_version_reason text
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_chapter chapters%rowtype;
  v_hash text;
  v_snapshot jsonb;
  v_cv_id uuid;
  v_rec jsonb;
  v_applied int := 0;
  v_inserted int := 0;
  v_removed int := 0;
  v_reordered int := 0;
begin
  select * into v_chapter from chapters where id = p_chapter_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_chapter.book_id <> p_book_id then raise exception 'WRONG_RELATIONSHIP'; end if;

  v_hash := chapter_state_hash(p_chapter_id);
  if p_expected_hash is not null and p_expected_hash <> '' and p_expected_hash <> v_hash then
    raise exception 'TARGET_CHANGED';
  end if;

  -- snapshot FIRST (complete, recoverable manifest of the current chapter)
  select jsonb_build_object(
    'chapter_id', p_chapter_id,
    'chapter_title', v_chapter.title,
    'chapter_number', v_chapter.chapter_number,
    'captured_hash', v_hash,
    'sections', coalesce(jsonb_agg(jsonb_build_object(
        'section_id', s.id, 'sort_order', s.sort_order, 'title', s.title,
        'content', s.content, 'word_count', s.word_count
      ) order by s.sort_order, s.id), '[]'::jsonb)
  ) into v_snapshot
  from writing_sections s where s.chapter_id = p_chapter_id;

  insert into chapter_versions(chapter_id, book_id, version_reason, chapter_title, chapter_hash, snapshot)
  values (p_chapter_id, p_book_id, coalesce(nullif(p_version_reason, ''), 'before_chapter_upload'), v_chapter.title, v_hash, v_snapshot)
  returning id into v_cv_id;

  for v_rec in select value from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    update writing_sections
      set content = v_rec->>'content', word_count = (v_rec->>'word_count')::int
      where id = (v_rec->>'section_id')::uuid and chapter_id = p_chapter_id;
    if found then v_applied := v_applied + 1; end if;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_inserts, '[]'::jsonb)) loop
    insert into writing_sections(chapter_id, sort_order, title, content, word_count, status)
    values (p_chapter_id, (v_rec->>'sort_order')::int, nullif(v_rec->>'title', ''),
            v_rec->>'content', (v_rec->>'word_count')::int, 'Draft');
    v_inserted := v_inserted + 1;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_removals, '[]'::jsonb)) loop
    delete from writing_sections
      where id = (v_rec#>>'{}')::uuid and chapter_id = p_chapter_id;
    if found then v_removed := v_removed + 1; end if;
  end loop;

  for v_rec in select value from jsonb_array_elements(coalesce(p_order, '[]'::jsonb)) loop
    update writing_sections set sort_order = (v_rec->>'sort_order')::int
      where id = (v_rec->>'section_id')::uuid and chapter_id = p_chapter_id;
    if found then v_reordered := v_reordered + 1; end if;
  end loop;

  return jsonb_build_object(
    'status', 'applied', 'chapter_version_id', v_cv_id,
    'applied_updates', v_applied, 'inserted', v_inserted,
    'removed', v_removed, 'reordered', v_reordered, 'chapter_hash', v_hash
  );
end;
$$;
