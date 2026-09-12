/**
 * Shared text extraction for uploads.
 *
 * DOCX extraction is intentionally dependency-free and does NOT shell out to
 * the operating system. A DOCX is a ZIP archive; we read word/document.xml
 * directly from the archive in-process so this works in Vercel/Node serverless
 * runtimes where the `unzip` executable is not available.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const normalizeEol = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export type ExtractionErrorCode =
  | 'INVALID_DOCX'
  | 'DOCX_XML_MISSING'
  | 'DOCX_COMPRESSION_UNSUPPORTED'
  | 'DOCX_DECOMPRESSION_FAILED'
  | 'EMPTY_DOCUMENT';

export class ExtractionError extends Error {
  code: ExtractionErrorCode;

  constructor(code: ExtractionErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtractionError';
    this.code = code;
  }
}

/** Parse the raw word/document.xml into paragraphs joined by blank lines. */
export function parseDocxXml(xml: string): string {
  const paras = xml
    .split(/<w:p[ >]/)
    .slice(1)
    .map((p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1] ?? '')).join(''));
  return paras.map((t) => t.trim()).filter(Boolean).join('\n\n');
}

const isDocx = (name: string) => /\.docx$/i.test(name);

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const UTF8 = new TextDecoder('utf-8');

/**
 * Return a file entry from a ZIP archive using the central directory.
 * DOCX files created by Word use either stored (0) or DEFLATE (8) entries;
 * both are supported here.
 */
function readZipEntry(bytes: Uint8Array, wantedName: string): Uint8Array {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD can be followed by a ZIP comment of up to 65,535 bytes.
  const minEocdSize = 22;
  if (data.length < minEocdSize) {
    throw new ExtractionError('INVALID_DOCX', 'DOCX archive is too small to be valid.');
  }

  const searchStart = Math.max(0, data.length - minEocdSize - 0xffff);
  let eocdOffset = -1;
  for (let i = data.length - minEocdSize; i >= searchStart; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new ExtractionError('INVALID_DOCX', 'DOCX ZIP directory was not found.');
  }

  const entryCount = data.readUInt16LE(eocdOffset + 10);
  const centralOffset = data.readUInt32LE(eocdOffset + 16);
  let cursor = centralOffset;

  for (let n = 0; n < entryCount; n++) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ExtractionError('INVALID_DOCX', 'DOCX ZIP directory is malformed.');
    }

    const compression = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const filenameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localHeaderOffset = data.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + filenameLength;

    if (nameEnd > data.length) {
      throw new ExtractionError('INVALID_DOCX', 'DOCX ZIP entry name is truncated.');
    }

    const name = UTF8.decode(data.subarray(nameStart, nameEnd));
    if (name === wantedName) {
      if (localHeaderOffset + 30 > data.length || data.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
        throw new ExtractionError('INVALID_DOCX', 'DOCX ZIP local entry is malformed.');
      }

      const localNameLength = data.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = data.readUInt16LE(localHeaderOffset + 28);
      const payloadStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const payloadEnd = payloadStart + compressedSize;
      if (payloadEnd > data.length) {
        throw new ExtractionError('INVALID_DOCX', 'DOCX ZIP entry data is truncated.');
      }

      const compressed = data.subarray(payloadStart, payloadEnd);
      if (compression === 0) return new Uint8Array(compressed);
      if (compression === 8) {
        try {
          return new Uint8Array(inflateRawSync(compressed));
        } catch (err) {
          throw new ExtractionError('DOCX_DECOMPRESSION_FAILED', 'DOCX document XML could not be decompressed.', err);
        }
      }
      throw new ExtractionError('DOCX_COMPRESSION_UNSUPPORTED', `Unsupported DOCX ZIP compression method: ${compression}.`);
    }

    cursor = nameEnd + extraLength + commentLength;
  }

  throw new ExtractionError('DOCX_XML_MISSING', 'The DOCX does not contain word/document.xml.');
}

function docxBytesToText(bytes: Uint8Array): string {
  const xmlBytes = readZipEntry(bytes, 'word/document.xml');
  const text = parseDocxXml(UTF8.decode(xmlBytes));
  if (!text.trim()) {
    throw new ExtractionError('EMPTY_DOCUMENT', 'The DOCX contains no readable document text.');
  }
  return text;
}

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
    const fileBytes = new Uint8Array(readFileSync(input.filePath));
    if (isDocx(name)) return normalizeEol(docxBytesToText(fileBytes));
    return normalizeEol(Buffer.from(fileBytes).toString('utf8')); // .txt / .md / plain
  }

  if (input.bytes) {
    if (isDocx(name)) return normalizeEol(docxBytesToText(input.bytes));
    return normalizeEol(Buffer.from(input.bytes).toString('utf8'));
  }

  return '';
}
