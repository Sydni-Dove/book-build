# Book Build — Handoff

Written 2026-08-31 for whichever agent, Codex, or human picks this up next. This session (Cowork, cloud sandbox) built the app up to this point but **cannot reach the live Supabase project or a deployment from its own network** — see "Known limitation" below. That's the reason this handoff exists: the next step has to happen somewhere with real network access and real API keys.

## What this is

"Book Build" — an AI-guided fiction-writing app for Sydni Howard (Dove Expressions: prophetic ministry / resource brand). Authors write a novel section by section; AI features help them develop scenes, continue writing, and (new) plan plot and outline before they write. The product philosophy: AI never writes the story or takes creative control — it interviews, asks questions, and helps the author externalize what they already know, then get it into structure.

Stack: Next.js 14 (App Router), TypeScript, Tailwind CSS, Supabase (Postgres + Auth + RLS), OpenAI API (`openai`) for every AI feature.

Supabase project: **"Section by Section"**, project ref `uqzuojurpygljsgkkici`, org `baknjmuvsyycoaodtshv`, region us-east-1. Reach it via the Supabase dashboard or the Supabase MCP tools if available in your environment.

## Getting it running

```
npm install
cp .env.local.example .env.local   # if no .env.local yet — see below
npm run dev
```

`.env.local` needs (get real values from the Supabase dashboard → Project Settings → API, and the OpenAI platform):

```
NEXT_PUBLIC_SUPABASE_URL=https://uqzuojurpygljsgkkici.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon/publishable key>
SUPABASE_SERVICE_ROLE_KEY=<service role key — server-only, not currently used by any route, but createServiceSupabase() in lib/supabase/server.ts is there if a future route needs an RLS-bypass path>
OPENAI_API_KEY=<real key>
OPENAI_MODEL=gpt-5-mini   # or current preferred model
```

The `.env.local` shipped in this package has the URL filled in and the rest as empty placeholders — this cloud sandbox never had working keys either, which is exactly the problem this handoff is about.

## What's done

### 1. Dove Expressions visual rebrand (complete, verified by build)

