-- 0008_manuscript_snapshots.sql
-- Whole-book version store for "Upload New Manuscript Version".
--
-- 0003_manuscript_versions is STALE and stays UNAPPLIED: it predates
-- chapter_versions (0005) and uses a different snapshot dialect (two tables,
-- chapters denormalized by number/title, an identity-losing source_section_id
-- pointer, app-code restore). Rather than fork that model, this table mirrors
-- the mature chapter_versions design: ONE row per checkpoint, a jsonb snapshot
-- that preserves chapter_id/section_id identity + order + titles + content, and
-- a manuscript_hash. Named manuscript_SNAPSHOTS to avoid colliding with the
-- dormant 0003 manuscript_versions type still referenced by the paused
-- Save-Version code (src/lib/versions/snapshot.ts).

create table if not exists manuscript_snapshots (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  version_reason text not null default 'before_manuscript_upload'
    check (version_reason in ('before_manuscript_upload', 'manual_snapshot', 'before_manuscript_restore')),
  source text,                 -- 'paste' | 'file'
  source_filename text,        -- provenance, optional
  book_title text,
  manuscript_hash text,
  chapter_count integer not null default 0,
  section_count integer not null default 0,
  word_count integer not null default 0,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists manuscript_snapshots_book_id_idx on manuscript_snapshots(book_id);

alter table manuscript_snapshots enable row level security;
create policy "own manuscript snapshots" on manuscript_snapshots for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

-- Deterministic whole-book concurrency token: hash over the ordered chapters
-- (id + order + number + title) and, within each, the ordered sections
-- (id + order + title + content hash). Detects chapter membership/order/title
-- and section membership/order/title/content changes. The TS layer computes the
-- identical value so a stale apply is caught without trusting books.updated_at.
create or replace function manuscript_state_hash(p_book_id uuid) returns text
language sql stable as $$
  select md5(coalesce(string_agg(
    c.id::text || ':' || c.sort_order::text || ':' || coalesce(c.chapter_number::text, '') || ':' || coalesce(c.title, '') || '#' ||
    coalesce((select string_agg(s.id::text || ':' || s.sort_order::text || ':' || coalesce(s.title, '') || ':' || md5(s.content), '|'
                     order by s.sort_order, s.id)
              from writing_sections s where s.chapter_id = c.id), ''),
    '||' order by c.sort_order, c.id), ''))
  from chapters c where c.book_id = p_book_id;
$$;

-- Atomic whole-book activation. Validates ownership + manuscript hash, snapshots
-- the ENTIRE current manuscript into manuscript_snapshots, then applies the
-- writer-approved plan — chapter metadata/reorder, new chapters (+ sections),
-- section updates/inserts/reorder, and EXPLICIT section removals (0007-safe:
-- detaches section history) — all in ONE transaction. It NEVER deletes a
-- chapter (KEEP-only slice); chapter removal is deferred pending its own
-- history-preservation design. SECURITY INVOKER so RLS scopes every touched
-- row; every write is additionally guarded to this book.
create or replace function apply_manuscript_version(
  p_book_id uuid,
  p_expected_hash text,
  p_source text,
  p_source_filename text,
  p_chapter_updates jsonb,   -- [{ chapter_id, title, chapter_number, sort_order }]
  p_new_chapters jsonb,      -- [{ chapter_number, title, sort_order, sections:[{title,content,word_count,sort_order}] }]
  p_section_updates jsonb,   -- [{ section_id, content, word_count }]
  p_section_inserts jsonb,   -- [{ chapter_id, title, content, word_count, sort_order }]
  p_section_removals jsonb,  -- [ section_id, ... ]
  p_chapter_reorder jsonb,   -- [{ chapter_id, sort_order }]
  p_section_reorder jsonb    -- [{ section_id, sort_order }]
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_title text;
  v_hash text;
  v_snapshot jsonb;
  v_ms_id uuid;
  v_chapter_count int; v_section_count int; v_word_count int;
  v_rec jsonb; v_sec jsonb; v_new_ch_id uuid;
  v_upd_ch int := 0; v_new_ch int := 0; v_upd_sec int := 0; v_ins_sec int := 0; v_rem_sec int := 0; v_reord int := 0;
begin
  select title into v_title from books where id = p_book_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  v_hash := manuscript_state_hash(p_book_id);
  if p_expected_hash is not null and p_expected_hash <> '' and p_expected_hash <> v_hash then
    raise exception 'TARGET_CHANGED';
  end if;

  -- complete pre-update manuscript snapshot (identity + order + titles + content)
  select jsonb_build_object(
    'book_id', p_book_id, 'book_title', v_title, 'manuscript_hash', v_hash,
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
          'chapter_id', c.id, 'chapter_number', c.chapter_number, 'title', c.title, 'sort_order', c.sort_order,
          'sections', coalesce((select jsonb_agg(jsonb_build_object(
              'section_id', s.id, 'sort_order', s.sort_order, 'title', s.title, 'content', s.content, 'word_count', s.word_count
            ) order by s.sort_order, s.id) from writing_sections s where s.chapter_id = c.id), '[]'::jsonb)
        ) order by c.sort_order, c.id)
      from chapters c where c.book_id = p_book_id), '[]'::jsonb)
  ) into v_snapshot;

  select count(*) into v_chapter_count from chapters where book_id = p_book_id;
  select count(*), coalesce(sum(word_count), 0) into v_section_count, v_word_count
    from writing_sections where chapter_id in (select id from chapters where book_id = p_book_id);

  insert into manuscript_snapshots(book_id, version_reason, source, source_filename, book_title, manuscript_hash, chapter_count, section_count, word_count, snapshot)
  values (p_book_id, 'before_manuscript_upload', nullif(p_source, ''), nullif(p_source_filename, ''), v_title, v_hash, v_chapter_count, v_section_count, v_word_count, v_snapshot)
  returning id into v_ms_id;

  -- mapped chapter metadata (title / number / order)
  for v_rec in select value from jsonb_array_elements(coalesce(p_chapter_updates, '[]'::jsonb)) loop
    update chapters set
        title = coalesce(v_rec->>'title', title),
        chapter_number = coalesce((v_rec->>'chapter_number')::int, chapter_number),
        sort_order = coalesce((v_rec->>'sort_order')::int, sort_order)
      where id = (v_rec->>'chapter_id')::uuid and book_id = p_book_id;
    if found then v_upd_ch := v_upd_ch + 1; end if;
  end loop;

  -- new chapters (+ their sections)
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

  -- section content updates (mapped chapters)
  for v_rec in select value from jsonb_array_elements(coalesce(p_section_updates, '[]'::jsonb)) loop
    update writing_sections set content = v_rec->>'content', word_count = (v_rec->>'word_count')::int
      where id = (v_rec->>'section_id')::uuid and chapter_id in (select id from chapters where book_id = p_book_id);
    if found then v_upd_sec := v_upd_sec + 1; end if;
  end loop;

  -- section inserts into existing mapped chapters
  for v_rec in select value from jsonb_array_elements(coalesce(p_section_inserts, '[]'::jsonb)) loop
    if (v_rec->>'chapter_id')::uuid in (select id from chapters where book_id = p_book_id) then
      insert into writing_sections(chapter_id, sort_order, title, content, word_count, status)
      values ((v_rec->>'chapter_id')::uuid, (v_rec->>'sort_order')::int, nullif(v_rec->>'title', ''), v_rec->>'content', (v_rec->>'word_count')::int, 'Draft');
      v_ins_sec := v_ins_sec + 1;
    end if;
  end loop;

  -- explicit SECTION removals (never chapters). 0007 triggers detach history.
  for v_rec in select value from jsonb_array_elements(coalesce(p_section_removals, '[]'::jsonb)) loop
    delete from writing_sections
      where id = (v_rec#>>'{}')::uuid and chapter_id in (select id from chapters where book_id = p_book_id);
    if found then v_rem_sec := v_rem_sec + 1; end if;
  end loop;

  -- reorder
  for v_rec in select value from jsonb_array_elements(coalesce(p_chapter_reorder, '[]'::jsonb)) loop
    update chapters set sort_order = (v_rec->>'sort_order')::int
      where id = (v_rec->>'chapter_id')::uuid and book_id = p_book_id;
    if found then v_reord := v_reord + 1; end if;
  end loop;
  for v_rec in select value from jsonb_array_elements(coalesce(p_section_reorder, '[]'::jsonb)) loop
    update writing_sections set sort_order = (v_rec->>'sort_order')::int
      where id = (v_rec->>'section_id')::uuid and chapter_id in (select id from chapters where book_id = p_book_id);
    if found then v_reord := v_reord + 1; end if;
  end loop;

  return jsonb_build_object(
    'status', 'applied', 'manuscript_snapshot_id', v_ms_id,
    'chapters_updated', v_upd_ch, 'chapters_added', v_new_ch,
    'sections_updated', v_upd_sec, 'sections_added', v_ins_sec,
    'sections_removed', v_rem_sec, 'reordered', v_reord, 'manuscript_hash', v_hash
  );
end;
$$;
