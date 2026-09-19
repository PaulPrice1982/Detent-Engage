import { inflateRawSync, inflateSync } from 'node:zlib';
import type { DocumentFormat, TextExtractor } from './documents.js';

/**
 * Reading a Word document and a PDF, with no dependency.
 *
 * The upload form invited PDF and Word, the knowledge agent could read neither,
 * and a customer uploading their product handbook (which is a PDF, because
 * every product handbook is a PDF) was told no extractor was configured. That
 * is the first thing a new customer does, so it was the first thing that failed.
 *
 * No library, for the reason the rest of this repository has no libraries: a
 * dependency added here is a dependency in a deployment security scan and a
 * package firewall for ever, and both have already stopped this build once. A
 * .docx is a zip of XML and a PDF's text is in compressed streams, and Node's
 * zlib opens both.
 *
 * The limit is stated rather than discovered. A PDF that is a scan contains
 * pictures of words and no words, and no amount of parsing changes that: it is
 * detected and refused with the reason, rather than proposing nothing and
 * leaving the customer to guess why.
 */

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

export class DocxExtractor implements TextExtractor {
  readonly formats: readonly DocumentFormat[] = ['docx'];

  async extract(bytes: Uint8Array): Promise<{ text: string }> {
    const buffer = Buffer.from(bytes);
    const document = readZipEntry(buffer, 'word/document.xml');
    if (!document) {
      throw new Error(
        'That does not look like a Word document. A .doc saved by a version of Word older '
        + 'than 2007 is a different format entirely; open it and save it as .docx.',
      );
    }
    return { text: wordXmlToText(document.toString('utf8')) };
  }
}

/**
 * Word's XML, as text a person would read.
 *
 * Paragraph and line breaks are honoured because they carry meaning: a price
 * list flattened into one line is a price list nobody can split back into
 * prices. Everything else is markup and goes.
 */
function wordXmlToText(xml: string): string {
  return xml
    // A tab inside a run is usually a column in a table of prices.
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    // End of paragraph, and end of a table row, are both a new line.
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Zip, enough of it to open a .docx
// ---------------------------------------------------------------------------

/**
 * One named entry from a zip, read through the central directory.
 *
 * The central directory rather than scanning for local headers, because a local
 * header may say the size is unknown and defer it to a descriptor after the
 * data, and a reader that trusts it reads the wrong number of bytes. The
 * directory at the end is authoritative, which is why the format has one.
 */
function readZipEntry(buffer: Buffer, wanted: string): Buffer | undefined {
  const end = findEndOfCentralDirectory(buffer);
  if (end === undefined) return undefined;

  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);

  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return undefined;
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    if (name === wanted) {
      // The local header repeats the name and extra fields, and its extra
      // length is frequently different from the directory's. Read it from the
      // local header or the data starts in the wrong place.
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return undefined;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return undefined; // Something exotic. Not worth guessing at.
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

/** The end-of-central-directory record, searched from the back as the spec requires. */
function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  // 22 bytes minimum, plus a comment of up to 65535. Scanning back from the end
  // is the only correct way: the signature can legitimately appear in the data.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) return at;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export class PdfExtractor implements TextExtractor {
  readonly formats: readonly DocumentFormat[] = ['pdf'];

  async extract(bytes: Uint8Array): Promise<{ text: string; pageCount?: number }> {
    const buffer = Buffer.from(bytes);
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('That file is named .pdf but does not begin like one.');
    }

    const pieces: string[] = [];
    for (const stream of contentStreams(buffer)) pieces.push(textFromContentStream(stream));
    const text = pieces.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // Counted from the page objects rather than from the streams: a page can be
    // several streams and several pages can share one.
    const pageCount = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return pageCount > 0 ? { text, pageCount } : { text };
  }
}

/**
 * Every stream in the file, decompressed where it is deflated.
 *
 * Deliberately not a PDF parser. It walks the streams rather than resolving the
 * document's object graph, which is enough to read the words and is far less to
 * get wrong. What it cannot do is read a stream encoded any other way, and what
 * comes back from one of those is not text, which is what the readability check
 * on the way out is for.
 */
function* contentStreams(buffer: Buffer): Generator<string> {
  const marker = Buffer.from('stream');
  let at = buffer.indexOf(marker);
  while (at !== -1) {
    // A stream keyword is followed by CRLF or LF, and nothing else is legal.
    let start = at + marker.length;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;

    const end = buffer.indexOf(Buffer.from('endstream'), start);
    if (end === -1) return;

    const raw = buffer.subarray(start, end);
    try {
      // Deflate, which is what almost every generator uses. A stream that is
      // not deflated throws and is skipped rather than taking the file down.
      yield inflateSync(raw).toString('latin1');
    } catch {
      const plain = raw.toString('latin1');
      // An uncompressed content stream still shows text operators.
      if (/\bTJ\b|\bTj\b/.test(plain)) yield plain;
    }
    at = buffer.indexOf(marker, end);
  }
}

/**
 * The words out of one content stream.
 *
 * A content stream is drawing instructions. Text arrives as a string operand to
 * Tj, or as an array of strings and kerning numbers to TJ. Everything else
 * positions and paints, and is ignored.
 */
function textFromContentStream(stream: string): string {
  const out: string[] = [];
  // (...) strings, honouring the backslash escapes, then the operator that
  // consumes them. A regex rather than a tokeniser: the grammar being matched
  // here is two operators wide.
  const pattern = /\((?:\\.|[^\\()])*\)|\[[^\]]*\]|\bT[Jj]\b|\bT[*]\b|\bTd\b|\bTD\b|\bET\b/g;
  let pending: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stream)) !== null) {
    const token = match[0];
    if (token.startsWith('(')) {
      pending.push(decodePdfString(token.slice(1, -1)));
    } else if (token.startsWith('[')) {
      for (const inner of token.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
        pending.push(decodePdfString(inner[0].slice(1, -1)));
      }
    } else if (token === 'Tj' || token === 'TJ') {
      out.push(pending.join(''));
      pending = [];
    } else if (token === 'T*' || token === 'Td' || token === 'TD' || token === 'ET') {
      // A new line in the drawing is a new line in the reading.
      if (pending.length > 0) { out.push(pending.join('')); pending = []; }
      out.push('\n');
    }
  }
  if (pending.length > 0) out.push(pending.join(''));
  return out.join(' ').replace(/ *\n */g, '\n');
}

/** PDF string escapes: \n, \(, \), \\ and three-digit octal. */
function decodePdfString(raw: string): string {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, code: string) => {
    switch (code) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(code, 8));
    }
  });
}

/**
 * Whether what came out is text a person could read.
 *
 * The failure that matters is not an exception, it is a file that yields a page
 * of punctuation and gets proposed as knowledge. A scan yields almost nothing;
 * a stream in an encoding this does not understand yields bytes that are not
 * letters. Both are refused with the reason rather than passed on.
 */
export function looksReadable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  const letters = (trimmed.match(/[a-zA-ZÀ-ɏ]/g) ?? []).length;
  // Ordinary English prose is above 70% letters and spaces. A half is generous
  // and still excludes a stream of coordinates.
  return letters / trimmed.length > 0.5;
}
