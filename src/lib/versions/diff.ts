// Pure comparison logic for Version History's Compare screen. No Supabase, no
// React — the compare route assembles rows and hands them here so this stays
// unit-testable. Two levels, matching the approved prototype:
//   1. Structural diff  — chapters added / removed / renamed / changed.
//   2. Textual diff     — line-level old-vs-new for one changed chapter.

export type SnapshotSectionInput = {
  source_section_id: string | null;
  chapter_number: number | null;
  chapter_title: string;
  scene_title: string | null;
  section_order: number;
  content: string;
};

export type CurrentChapterInput = {
  id: string;
  chapter_number: number | null;
  title: string;
  sort_order: number;
};

export type CurrentSectionInput = {
  id: string;
  chapter_id: string;
  sort_order: number;
  title: string | null;
  content: string;
};

export type StructuralChange = {
  type: 'added' | 'removed' | 'renamed' | 'changed';
  chapterKey: string;
  chapterNumber: number | null;
  // For renamed, `title` is the NEW title and `fromTitle` the old one.
  title: string;
  fromTitle?: string;
  detail: string;
};

export type StructuralDiff = {
  changes: StructuralChange[];
  // Chapters whose prose actually differs — the ones worth a textual diff.
  changedChapters: { chapterKey: string; chapterNumber: number | null; title: string }[];
};

// A chapter is identified across a snapshot and the live draft by its number
// when it has one (numbers are the stable spine of a manuscript), falling
// back to title only for the rare unnumbered chapter.
function chapterKey(chapterNumber: number | null, title: string): string {
  return chapterNumber != null ? `n:${chapterNumber}` : `t:${title.trim().toLowerCase()}`;
}

