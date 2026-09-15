/**
 * Check-applicability resolution tests. Verifies book-type scoping and the
 * BOOK -> PROFILE -> SYSTEM DEFAULT precedence that keeps fiction rules off
 * nonfiction books and one user's preferences out of another user's books.
 * Run: npx tsx scripts/check-config.test.mts
 */
import { isCheckGroupActive, resolveActiveCheckGroups, CHECK_GROUP_APPLICABILITY } from '../src/lib/ai/review/checkConfig.ts';

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`); if (!cond) failures++; };

const FICTION_GROUPS = ['intensity', 'description', 'scene_setting', 'divine_speech', 'teaching'];
const UNIVERSAL_GROUPS = ['contrast_cadence', 'insistence', 'filler', 'repetition', 'emphatic'];

// SYSTEM DEFAULTS by book type.
check('fiction book: fiction checks active', FICTION_GROUPS.every((g) => isCheckGroupActive(g, { bookType: 'fiction' })));
check('fiction book: universal checks active', UNIVERSAL_GROUPS.every((g) => isCheckGroupActive(g, { bookType: 'fiction' })));
check('nonfiction book: fiction checks OFF', FICTION_GROUPS.every((g) => !isCheckGroupActive(g, { bookType: 'nonfiction' })));
check('nonfiction book: universal checks still active', UNIVERSAL_GROUPS.every((g) => isCheckGroupActive(g, { bookType: 'nonfiction' })));
check('no book type given: defaults to fiction (Awakened-safe)', isCheckGroupActive('scene_setting', {}));

// PROFILE preferences override SYSTEM DEFAULT.
check('profile can disable a group on a fiction book', !isCheckGroupActive('intensity', { bookType: 'fiction', profile: { disabled_check_groups: ['intensity'] } }));
check('profile can enable a fiction group on a nonfiction book', isCheckGroupActive('scene_setting', { bookType: 'nonfiction', profile: { enabled_check_groups: ['scene_setting'] } }));
check("profile does NOT affect groups it doesn't name", isCheckGroupActive('description', { bookType: 'fiction', profile: { disabled_check_groups: ['intensity'] } }));

// BOOK settings override PROFILE (most specific wins).
check('book enable overrides profile disable', isCheckGroupActive('intensity', { bookType: 'fiction', profile: { disabled_check_groups: ['intensity'] }, book: { book_type: 'fiction', enabled_check_groups: ['intensity'] } }));
check('book disable overrides profile enable', !isCheckGroupActive('scene_setting', { bookType: 'nonfiction', profile: { enabled_check_groups: ['scene_setting'] }, book: { book_type: 'nonfiction', disabled_check_groups: ['scene_setting'] } }));
check('book.book_type overrides ctx.bookType', !isCheckGroupActive('intensity', { bookType: 'fiction', book: { book_type: 'nonfiction' } }));

// Multi-user isolation: resolution is a pure function of the passed context, so
// user A's prefs cannot leak into user B's resolution.
const userA = resolveActiveCheckGroups([...FICTION_GROUPS, ...UNIVERSAL_GROUPS], { bookType: 'fiction', profile: { disabled_check_groups: ['intensity', 'teaching'] } });
const userB = resolveActiveCheckGroups([...FICTION_GROUPS, ...UNIVERSAL_GROUPS], { bookType: 'fiction' });
check("user A's disables do not affect user B", userB.has('intensity') && userB.has('teaching'));
check("user A's disables applied only to user A", !userA.has('intensity') && !userA.has('teaching') && userA.has('description'));

// Every registered fiction group is classified as fiction (guards accidental universal).
check('all fiction Voice Pass groups classified fiction', FICTION_GROUPS.every((g) => CHECK_GROUP_APPLICABILITY[g] === 'fiction'));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exit(1);
