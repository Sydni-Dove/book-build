# Book Build

A guided, page-by-page fiction-writing workspace. The author writes; AI asks questions, checks continuity, and never generates prose unless explicitly asked for a sample.

This README is the technical companion to the product architecture doc ("Book Build" — the page you already have). It answers the ten setup questions from the MVP brief before any implementation notes.

---

## 1. Folder structure

```
book-build/
├── middleware.ts                 # refreshes the Supabase session on every request; gates protected routes
├── supabase/
│   └── migrations/0001_init.sql  # full schema + RLS — run this first
└── src/
    ├── app/
    │   ├── page.tsx               # "/" → redirects to /dashboard or /login
    │   ├── (auth)/                # login, signup, reset-password — public
    │   ├── (app)/
    │   │   ├── dashboard/         # book list + create
    │   │   └── books/[bookId]/
    │   │       ├── layout.tsx     # fetches book+chapters, provides BookShell (Sidebar/MobileNav/AI sheet state)
    │   │       ├── settings/      # book fields + AI controls
    │   │       ├── chapters/      # chapter list, reorder, create
    │   │       │   └── [chapterId]/  # the writing workspace — this is the core screen
    │   │       └── story-bible/
    │   │           ├── characters/
    │   │           ├── locations/      # DB table is `settings`; the route is named locations to avoid colliding with book "settings"
    │   │           ├── relationships/  # dedicated page — needs two character selects, not generic
    │   │           ├── story-threads/
    │   │           ├── canon/
    │   │           └── timeline/
    │   └── api/ai/
    │       ├── continue/route.ts       # Help Me Continue
    │       └── develop/route.ts, develop/finish/route.ts   # Develop This (Socratic loop)
    ├── components/
    │   ├── layout/       # Sidebar, MobileNav, AIPanel, BookContext/BookShell
    │   ├── editor/        # SectionEditor (autosave), ChapterReader (continuous read-only view)
    │   ├── ai/             # HelpMeContinuePanel, DevelopThisPanel
    │   ├── storybible/   # StoryBibleTable — one generic CRUD component, config-driven
    │   └── ui/                # Button, Card, Field, Input, Textarea, SeverityTag, StatusPill
    ├── hooks/useAutosave.ts
    └── lib/
        ├── supabase/{client,server,middleware}.ts
        ├── types/database.ts
        └── ai/
            ├── client.ts        # OpenAI wrapper — structured JSON and plain-text calls
            ├── masterRules.ts   # the constant injected into every prompt
            ├── context.ts       # context assembly — see §3
            └── prompts/
                ├── continue.ts, develop.ts        # built and wired to routes
                └── description.ts, sectionReview.ts, chapterReview.ts, continuity.ts, summarize.ts
                    # designed, schema-ready, NOT wired to a route yet — see §9
```

One module per AI job (spec item 15) — nothing routes through one giant prompt. Every prompt file exports its own JSON schema and prompt-builder function; the route handlers are thin (assemble context → call the right prompt module → call OpenAI → persist).

---

## 2. Supabase schema

`supabase/migrations/0001_init.sql` has the authoritative version — run it via `supabase db push` or paste it into the SQL editor of a fresh project. Shape, in brief:

- **profiles** — one per `auth.users` row, created by a trigger on signup.
- **books → chapters → writing_sections** — the manuscript hierarchy. Chapters are never one text blob; `writing_sections` is the real writing unit, ordered by `sort_order`.
- **section_versions** — snapshots before AI-assisted edits (see §5).
- **characters, settings, relationships, story_threads** (+ `story_thread_characters` join) — the Story Bible.
- **canon_facts** — the provenance ledger. `source_type` is `manuscript | author_answer | manual`; `canon_status` is `tentative | confirmed`. The AI backend code never inserts a row here except through an explicit author action (Save Answers, Add to Canon) — there is no code path where an AI inference is written as a fact.
- **timeline_events** — date/time/relative-time beats, stored as given rather than normalized into a calendar.
- **ai_interviews / ai_interview_messages** — every Socratic loop (Develop This today; setting/character/continuity-fix interviews are the same shape for later).
- **section_reviews / review_issues** — ships now so Section Review and Chapter Review (§9) don't need a schema migration later, only UI + a route.

Every table traces back to `books.user_id` through its foreign keys, and RLS policies enforce exactly that chain on every table — see §7.

---

## 3. AI context retrieval

`lib/ai/context.ts` → `gatherSectionContext()`. Deliberately **relational + keyword matching, not embeddings** (per your note — pgvector is a fast-follow, not a Phase 1 dependency):

1. Fetch the book, the chapter, and the chapter's sections.
2. Take the current section (if any) plus the previous 1–3 sections as the literal text window.
3. Extract character/setting **mentions** by matching each Story Bible character/setting name as a whole-word regex against that text window — this is the "Daniella, Timothy, prophetic meeting → pull their records" behavior from the brief, no embeddings required.
4. Pull `story_threads` linked to any mentioned character (via `story_thread_characters`), falling back to the book's `Active` threads generally if no character-specific thread is found.
5. Pull `canon_facts` scoped to those same characters/settings, plus any book-level facts.
6. Pull the 5 most recent `timeline_events` for the book.

`renderContextBlock()` turns that structured object into the plain-text block every prompt embeds — so every prompt module shares one source of truth for "what does the AI currently know," and adding pgvector later means widening step 3/4's candidate set, not touching any prompt module or route.