// Nulls (unnumbered chapters) sort after numbered ones, then by title.
function compareChapters(a: { chapterNumber: number | null; title: string }, b: { chapterNumber: number | null; title: string }): number {
  if (a.chapterNumber != null && b.chapterNumber != null) return a.chapterNumber - b.chapterNumber;
  if (a.chapterNumber != null) return -1;
  if (b.chapterNumber != null) return 1;
  return a.title.localeCompare(b.title);
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

type ChapterGroup = {
  chapterKey: string;
  chapterNumber: number | null;
  title: string;
};

export function computeStructuralDiff(
  snapshotSections: SnapshotSectionInput[],
  currentChapters: CurrentChapterInput[],
  currentSections: CurrentSectionInput[]
): StructuralDiff {
  // --- Snapshot side, grouped into chapters ---
  const snapshotGroups = new Map<
    string,
    ChapterGroup & { sections: SnapshotSectionInput[] }
  >();
  for (const s of snapshotSections) {
    const key = chapterKey(s.chapter_number, s.chapter_title);
    let group = snapshotGroups.get(key);
    if (!group) {
      group = { chapterKey: key, chapterNumber: s.chapter_number, title: s.chapter_title, sections: [] };
      snapshotGroups.set(key, group);
    }
    group.sections.push(s);
  }
  for (const g of snapshotGroups.values()) g.sections.sort((a, b) => a.section_order - b.section_order);

  // --- Current side, grouped into chapters ---
  const sectionsByChapter = new Map<string, CurrentSectionInput[]>();
  for (const s of currentSections) {
    const list = sectionsByChapter.get(s.chapter_id) ?? [];
    list.push(s);
    sectionsByChapter.set(s.chapter_id, list);
  }
  const currentGroups = new Map<
    string,
    ChapterGroup & { sections: CurrentSectionInput[] }
  >();
  for (const c of currentChapters) {
    const key = chapterKey(c.chapter_number, c.title);
    const sections = (sectionsByChapter.get(c.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
    currentGroups.set(key, { chapterKey: key, chapterNumber: c.chapter_number, title: c.title, sections });
  }

  const allKeys = new Set<string>([...snapshotGroups.keys(), ...currentGroups.keys()]);
  const ordered = [...allKeys]
    .map((key) => {
      const g = currentGroups.get(key) ?? snapshotGroups.get(key)!;
      return { key, chapterNumber: g.chapterNumber, title: g.title };
    })
    .sort(compareChapters);

  const changes: StructuralChange[] = [];
  const changedChapters: StructuralDiff['changedChapters'] = [];

  for (const { key } of ordered) {
    const snap = snapshotGroups.get(key);
    const cur = currentGroups.get(key);

    if (snap && !cur) {
      changes.push({
        type: 'removed',
        chapterKey: key,
        chapterNumber: snap.chapterNumber,
        title: snap.title,
        detail: pluralize(snap.sections.length, 'section') + ' removed'
      });
      continue;
    }
    if (cur && !snap) {
      changes.push({
        type: 'added',
        chapterKey: key,
        chapterNumber: cur.chapterNumber,
        title: cur.title,
        detail: pluralize(cur.sections.length, 'new section') + ' added'
      });
      // A brand-new chapter's prose is worth viewing too (all-added).
      changedChapters.push({ chapterKey: key, chapterNumber: cur.chapterNumber, title: cur.title });
      continue;
    }
    if (!cur || !snap) continue; // unreachable, satisfies types

    // Present in both — detect rename and content changes independently.
    if (snap.title.trim() !== cur.title.trim()) {
      changes.push({
        type: 'renamed',
        chapterKey: key,
        chapterNumber: cur.chapterNumber,
        title: cur.title,
        fromTitle: snap.title,
        detail: `"${snap.title}" → "${cur.title}"`
      });
    }

    // Section-level change counts. Match snapshot sections back to the live
    // section they were taken from via source_section_id.
    const currentById = new Map(cur.sections.map((s) => [s.id, s]));
    const matchedCurrentIds = new Set<string>();
    let revised = 0;
    let removedSections = 0;
    for (const snapSection of snap.sections) {
      const live = snapSection.source_section_id ? currentById.get(snapSection.source_section_id) : undefined;
      if (!live) {
        removedSections += 1;
        continue;
      }
      matchedCurrentIds.add(live.id);
      if (normalize(live.content) !== normalize(snapSection.content)) revised += 1;
    }
    const addedSections = cur.sections.filter((s) => !matchedCurrentIds.has(s.id)).length;

    if (revised > 0 || addedSections > 0 || removedSections > 0) {
      const parts: string[] = [];
      if (revised > 0) parts.push(pluralize(revised, 'section') + ' revised');
      if (addedSections > 0) parts.push(pluralize(addedSections, 'section') + ' added');
      if (removedSections > 0) parts.push(pluralize(removedSections, 'section') + ' removed');
      changes.push({
        type: 'changed',
        chapterKey: key,
        chapterNumber: cur.chapterNumber,
        title: cur.title,
        detail: parts.join(', ')
      });
      changedChapters.push({ chapterKey: key, chapterNumber: cur.chapterNumber, title: cur.title });
    }
  }

  return { changes, changedChapters };
}

// The full prose of one chapter, sections joined in order — what the textual
// diff runs on. Exposed so the compare route can build both sides the same way.
export function joinSnapshotChapter(snapshotSections: SnapshotSectionInput[], key: string): string {
  return snapshotSections
    .filter((s) => chapterKey(s.chapter_number, s.chapter_title) === key)
    .sort((a, b) => a.section_order - b.section_order)
    .map((s) => s.content)
    .join('\n\n')
    .trim();
}

export function joinCurrentChapter(
  currentChapters: CurrentChapterInput[],
  currentSections: CurrentSectionInput[],
  key: string
): string {
  const chapter = currentChapters.find((c) => chapterKey(c.chapter_number, c.title) === key);
  if (!chapter) return '';
  return currentSections
    .filter((s) => s.chapter_id === chapter.id)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => s.content)
    .join('\n\n')
    .trim();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export type DiffLine = { kind: 'common' | 'removed' | 'added'; text: string };

// Line-level diff via a classic LCS over paragraphs (blank-line separated),
// falling back to single lines. Returns an ordered opcode list; the UI renders
// removed lines in the old column and added lines in the new column, common
// lines in both. Good enough for prose review; not a word-level intraline diff.
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const split = (t: string) => t.split(/\n{2,}|\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const a = split(oldText);
  const b = split(newText);

  const n = a.length;
  const m = b.length;
  // LCS length table. `at(x, y)` reads the table with a 0 default so strict
  // index-access typing (noUncheckedIndexedAccess) stays satisfied.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (x: number, y: number): number => lcs[x]?.[y] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'common', text: a[i]! });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! });
  while (j < m) out.push({ kind: 'added', text: b[j++]! });
  return out;
}
