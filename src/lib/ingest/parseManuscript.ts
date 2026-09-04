/**
 * Reusable whole-manuscript parser for "Upload New Manuscript Version".
 *
 * Uses the SAME tuned rules as the existing import parser
 * (scripts/import-awakened.mts) — this is an adapter over those rules, not a new
 * parser and not a change to them:
 *   - a chapter begins at a line matching  /^chapter N: title$/i  (the importer's
 *     `chapterHead` regex; the ":" may also be a dash/en/em dash),
 *   - sections split ONLY on the manuscript's own "~~~" scene breaks (a chapter
 *     with no "~~~" is ONE section) — the tuned section rule,
 *   - front-matter before "Chapter 1" is ignored.
 *
 * It consumes already-extracted PLAIN TEXT (from the shared extractText), never
 * docx styles, so paste / .txt / .md / .docx all parse identically. The
 * extracted docx keeps its heading TEXT ("Chapter 1: …") on its own line, so
 * the text-level chapterHead rule matches without needing style metadata.
 */

// Identical to import-awakened.mts `chapterHead`.
const CHAPTER_HEAD = /^chapter\s+(\d+)\s*[:\-–—]\s*(.+)$/i;

// Standard section normalization (matches the section/chapter upload pipeline).
const normalize = (s: string) =>
  s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const wordCount = (t: string) => { const s = t.trim(); return s ? s.split(/\s+/).length : 0; };
// Identical to the tuned `~~~` section split used everywhere else.
const splitSections = (raw: string) =>
  raw.split(/\n?~+(?:\s*~+)*\n/).map(normalize).filter(Boolean);

export type ParsedSection = { sort_order: number; content: string; word_count: number };
export type ParsedChapter = { chapter_number: number; title: string; sort_order: number; sections: ParsedSection[] };
export type ParsedManuscript = { chapters: ParsedChapter[] };

export function parseManuscript(text: string): ParsedManuscript {
  const lines = normalize(text).split('\n');
  const chapters: ParsedChapter[] = [];
  let cur: { chapter_number: number; title: string; buf: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const secs = splitSections(cur.buf.join('\n')).map((content, i) => ({ sort_order: i, content, word_count: wordCount(content) }));
    chapters.push({ chapter_number: cur.chapter_number, title: cur.title, sort_order: chapters.length, sections: secs });
  };

  for (const line of lines) {
    const m = line.trim().match(CHAPTER_HEAD);
    if (m) { flush(); cur = { chapter_number: Number(m[1]), title: m[2]!.trim(), buf: [] }; }
    else if (cur) cur.buf.push(line);
    // else: front-matter before Chapter 1 — ignored, matching the importer
  }
  flush();
  return { chapters };
}
