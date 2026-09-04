-- 0011_atomic_chapter_placement.sql
-- Make "restore removed chapter to end" and "add chapter at end" fully atomic +
-- server-computed. Previously restore ran reactivate_chapter then a SEPARATE
-- client renumber (two writes, non-atomic), and Add Chapter computed max+1 in
-- the browser (stale-read race). Both now happen in ONE transaction with the
-- next sort_order / chapter_number computed inside it, serialized per book by a
-- transaction advisory lock so two near-simultaneous placements can't collide
-- on numbering (there is no unique constraint on chapter_number/sort_order).
-- No change to deactivation architecture, history, or identity.

create or replace function reactivate_chapter_to_end(p_book_id uuid, p_chapter_id uuid) returns jsonb
language plpgsql security invoker as $$
declare v_book uuid; v_archived timestamptz; v_next_order int; v_next_num int;
begin
  perform pg_advisory_xact_lock(hashtext(p_book_id::text));
  select book_id, archived_at into v_book, v_archived from chapters where id = p_chapter_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_book <> p_book_id then raise exception 'WRONG_RELATIONSHIP'; end if;
  if v_archived is null then raise exception 'ALREADY_ACTIVE'; end if;
  select coalesce(max(sort_order), -1) + 1, coalesce(max(chapter_number), 0) + 1
    into v_next_order, v_next_num
    from chapters where book_id = p_book_id and archived_at is null;
  update chapters set archived_at = null, sort_order = v_next_order, chapter_number = v_next_num
    where id = p_chapter_id and book_id = p_book_id;
  return jsonb_build_object('status', 'reactivated', 'chapter_id', p_chapter_id, 'sort_order', v_next_order, 'chapter_number', v_next_num);
end; $$;

create or replace function add_chapter_at_end(p_book_id uuid, p_title text) returns jsonb
language plpgsql security invoker as $$
declare v_owner uuid; v_next_order int; v_next_num int; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_book_id::text));
  -- RLS also gates the insert; this select is RLS-scoped so it doubles as an
  -- ownership check (returns nothing for a book the caller can't see).
  select id into v_owner from books where id = p_book_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  select coalesce(max(sort_order), -1) + 1, coalesce(max(chapter_number), 0) + 1
    into v_next_order, v_next_num
    from chapters where book_id = p_book_id and archived_at is null;
  insert into chapters(book_id, chapter_number, title, sort_order)
    values (p_book_id, v_next_num, coalesce(nullif(p_title, ''), 'Chapter ' || v_next_num), v_next_order)
    returning id into v_id;
  return jsonb_build_object('status', 'created', 'chapter_id', v_id, 'sort_order', v_next_order, 'chapter_number', v_next_num);
end; $$;
