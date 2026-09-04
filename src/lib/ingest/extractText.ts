/**
 * Shared text extraction for uploads. Reuses the tuned importer's approach
 * (dependency-free docx: read word/document.xml, join <w:p>/<w:t>) so there is
 * ONE parser, not two. For a SECTION upload the whole extracted body is the new
 * section content — headings and any "~~~" inside are kept as literal content
 * (no section splitting here; that rule belongs to CHAPTER upload).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const normalizeEol = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** Parse the raw word/document.xml into paragraphs joined by blank lines. */
export function parseDocxXml(xml: string): string {
  const paras = xml
    .split(/<w:p[ >]/)
    .slice(1)
    .map((p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1] ?? '')).join(''));
  return paras.map((t) => t.trim()).filter(Boolean).join('\n\n');
}

function docxFileToText(path: string): string {
  const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], { maxBuffer: 1 << 26 }).toString('utf8');
  return parseDocxXml(xml);
}

const isDocx = (name: string) => /\.docx$/i.test(name);

/**
 * Extract plain text from a paste or a supported file. Line endings are
 * normalized; nothing else about the content is altered here.
 *   { text }              → pasted text
 *   { filePath }          → .txt/.md/.docx on disk
 *   { bytes, filename }   → uploaded buffer (filename decides handling)
 */
export function extractText(input: { text?: string; filePath?: string; bytes?: Uint8Array; filename?: string }): string {
  if (input.text != null) return normalizeEol(input.text);

  const name = (input.filename ?? input.filePath ?? '').toLowerCase();

  if (input.filePath) {
    if (isDocx(name)) return normalizeEol(docxFileToText(input.filePath));
    return normalizeEol(readFileSync(input.filePath, 'utf8')); // .txt / .md / plain
  }

  if (input.bytes) {
    if (isDocx(name)) {
      const tmp = join(tmpdir(), `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
      try {
        writeFileSync(tmp, Buffer.from(input.bytes));
        return normalizeEol(docxFileToText(tmp));
      } finally {
        try { unlinkSync(tmp); } catch { /* best effort */ }
      }
    }
    return normalizeEol(Buffer.from(input.bytes).toString('utf8'));
  }

  return '';
}