Full brand spec — colors, fonts, AI presentation style — is baked into `tailwind.config.ts` and `src/app/globals.css`:
- Burgundy #630000/#470000, Charcoal #1B1717, soft white #FDFDFD/#FFFFFF/#F7F1EE, Pale Gold #E6A742/#FAF0DC/#97621C, Sunrise #D97904, Coral #D96248, Pale Pink #F2DFD8. No dark mode.
- Playfair Display for headings/titles only; Lato for everything else, including AI copy and the manuscript body text itself.
- AI is presented as **editorial marginalia**: a bordered note with a small uppercase label (`EDITOR` / `YOU`), never a chat bubble or avatar. See the `.border-l-2` pattern in `DevelopThisPanel.tsx` and the PLAN pages for the canonical implementation.
- Four-state provenance system, always icon + label, never color alone: Working Note (○, pale pink), Author Canon (●, burgundy), Manuscript Fact (✓, charcoal), AI Suggestion (✦, pale gold). Not yet built as a shared chip component in production (it exists in the prototype's `.chip-*` CSS) — `canon_status`/`manuscript_status` data already carries this, the UI treatment for it is a nice next polish pass wherever canon facts are listed.
- "Story Bible" is retired everywhere user-facing → **"Story Canon"**. The route folder is `app/(app)/books/[bookId]/story-canon/`. The live DB table `story_bible_proposals` is intentionally left named as-is (already-applied schema, not user-facing) — don't rename it without a real migration.
- No device-frame/fake-notch mobile styling anywhere; `min-h-dvh` used app-wide (not `min-h-screen`) for correct mobile viewport/keyboard behavior; `env(safe-area-inset-*)` used in `AIPanel.tsx`'s mobile sheet and `MobileNav.tsx`'s bottom bar.
- **Real bug fixed this session**: shared `Input`/`Textarea` components (`src/components/ui/index.tsx`) and two hand-rolled fields rendered at 14px, which triggers iOS Safari's zoom-on-focus. Bumped to `text-base` (16px) everywhere. If you add any new form field anywhere in this app, use the shared `Input`/`Textarea` components, or explicitly set `text-base` — never `text-sm` on anything the user types into.

Design reference: `design-reference/prototype.html` in this package — a single-file interactive HTML prototype, already fully approved by Sydni, showing the whole visual language plus a designed-but-not-yet-built Manuscript Version History screen and the PLAN screens (which ARE now built in production — the prototype was the design spec PLAN's production build followed). Open it in a browser; it's self-contained.

### 2. PLAN feature (complete, migration applied live, **not yet verified end-to-end with real AI calls**)

PLAN is upstream of writing — it's how the author decides what happens before they write it. Distinct from the writing AI (Develop This / Help Me Continue). Migration `supabase/migrations/0004_plan.sql` is **already applied** to the live Supabase project (confirmed via schema inspection — tables exist, RLS enabled, advisors clean, partial unique indexes confirmed live). Do not re-apply it.

Layer boundary — this is a hard rule stated in every PLAN prompt and should stay true of any code you add:
- **STORY CANON** (`characters`, `settings`, `relationships`, `canon_facts`, etc.) = what is true
- **OUTLINE** (`story_outlines`, `story_outline_nodes`, `chapter_outlines`, `chapter_outline_scenes`, `outline_beats`) = what is planned
- **MANUSCRIPT** (`chapters`, `writing_sections`) = what has actually been written

Nothing in an outline becomes canon merely because it was planned. The only path from PLAN to `canon_facts` is the explicit "Save as Working Notes" / "Add to Story Canon" buttons on the interview screens, which insert Q&A pairs the author explicitly chose to bank — same pattern the existing Help Me Continue flow already used.

What's built:
- `src/lib/ai/planContext.ts` — `gatherChapterPlanningContext()` assembles chapter-planning context (previous chapter's ending, all characters/settings/relationships, active+dormant threads, recent author-canon facts, recent timeline, any already-existing outline for this chapter). `buildChapterPlanningRecap()` turns that into labeled sections used BOTH as the "Where We Are Now" UI recap and as the AI's system context — same source, so they can never drift apart. Deliberately separate from `src/lib/ai/context.ts`'s `gatherSectionContext()`, which is scoped to "the next writing section" and filters by what's actually mentioned in nearby prose — planning happens before prose exists, so there's usually nothing to mention-match.
- `src/lib/ai/prompts/plan.ts` — all PLAN prompts: `buildNewBookInterviewTurn`/`continueNewBookInterview` (Build My Story, Socratic one-question-at-a-time with a `[SUFFICIENT]` marker, same pattern as `develop.ts`), `buildPlotPossibilitiesPrompt` (3-5 genuinely different directions, pros/cons required), `buildBookOutlinePrompt` (Acts → Chapters skeleton once a direction is chosen), `buildChapterInterviewTurn`/`continueChapterInterview` (Plan This Chapter), `buildChapterOutlinePrompt` (Detailed Chapter Outline: purpose/opening/end state/continuity notes/open questions/scenes+beats). Plot holes are asked as questions (`open_questions`), never stated as declarations — this is enforced in the prompt text, worth keeping if you touch it.
- 6 API routes under `src/app/api/ai/plan/`: `new-book` (start/continue interview), `new-book/possibilities`, `new-book/finish` (persists `story_outlines` + `story_outline_nodes`), `chapter` (start/continue interview), `chapter/recap` (pure data assembly, no AI call), `chapter/finish` (persists a new `chapter_outlines` version + scenes + beats). All follow the existing `develop`/`continue` route conventions: `createServerSupabase()`, verify `auth.getUser()`, `callOpenAIText`/`callOpenAIStructured` from `src/lib/ai/client.ts`.
- `/books/[bookId]/plan` — Book Outline home (`src/app/(app)/books/[bookId]/plan/page.tsx`). No outline yet → Build My Story CTA → interview → Plot Possibilities → persisted Act/Chapter tree. Each chapter node either links into an already-materialized chapter or, on "Plan this chapter," materializes a real `chapters` row and backfills `story_outline_nodes.chapter_id` before routing into the chapter planner.
- `/books/[bookId]/plan/chapter/[chapterId]` — chapter planner (`.../plan/chapter/[chapterId]/page.tsx`). Recap → interview → Detailed Chapter Outline → Beat-by-Beat editor. Beats reorder via **Move Up/Move Down buttons that swap `sort_order` between adjacent rows** — same pattern the chapter list already used, deliberately no drag-and-drop (explicit mobile requirement). "Update Outline" re-enters the interview and always lands as chapter_outlines version N+1 — old versions are never edited in place, only superseded (`is_current = false`).
- Nav: "Plan" added to `Sidebar.tsx` (desktop) and `MobileNav.tsx` (persistent bottom tab + drawer link). "Plan this chapter →" link added to the manuscript chapter workspace header.

`tsc --noEmit` and `next build` both pass clean as of this handoff (17 routes generated including all 6 new API routes and both new pages).

### 3. Not yet done

- **Manuscript Version History** (`supabase/migrations/0003_manuscript_versions.sql`) — schema fully designed and reviewed, **file exists but migration is NOT applied**. This was deliberately sequenced after PLAN (Sydni's explicit instruction: build one large feature at a time, verify, then move on). Do not build both at once. The prototype (`design-reference/prototype.html`, nav tab "Version History") shows the full approved UI: one live Current Draft + named immutable snapshots, manual "Save Version" + automatic pre-operation snapshots, Compare (structural diff first, then textual diff), non-destructive Restore (always snapshots current state first as "before_restore"), Rename/Add Note, Current Draft undeletable, and **mobile must stack vertically, never two columns** in Compare.
- Chip component for the four-state provenance system (Working Note/Author Canon/Manuscript Fact/AI Suggestion) isn't factored out as a reusable component in production yet — it's implicit in the data (`canon_status`, `manuscript_status` columns) but not visually surfaced with icon+label anywhere outside the raw canon_facts table view.
- Several "Coming Soon" AI features (Describe This, Review Section, Continuity Check) remain UI stubs in `chapters/[chapterId]/page.tsx` — their prompt modules already exist in `lib/ai/prompts/`.

## Known limitation — why this handoff exists

The Cowork cloud sandbox this was built in has outbound network **blocked by org policy** to `*.supabase.co` and `vercel.com` (confirmed by direct connection attempts — `connect_rejected`, not a DNS or auth failure). Its `.env.local` never had a real AI provider key either. Net effect: **the PLAN feature's actual AI conversation (question quality, whether the structured outline/possibilities calls reliably return well-formed JSON, whether the recap context reads sensibly) has never been exercised against the real API or the real database.** Everything upstream of that — the migration (applied and inspected live via Supabase's management API, which uses a different access path than the app's own runtime), the TypeScript types, the route wiring, the build — has been verified.

**What to do here, in an environment with real network + real keys:**

1. `npm install`, fill in `.env.local` with real values, `npm run dev`.
2. Sign up a test account (`/signup`), or create one directly in the Supabase dashboard → Authentication.
3. Create a test book from `/dashboard`.
4. Go to `/books/<id>/plan`. Try **Build My Story** with a real seed idea. Answer 3-5 questions. Confirm the questions actually narrow in based on your previous answers (not a fixed checklist) and that a `[SUFFICIENT]` marker eventually triggers the "Give Me Plot Possibilities" button.
5. Get Plot Possibilities. Confirm you get 3-5 **genuinely different** directions (not reskins of one idea), each with real pros AND cons.
6. Choose one. Confirm a Book Outline (Acts → Chapters) appears and actually persists — reload the page, it should still be there (reading straight from `story_outlines`/`story_outline_nodes`).
7. Click "Plan this chapter" on an unplanned chapter. Confirm it materializes a real chapter (check `/books/<id>/chapters` — it should now be listed) and routes into the chapter planner.
8. Read the "Where We Are Now" recap. Confirm it's assembling real context, not empty sections, especially `previousChapterEnding` if you've written anything in an earlier chapter.
9. Run the chapter interview to `[SUFFICIENT]`, build the Detailed Chapter Outline, confirm scenes + beats render.
10. Test beat reorder (▲▼ buttons) and inline beat text editing (edits should persist — reload and check).
11. Click "Update Outline" — confirm it creates a NEW version (`chapter_outlines.version_number` increments) rather than overwriting.
12. Click "Start Writing" — confirm it lands in the normal chapter workspace.
13. Test the same flow at a real iPhone width (390×844 in dev tools, or an actual phone) — single column throughout, no horizontal scroll, beat text fields don't trigger iOS zoom (should already be fixed at 16px, but verify), touch targets on the ▲▼/✕ beat controls are comfortably tappable.
14. Try "Save as Working Notes" and "Add to Story Canon" on an interview transcript — confirm rows appear in `canon_facts` with the right `canon_status`.

Report anything that breaks, reads awkwardly, or produces a bad AI response (too many questions, a possibility that isn't genuinely different from the others, an outline that ignores established canon, etc.) — those are prompt-tuning issues in `src/lib/ai/prompts/plan.ts`, not architecture problems, and should be quick to fix once they're visible.

## Conventions to keep following

- **RLS pattern**: every table's policy is an ownership chain up to `books.user_id = auth.uid()` — see any `create policy` in `supabase/migrations/0004_plan.sql` for the pattern to copy.
- **Versioning pattern**: `is_current boolean` + a partial unique index (`... where is_current`) guarantees at the DB level that a book/chapter can never end up with two "current" rows. New version = insert new row with `is_current = true`, previous row's `is_current` set to `false` first. Never delete or edit an old version in place.
- **AI route pattern**: a route handler calls `createServerSupabase()`, checks `auth.getUser()`, gathers context (`gatherSectionContext` or `gatherChapterPlanningContext`), builds a prompt (`src/lib/ai/prompts/*.ts`), calls `callOpenAIText` (plain Socratic turn) or `callOpenAIStructured` (schema-backed JSON), then persists. Never call the OpenAI SDK directly from a route — always through `src/lib/ai/client.ts`.
- **`MASTER_AI_RULES`** (`src/lib/ai/masterRules.ts`) is injected into every AI call — it's the one place the "AI doesn't take creative control, doesn't invent facts, distinguishes manuscript fact / author canon / AI inference" philosophy lives. Any new AI feature should build its system prompt as `` `${MASTER_AI_RULES}\n\nTASK: ...` ``, same as every existing prompt module.
- **Migrations are additive and numbered.** Never edit an already-applied migration file after the fact — write a new one. Migrations 0001, 0002, and 0004 are applied; 0003 is not (see above).
