/**
 * Check applicability + resolution — the ONE place that decides which review
 * check groups run for a given book. It runs NO checks itself; the existing
 * phrasing / continuity engines do. It only answers "is this group active here?"
 * so we have one checks system with different applicable rule sets, not two.
 *
 * Three configuration levels, resolved in precedence order (most specific wins):
 *   1. BOOK SETTINGS      (this book, this user)    — book_type + per-book overrides
 *   2. USER PROFILE PREFS (this user, across books) — profile-level enable/disable
 *   3. SYSTEM DEFAULTS    (all users, all books)    — applicability by book type
 *
 * Multi-user safety is inherited from where the inputs come from: book_type lives
 * on the user's own `books` row and profile prefs on their own `profiles` row —
 * both RLS-scoped to auth.uid(). Nothing here is global mutable state, so one
 * author's settings can never influence another author's books, and a book-level
 * choice (e.g. Awakened's fiction rules) never leaks to the user's other books.
 *
 * Editorial accept/reject decisions are deliberately NOT part of this module:
 * those stay project-scoped on review_findings and must never be auto-promoted
 * into profile-level preferences here.
 */

export type BookType = 'fiction' | 'nonfiction';
export type CheckApplicability = 'universal' | 'fiction' | 'nonfiction';

export const DEFAULT_BOOK_TYPE: BookType = 'fiction';

/**
 * SYSTEM DEFAULTS — what Book Build is capable of checking, and for which book
 * type each check GROUP is on by default. `universal` groups run for every book;
 * `fiction` / `nonfiction` groups run only for their matching book type.
 *
 * Keys are phrasing-report group keys (see phrasing.ts). A group with no entry
 * here is treated as `universal` (safe, non-breaking) — but prefer an explicit
 * entry so applicability is always intentional.
 */
export const CHECK_GROUP_APPLICABILITY: Record<string, CheckApplicability> = {
  // Universal prose-health tells — both fiction and nonfiction.
  contrast_cadence: 'universal',
  insistence: 'universal',
  filler: 'universal',
  repetition: 'universal',
  emphatic: 'universal',
  // Fiction / narrative checks — the Awakened Voice Pass family. These must NOT
  // run automatically against a standard nonfiction manuscript.
  intensity: 'fiction',
  description: 'fiction',
  scene_setting: 'fiction',
  divine_speech: 'fiction',
  teaching: 'fiction'
  // Future nonfiction-specific groups register here with applicability 'nonfiction'.
};

/**
 * USER PROFILE WRITING PREFERENCES — reusable, per-user, applied across the
 * user's books unless a book overrides them. Scoped by user id (profiles row).
 * Kept intentionally small; register-level preferences (conversational/formal,
 * strictness, etc.) can be added here later without changing the resolver shape.
 */
export type WritingPreferences = {
  disabled_check_groups?: string[]; // groups this user generally wants off
  enabled_check_groups?: string[];  // groups this user generally wants on
};

/**
 * BOOK-SPECIFIC SETTINGS — override profile defaults for one book. `book_type`
 * is the concrete field today; per-book enable/disable overrides are supported
 * by the resolver for when book-level check configuration is surfaced in the UI.
 */
export type BookCheckSettings = {
  book_type?: BookType | null;
  disabled_check_groups?: string[];
  enabled_check_groups?: string[];
};

export type CheckContext = {
  bookType?: BookType | null;
  profile?: WritingPreferences | null;
  book?: BookCheckSettings | null;
};

export function applicabilityOf(groupKey: string): CheckApplicability {
  return CHECK_GROUP_APPLICABILITY[groupKey] ?? 'universal';
}

// SYSTEM DEFAULT: does this group's applicability admit it for this book type?
function systemDefaultActive(groupKey: string, bookType: BookType): boolean {
  const a = applicabilityOf(groupKey);
  return a === 'universal' || a === bookType;
}

/**
 * Resolve whether ONE check group is active for a book, applying
 * BOOK → PROFILE → SYSTEM DEFAULT precedence. An explicit enable/disable at a
 * more specific level always beats a broader one; with no override we fall to
 * the system default for the resolved book type.
 */
export function isCheckGroupActive(groupKey: string, ctx: CheckContext = {}): boolean {
  const bookType = ctx.book?.book_type ?? ctx.bookType ?? DEFAULT_BOOK_TYPE;
  // 1. BOOK SETTINGS (most specific).
  if (ctx.book?.disabled_check_groups?.includes(groupKey)) return false;
  if (ctx.book?.enabled_check_groups?.includes(groupKey)) return true;
  // 2. USER PROFILE PREFERENCES.
  if (ctx.profile?.disabled_check_groups?.includes(groupKey)) return false;
  if (ctx.profile?.enabled_check_groups?.includes(groupKey)) return true;
  // 3. SYSTEM DEFAULTS (applicability by book type).
  return systemDefaultActive(groupKey, bookType);
}

// Filter a set of group keys down to the ones active in this context.
export function resolveActiveCheckGroups(groupKeys: readonly string[], ctx: CheckContext = {}): Set<string> {
  return new Set(groupKeys.filter((k) => isCheckGroupActive(k, ctx)));
}
