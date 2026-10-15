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

---

## Vercel storage audit (2026-10-15) — READ-ONLY, nothing deleted

Scope: Vercel team `sydni-doves-projects` (Hobby plan, 16 projects). Audit only; no deployments, branches, env vars, domains or Supabase projects were changed.

**What 100% means is NOT yet confirmed.** The Vercel tools available to the audit session cannot read the Usage page, and the billing-charges API returns `costs_not_found` on Hobby. The user must open Vercel -> Settings -> Usage and note which meter is at 100% (Blob storage, build/fast data transfer, edge requests, function invocations, source/build minutes, etc.). Hobby does not meter "deployment storage" as such, so deleting deployments may not move the number.

**Deletion is not available through the Vercel MCP** (no delete-deployment tool). Approved deletions must be done with the Vercel CLI (`vercel remove <url>`) or the dashboard.

Deployments seen (87; listing appears incomplete — the alias list references dozens of deployment IDs for journal-color-studio, dove-product-studio and the journal app that the deployment listing does not return, so they may already be expired or the listing is capped):

| Project | Seen | Notes |
|---|---|---|
| dove-expressions-journal-app (Hearing God, app.doveexpressions.org) | 21 | Prod from `main`: dpl_EaUzoRp4 (#56, current), dpl_8agzhAd6 (#54), dpl_jaY5CVpg. 5 BLOCKED (never served). 13 branch previews. Newest preview is `claude/hearing-god-open-beta-4fzb9t`, not on main. |
| journal-color-studio | 6 | Prod dpl_5pnJ1oDy. 3 active Phase 8.1 previews. |
| dove-product-studio | 7 | Prod dpl_8dqUK2Lt. 2 CANCELED. Builds from the journal-color-studio repo. |
| vocal-arrangement-studio | 7 | Prod is serving the mood-tracker/`-prophetic-word-journal` commit (misattributed — needs review). |
| learning-hub 6, dashboard 5, rehearsal-director 6, prophetic-word-journal 6, book-build 4, video-transcriber 3, kids-dream-journal 3 + eeak 3, mood-tracker 3, dreamjournaltemplategenerator 3 + fez9 3, spiritual-wiring 1 | | mostly production history; no failed except book-build 1 ERROR |

Proposed categories (PROPOSAL — awaiting user approval, none executed):
- SAFE TO DELETE: dpl_88hijdST, dpl_ExUedqGZ (CANCELED, product-studio); dpl_DsHLMKCj (ERROR, book-build); BLOCKED journal-app deployments dpl_5SSAbsno, dpl_2pBbFh15, dpl_HtEKBTsg, dpl_5QNRTQMY, dpl_Ubbb2an1; duplicate dreamjournaltemplategenerator / -fez9 pairs of the same commit only if one project is retired (user decision).
- KEEP: every current production deployment and anything behind a custom domain (app.doveexpressions.org), `isRollbackCandidate: true` deployments, all previews on branches with open PRs/active work.
- NEEDS REVIEW: all journal-app branch previews (check each branch is merged on GitHub first — the open-beta features are not on main), vocal-arrangement-studio production source, duplicate project pairs.

Estimated recovery: not measurable with the available tools (per-deployment size is not exposed). Next steps: user confirms the 100% meter, then approves a list.

### Addendum (2026-10-15, later) — meter confirmed, correction

- **The meter at 100% is Deployment Storage: 10.08 GB of 10 GB (free tier).** From the user's Usage-page screenshots: Functions Storage 637.8 MB, Build Artifacts 0 B, Blob/Data storage 0 B, Function Invocations 761, Build CPU 32h 36m. So deleting deployments is the correct lever; Blob/cache/artifacts are not contributing.
- **Correction:** the stale aliases in the alias list point at deployments that return 404 (already expired/deleted), so the deployment listing of 87 appears complete. The earlier "listing may be incomplete" note is withdrawn.
- Per-deployment size is not exposed by the MCP tools (git deployments have no file tree), so recovery can only be estimated: 10.08 GB / 87 deployments is about 115 MB average. Target: get comfortably below 10 GB (about 8 GB), i.e. roughly 15-20 deployments.
- Still read-only. No deletions have been run; awaiting approval of the tiered list.

---

## Vercel storage audit v2 (2026-10-15) — VERIFIED FINDINGS + CLEANUP PLAN

**Status: AUDIT ONLY. NOTHING DELETED, DEPLOYED, MERGED OR RECONFIGURED. APPROVAL: PENDING (no list approved).**
This section supersedes the "meter not confirmed" and "listing incomplete" notes above; earlier completed findings are kept.

### 1. Metric at 100% (source: Vercel "approaching your limits" email + Usage page screenshots supplied by the user; the audit session has no dashboard access)
- **Deployment Storage: 10.08 GB used / 10 GB included (Hobby/free team `sydni-doves-projects`).** Over by about 0.08 GB.
- Not the cause: Functions Storage 637.8 MB (separate line), Build Artifacts 0 B, Blob 0 B, Blob/Data Storage 0 B, Edge Function/Middleware 0, Function Invocations 761, Build CPU 32h36m. Build cache is not a metered line here, so clearing caches would not help.
- Billing period: the Usage page showed "Last 30 days, Sep 15 5pm - Oct 15 5pm". Deployment Storage is a stock (what is stored now), so the billing-cycle start was not confirmed.
- **Per-project Deployment/Functions Storage: NOT AVAILABLE.** Neither the Vercel API tools nor the observability metrics expose it. Needs the Usage page "Deployment Storage" project breakdown (user screenshot).

### 2. Deployment inventory: 89 across 16 projects (state counts: failed/canceled/blocked 10)
book-build now has 3 ERROR deployments: 1 is the open-PR #1 tip (`feat/chapter-review-continuity-history`), **2 were created by this audit's own pushes** to `claude/vercel-storage-cleanup-yzycj3` (Vercel builds every pushed branch and book-build's preview build fails). Pushes of this and later commits use `[skip ci]`; verify that suppressed the build.

### 3. Production map (resolved by hostname; the newest deployment is NOT always the one serving)
| Project | Serving production deployment | Branch @ commit | Domain(s) | Notes |
|---|---|---|---|---|
| dove-expressions-journal-app (Hearing God) | dpl_EaUzoRp4 | main @ 5d8aa6a (PR #56) | **app.doveexpressions.org**, dove-expressions-journal-app.vercel.app | == main HEAD |
| journal-color-studio | dpl_5pnJ1oDy | main @ 438c941 | journal-color-studio.vercel.app | == main HEAD |
| dove-product-studio | dpl_8dqUK2Lt | main @ 047aa23 | dove-product-studio.vercel.app | **One commit behind main**: the 438c941 build (dpl_ExUedqGZ) was CANCELED; 438c941 is a HANDOFF-only commit |
| vocal-arrangement-studio | dpl_6DEL1k9C | main @ 94783cc of repo `-prophetic-word-journal` ("Add Sydni mood tracker HTML"), source=redeploy | vocal-arrangement-studio.vercel.app | **Production serves a different repo's mood-tracker HTML, not the vocal app** (the real app only exists as previews). Needs owner decision |
| dove-expressions-learning-hub | dpl_9R64y7e8 | main @ 0265bc5 | dove-expressions-learning-hub.vercel.app | == main HEAD |
| dove-video-transcriber | dpl_5omDz8Fs | main @ da5c011 | dove-video-transcriber.vercel.app | |
| dove-expressions-dashboard | dpl_ESKguBFF | main @ 511a48a | dove-expressions-dashboard.vercel.app | == main HEAD |
| book-build | dpl_DUjMaVNF | main @ 3f0fdb8 | book-build-pi.vercel.app | == main HEAD |
| dove-rehearsal-director | dpl_2fgSEWJZ | no git metadata (CLI/redeploy) | dove-rehearsal-director.vercel.app | cannot confirm it matches main (54029620) |
| kids-dream-journal / -eeak | dpl_xyKbs82A / dpl_HkSfp4VY | main @ 6f5e2ba (both) | *.vercel.app | duplicate project pair |
| prophetic-word-journal | dpl_4AfKrkaf | main @ 30f741c ("Add Sydni mood tracker HTML") | prophetic-word-journal.vercel.app | earlier prods were the real journal (dpl_5NXSrWt2 = rollback) |
| mood-tracker | dpl_9HiMPfyQ | main @ 2634560 | mood-tracker-eta-five.vercel.app | |
| spiritual-wiring-profile-generator | dpl_4W4rQoL2 | main @ ccf9ac5 | *.vercel.app | only deployment |
| dreamjournaltemplategenerator / -fez9 | dpl_Cf4y4Kdj / dpl_79riU4Ar | main @ ebe8434 (both) | *.vercel.app | duplicate project pair |

Only **app.doveexpressions.org** is a custom domain; every other URL is a *.vercel.app alias. Project git-branch aliases for deleted deployments were stale (404), so they are not a concern.

### 4. Hearing God divergence (verified against git)
- Current `main` has only 116 commits since 2026-09-02 (history re-rooted). The August production-era commits (8fc8f29, dc96b0a, 05dc10c, a8bea7e) are **not in main** but are preserved on old branches (`claude/hearing-god-edit-nav-bug-8gjzsr`, `agent/...`, `claude/offline-reading-and-uploaded-music`, etc.). `9e913ab` only lives on `claude/hearing-guide-tts-issues-hyt3z6` (268 commits not in main). `4925f53` (behind BLOCKED dpl_Ubbb2an1) is no longer reachable in git, but that deployment was BLOCKED and never built, so it holds no retrievable code.
- All three production deployments on main (5d8aa6a, 68bf023, a1dee84) ARE ancestors of main today, so production and main currently match.
- **Unmerged work that exists only as a Vercel preview build**: `claude/hearing-god-open-beta-4fzb9t` (ad3b64b, 1 commit, 20 files incl. `beta-signup-complete` function and an open-beta SQL migration) -> dpl_2MbE2g9V. No PR is open for it. KEEP until merged.
- 12 open PRs (#57, #51, #49, #47, #43, #42, #40, #39, #38, #37 draft, #16, #2 draft); each has exactly one READY preview. KEEP all until the PR is merged or closed. PR #51's commit is patch-equivalent to something already in main (git cherry), so dpl_EKNRV2Vu is NEEDS REVIEW rather than KEEP.

### 5. Product Studio vs Journal Color Studio (read-only check, build config untouched)
Both projects build repo `journal-color-studio`. Of Product Studio's 7 deployments, 6 share a commit with a Journal Color Studio deployment (89f054b, 047aa23, d706cad, fe049b5 built READY in both; 438c941 and 62050cf READY in JCS but CANCELED in PS). Each push therefore produces about two deployments. Whether both are needed is an owner decision; no setting was changed.

### 6. Classification (89 total: SAFE 31, NEEDS REVIEW 9, KEEP 49). Per-deployment size is not exposed, so recovery is NOT estimated.
All URLs end `-sydni-doves-projects.vercel.app`. Order = proposed deletion order.

**Tier 1 - failed / canceled / blocked (10), SAFE TO DELETE**
| ID | URL prefix | Reason |
|---|---|---|
| dpl_88hijdST31e6mn4WTD3XkTjeuv6m | dove-product-studio-g3u2fmifv | CANCELED preview, superseded |
| dpl_ExUedqGZNARKzcPCYPLLvmcJAXXu | dove-product-studio-qn43ssrlc | CANCELED, never served (HANDOFF-only commit) |
| dpl_8f1S9VCmaFxgDGdXFusr39sHAdiW | book-build-o9ud50gui | ERROR, created by audit push |
| dpl_Fofmmh4op9YU7Qp8cfssE5FP7wz5 | book-build-56wf92g8k | ERROR, created by audit push |
| dpl_DsHLMKCj8oxDoedPcFrKAvYTwuQN | book-build-pp5ut5yp3 | ERROR on open PR #1 tip; deleting loses no code, but diagnose why the build fails first |
| dpl_5SSAbsnozbxZQxTwaAehSQTMpRsG | dove-expressions-journal-g01fylxzk | BLOCKED, never built |
| dpl_2pBbFh15BuLNSctSGaoKSv76gR8m | dove-expressions-journal-nryw9gt0e | BLOCKED, never built |
| dpl_HtEKBTsgV8xCii3d5d4VUSq68Hco | dove-expressions-journal-ps882itkc | BLOCKED, never built |
| dpl_5QNRTQMY4Nk8N5vPqCi6FtncknVt | dove-expressions-journal-4qeeyh403 | BLOCKED; source 9e913ab kept on branch |
| dpl_Ubbb2an1FgsYLtoVgEYrT6iEi2qa | dove-expressions-journal-h5y7f5vx6 | BLOCKED; never built, no retrievable code |

**Tier 2 - superseded previews on the same branch (8), SAFE TO DELETE**
dpl_95ZfkLXTD2hePB8nj7wdyzzBmJ8j (journal-color-studio-3c9pri88u, older commit on phase8.1 branch); dpl_962BQcwmtiAd1x8NSHGXGvTQNShK (vocal-arrangement-studio-b60fpigyr); dpl_46DhDQWNpf9yVoy1pjLF9WLdk9Cx (vocal-arrangement-studio-8vaqpxskv); dpl_3ZsP5Hna8psENVA1EWx2hVwzQZu7 (dove-expressions-learning-fd81yb44r); dpl_C1FDaeMHXQThpKhVfDNhLECKbL1b (dove-expressions-learning-hy5zz770c); dpl_HFf2mxM4jU3RdvbcPm7n56E37JFA (dove-rehearsal-director-1d63466jm); dpl_D5BemGfDuwEs78S619u4Mf9mtqqF (dove-rehearsal-director-hw2jy3981); dpl_Fk8JhhoKJEnXLwWyrTNbyDxnwvXc (dove-expressions-dashboard-eqnnl5o3r). Each is an older commit of a branch whose newer tip is kept.

**Tier 3 - superseded or duplicate production history, not rollback points (13), SAFE TO DELETE**
dpl_jaY5CVpgmEt72oLCpfa5RaLPKWfV (Hearing God, a1dee84, in main, two newer prods kept); dpl_HpJgHWQcy9K2TZsjCinxpJneF9rj (journal-color-studio, Phase 8 merge, later prods same app code); dpl_7mXdj2cD6YNQ62JwAVJzjXAYREN7 and dpl_7tsmj4bLmWoERoZqfd4vYuFs2P8V (vocal, same commit 94783cc as serving deploy); dpl_2G9Am6iRFLFmcEXCwL3M4oeTWzcv (learning-hub); dpl_4eK8jzSDKc2Gq1YpUdGYC4au7g22 (video-transcriber); dpl_AKFGemBRVwe1CfX7bCn9SLkGB7y8 (dashboard); dpl_8FWX6CVGMSGPeUFbxsngFCrdWEgo (book-build); dpl_CkfzfopWj6zdLqDdsgEjPHuacfc5 and dpl_Dj5KWqpBJ6KLoPYJK2X4o3EANxNC (kids-dream-journal pair); dpl_EBNHSocndYpduYwjTdn9zaLdeom8 (mood-tracker, same commit as rollback); dpl_9PnDNsSVKbCs7qUGAJYHrgAmq2MT and dpl_ANeBujjNMjm49hXKXHJtf8BqEMov (dreamjournaltemplategenerator pair).

**NEEDS REVIEW (9) - do not delete without an explicit decision**
| ID | Why |
|---|---|
| dpl_EKNRV2VuqBaSeJ7BhKm4UezMFM93 (Hearing God, fix/hearing-god-audio-cache, PR #51 open) | commit is patch-equivalent to main; confirm PR #51 is obsolete |
| dpl_7uGBmnshpPjbC37ALu5Wc83HsFR2 (product-studio) | last pre-Phase-8 production baseline |
| dpl_G2W42FRXkuhxpf1oC4MDvCfac4WX (vocal) | preview of the misfiled mood-tracker commit |
| dpl_214XnwPXYP4fXaYcNPJhn53Vv89D (dashboard) | tip of still-existing `fix/supabase-egress`; content appears shipped in prod via squash but not diff-verified |
| dpl_4KcSThSkgUcKP6xNYzWnHf48Bf6i (rehearsal-director) | old prod, no git metadata |
| dpl_8S9apKGLB1szYzw6GNcyeQmFbeDs (prophetic-word-journal) | older real-journal production, not rollback-flagged |
| dpl_646398DYvF1dyBmf2ETMYajzhMnd, dpl_CVdnFjqm6x4XTJeLj9vs5EwknJuY, dpl_6m7mgYNkc8kVAvpP1wqDkRW1Dnw4 (prophetic-word-journal) | previews of old dashboard branch; repo `-prophetic-word-journal` was not inspected |

**KEEP (49)** - every serving production deployment above; every `isRollbackCandidate` production (Hearing God dpl_8agzhAd6, JCS dpl_GjpXgURi, Product Studio dpl_J5xabWw8, learning-hub dpl_3d5yKSuV, dashboard dpl_AzhJfQV9, book-build dpl_HJHRmDnT, rehearsal dpl_8jaBZ6WH, video-transcriber dpl_7jJWHS9S, kids pair dpl_2UhB8YtG / dpl_A7Bpg9Mg, prophetic dpl_5NXSrWt2, mood dpl_DZB2j77T, dream pair dpl_2M5RLDQe / dpl_Bfx3vi3M); and the active tip previews: Hearing God 12 open-PR previews + open-beta dpl_2MbE2g9V, JCS dpl_HmX33UcA and dpl_CFtsyo56, Product Studio dpl_DcSeyzV4 and dpl_27KzmiMj, vocal dpl_HDhYx1GH, learning-hub dpl_9k6sMHhG, rehearsal dpl_4xa23nkv (PR #2).

### 7. Will cleanup reduce the 100%?
- The only meter at/over its limit is Deployment Storage, which is what deleting deployments targets. Build cache, Functions Storage, Blob and artifacts are not the cause.
- Only about 0.08 GB must be freed to get under 100%. Whether the 31 SAFE deletions achieve that **cannot be measured**: failed/canceled/blocked builds may hold little or nothing. Delete tier by tier and recheck the Usage page after each tier.
- **Unverified:** Vercel documents a 30-day recovery period before a deleted deployment is permanently cleaned up. Whether the storage meter drops immediately or after that period was not confirmed; recheck Usage after the first tier to learn this.
- Project-level removal (duplicate projects) would likely free the most space but is not part of this plan.

### 8. Authorization limitations
- The Vercel MCP exposes no delete-deployment tool. Deletion path once approved: `vercel remove <url>` (supports multiple URLs; `--safe` skips deployments with an active preview URL or production domain) or `DELETE /v13/deployments/{id}`, or the dashboard.
- No dashboard access from the audit session; storage figures come from the user's screenshots.
- Repos read this session: dove-expressions-journal-app, book-build (in scope); dove-expressions-dashboard, rehearsal-director, vocal-arrangement-studio (attached read-scope during this audit); journal-color-studio and dove-expressions-learning-hub (public, git branch lists only, PR status not readable); `-prophetic-word-journal` not inspected.

### 9. Recommended retention policy (not applied)
1. Production: keep the serving deployment + the 2 most recent rollback points per project; never touch anything behind app.doveexpressions.org.
2. Previews: keep only the newest preview per open-PR/active branch; delete superseded commits after each push or merge. Re-check Hearing God against `git branch --no-merged main` before removing any preview.
3. Failed/canceled/blocked: delete after diagnosis, within about a week.
4. Duplicate builds: decide if Product Studio and Journal Color Studio (and the kids-dream-journal and dreamjournaltemplategenerator pairs) both need to exist; consolidate or add an Ignored Build Step so docs-only commits (HANDOFF) and non-PR branches do not build.
5. Per-project Deployment Retention (project settings; `vercel list --policy` shows it) can expire preview/errored/canceled deployments automatically; exact default periods and plan availability were not verified, so confirm in the dashboard before relying on it.
6. Pro plan is not required just because of this stock overage; revisit only if usage returns to the limit after cleanup and the retention policy.

### 10. Approval status
PENDING. Awaiting the user's explicit approval of Tier 1 / Tier 2 / Tier 3 (or edits), and decisions on the 9 NEEDS REVIEW items, the duplicate project pairs, and the vocal-arrangement-studio production source.