---

## 4. AI response structure (JSON)

Every feature that needs structured output goes through `callOpenAIStructured()` in `lib/ai/client.ts`, which uses OpenAI Structured Outputs with the desired JSON Schema — not "ask nicely for JSON in the system prompt." This is why `CONTINUE_SCHEMA`, `DEVELOPMENT_NOTES_SCHEMA`, `SECTION_REVIEW_SCHEMA`, etc. exist as JSON Schema objects next to each prompt: the schema is the contract, not documentation of one.

The one exception is the Develop This turn-by-turn loop (`callOpenAIText`), which is intentionally plain text — forcing a single Socratic question through a JSON envelope adds nothing and makes the `[SUFFICIENT]` marker harder to reason about than a plain string.

---

## 5. Autosave & version history

`hooks/useAutosave.ts`: content lives in React state immediately on keystroke; a save fires 800ms after typing stops. On failure, status flips to an inline "Couldn't save — retrying…" and a 5-second retry interval starts — **the local state is never cleared**, so a flaky connection never costs the author a sentence. A new edit during a retry loop naturally supersedes it with the latest text.

`section_versions` exists now (created by the migration) even though nothing writes to it yet outside the schema — the intended callers are the AI-assisted-edit flows (Fix With Me, Chapter Review) in §9, tagged `before_fix` / `chapter_review`, plus a manual "snapshot" action. Wiring this in is a small addition once those flows exist; the storage is already there so it never becomes a migration blocker.

---

## 6. Mobile architecture

`BookContext` holds one boolean (`aiSheetOpen`) shared by `MobileNav` (the trigger) and `AIPanel` (the sheet) — no prop drilling, no page-specific wiring. Below `lg`:

- The manuscript is full width; `Sidebar` (desktop) is hidden entirely.
- `MobileNav` renders a bottom tab bar (Chapters / Write / Story / AI) fixed to the viewport bottom, safe-area aware. "Chapters" opens a full-height drawer with the same nav as the desktop sidebar.
- `AIPanel` renders nothing extra on mobile until `aiSheetOpen` is true, then shows a bottom sheet capped at 80vh with its own scroll region — same tab strip, same content components as desktop, so behavior never diverges by device.
- The editor textarea and every container use relative widths / `overflow-x: auto` where needed — nothing in the workspace can force horizontal scroll on an iPhone viewport.

---

## 7. Security

Row Level Security is enabled on every table (`0001_init.sql`, bottom section). The pattern is consistent: a table either has `user_id` directly (`books`) or a policy that walks its foreign keys back to a `books` row owned by `auth.uid()`. This is enforced at the database layer — the app's Supabase calls run under the signed-in user's session (`createServerSupabase()` / browser `createClient()`), never the service-role key, so a bug in a page component cannot leak another author's book. `createServiceSupabase()` exists in `lib/supabase/server.ts` for future admin-only jobs and is not imported anywhere in the app today — grep for it before ever calling it from a user-facing route.

## 8. Data-loss risks worth naming

- **Autosave race on rapid navigation** — if an author edits and immediately navigates away inside the 800ms debounce window, the last keystrokes could be lost before the timer fires. Not handled yet; the fix is a `beforeunload`/route-change flush, worth adding before this ships to a real user.
- **No offline queue** — the retry logic in §5 handles a flaky connection while the tab stays open; it does not persist across a hard refresh or app close mid-retry. Acceptable for MVP, called out for Phase 3 ("mobile offline support" is already on your future list).
- **Chapter/section delete has no confirmation beyond the book-delete flow** — worth a "are you sure" pass before this is used on a real manuscript.

---

## 9. What's actually wired vs. designed-only

**Real and working:** auth (signup/login/logout/reset), book CRUD, chapter CRUD + reordering, section create + autosave, Story Bible CRUD (characters, settings, relationships, story threads, canon facts, timeline), Help Me Continue (full context assembly → structured questions → Save/Add to Canon), Develop This (full Socratic loop → Development Notes → Add to Canon).

**Schema-ready, prompt-designed, not yet wired to a route or button:** Describe This / Setting Builder, Section Review, Chapter Review, Fix With Me, Continuity conflict alerts, section/chapter summaries. Their prompt modules and JSON schemas already exist in `lib/ai/prompts/` with the exact contract they'll return — wiring one in is "write a route that calls the existing builder function + a panel that renders the result," not new design work.

**Not started, matches your "what not to build yet" list:** DOCX/manuscript import, existing-manuscript analysis, pgvector/semantic search, style profile page, real-time collaboration, and everything else in that list.

### Recommended order from here

1. Get this scaffold running against a real Supabase project (see Setup below) and confirm auth → dashboard → chapter → autosave actually persists.
2. Confirm Help Me Continue and Develop This produce good questions against a real chapter of Awakened — this is the part worth testing hardest, since it's the product's actual differentiator.
3. Wire Section Review next (schema and prompt already exist) — it's the shortest path to closing the full loop: write → review → fix.
4. Then Fix With Me, then Chapter Review, then Describe This.
5. Import (DOCX) last, using Awakened as the real test case once the Story Bible tables it populates are trustworthy for a book already in progress.

---

## Setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase + OpenAI keys
# apply supabase/migrations/0001_init.sql to your Supabase project
npm run dev
```

Deploy: push to a Git repo, import into Vercel, set the same env vars there. No server-side build step beyond `next build` — this is a standard Next.js app.
