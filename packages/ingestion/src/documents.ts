import { createHash } from 'node:crypto';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { looksReadable } from './office-extractors.js';

/**
 * Uploaded documents.
 *
 * A customer's product documentation arrives as a file someone in marketing
 * exported, and it is **untrusted input** from the moment it lands. Not because
 * the customer is hostile, but because a PDF is a container: it carries text
 * that a supplier wrote, that a previous agency wrote, that a competitor's
 * comparison table quoted, and, increasingly, text placed there specifically
 * to be read by a language model.
 *
 * So a document is stored, hashed and quarantined as *material*, and never
 * treated as instructions. What the extraction agent produces from it is a
 * proposal, not knowledge.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'html' | 'markdown' | 'text' | 'csv';

export type DocumentState =
  /** Stored, not yet read. */
  | 'uploaded'
  | 'extracting'
  /** Text extracted, awaiting the knowledge agent. */
  | 'extracted'
  /** The agent has proposed knowledge from it. */
  | 'processed'
  | 'failed'
  /** Withdrawn by the customer. Its knowledge is retired with it. */
  | 'removed';

export interface UploadedDocument {
  readonly documentId: string;
  readonly tenantId: string;
  readonly filename: string;
  readonly format: DocumentFormat;
  readonly byteSize: number;
  /** SHA-256 of the bytes. Detects a re-upload of the same file. */
  readonly checksum: string;
  readonly state: DocumentState;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  /** Extracted plain text, once read. */
  readonly text?: string;
  readonly pageCount?: number;
  readonly failureReason?: string;
  /** How many knowledge items were proposed from it. */
  readonly proposedCount?: number;
  /** The customer's own description. Helps the agent and the reviewer. */
  readonly description?: string;
}

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const EXTENSION_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  pdf: 'pdf', docx: 'docx', doc: 'docx',
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', text: 'text',
  csv: 'csv',
};

export function formatOf(filename: string): DocumentFormat | undefined {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_FORMATS[extension];
}

export function checksumOf(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface DocumentStore {
  get(documentId: string): Promise<UploadedDocument | undefined>;
  put(document: UploadedDocument): Promise<void>;
  listByTenant(tenantId: string): Promise<readonly UploadedDocument[]>;
  findByChecksum(tenantId: string, checksum: string): Promise<UploadedDocument | undefined>;
}

export class InMemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, UploadedDocument>();
  async get(documentId: string): Promise<UploadedDocument | undefined> {
    return this.documents.get(documentId);
  }
  async put(document: UploadedDocument): Promise<void> {
    this.documents.set(document.documentId, document);
  }
  async listByTenant(tenantId: string): Promise<readonly UploadedDocument[]> {
    return [...this.documents.values()]
      .filter((document) => document.tenantId === tenantId)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }
  async findByChecksum(tenantId: string, checksum: string): Promise<UploadedDocument | undefined> {
    return [...this.documents.values()]
      .find((document) => document.tenantId === tenantId
        && document.checksum === checksum
        && document.state !== 'removed');
  }
}

/**
 * Text extraction.
 *
 * Behind a port because PDF and DOCX extraction needs real libraries, and the
 * governed behaviour above must be testable without them. The plain formats are
 * implemented here because they need nothing.
 */
export interface TextExtractor {
  readonly formats: readonly DocumentFormat[];
  extract(bytes: Uint8Array, format: DocumentFormat): Promise<{
    readonly text: string;
    readonly pageCount?: number;
  }>;
}

export class PlainTextExtractor implements TextExtractor {
  readonly formats: readonly DocumentFormat[] = ['text', 'markdown', 'html', 'csv'];

  async extract(bytes: Uint8Array, format: DocumentFormat): Promise<{ text: string }> {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (format !== 'html') return { text: raw };
    return { text: stripHtml(raw) };
  }
}

/**
 * Strips markup, and strips script and style *content* rather than only their
 * tags. Leaving the body of a script in the text feeds an instruction-shaped
 * blob straight to the extraction agent.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface UploadInput {
  readonly tenantId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly uploadedBy: string;
  readonly description?: string;
}

export class DocumentService {
  constructor(
    private readonly store: DocumentStore,
    private readonly extractors: readonly TextExtractor[],
    private readonly clock: Clock = systemClock,
  ) {}

  async upload(input: UploadInput): Promise<UploadedDocument> {
    const format = formatOf(input.filename);
    if (!format) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Unsupported file type. Upload a PDF, Word document, HTML, Markdown, CSV or text file.',
      });
    }
    if (input.bytes.byteLength === 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'That file is empty.' });
    }
    if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: `That file is larger than ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB.`,
      });
    }

    const checksum = checksumOf(input.bytes);
    const existing = await this.store.findByChecksum(input.tenantId, checksum);
    if (existing) {
      // The same file uploaded twice is one document. Re-extracting it would
      // duplicate every FAQ it produced and leave a reviewer approving the same
      // answer twice.
      return existing;
    }

    const document: UploadedDocument = {
      documentId: `doc_${checksum.slice(0, 16)}`,
      tenantId: input.tenantId,
      filename: input.filename,
      format,
      byteSize: input.bytes.byteLength,
      checksum,
      state: 'uploaded',
      uploadedBy: input.uploadedBy,
      uploadedAt: this.clock.iso(),
      description: input.description,
    };
    await this.store.put(document);
    return document;
  }

  /** Reads the text out of an uploaded document. */
  async extract(documentId: string, bytes: Uint8Array): Promise<UploadedDocument> {
    const document = await this.require(documentId);
    const extractor = this.extractors.find((candidate) => candidate.formats.includes(document.format));
    if (!extractor) {
      const failed: UploadedDocument = {
        ...document,
        state: 'failed',
        failureReason:
          `No extractor is configured for ${document.format}. ` +
          'PDF and Word extraction need a library; see the ingestion README.',
      };
      await this.store.put(failed);
      return failed;
    }

    await this.store.put({ ...document, state: 'extracting' });
    try {
      const { text, pageCount } = await extractor.extract(bytes, document.format);
      // Emptiness is one failure; unreadable output is the other and the worse
      // one. A scan yields almost nothing, and a stream in an encoding the
      // reader does not understand yields bytes that are not letters. Passing
      // either on means proposing a page of punctuation as knowledge.
      //
      // Only for the formats that are parsed. A text or markdown file is what
      // the customer typed, handed back verbatim, and it is not this code's
      // place to tell them their own file does not read like prose: a price
      // list that is mostly numbers is a legitimate price list.
      const parsed = document.format === 'pdf' || document.format === 'docx';
      const unusable = text.trim().length === 0 || (parsed && !looksReadable(text));
      if (unusable) {
        const failed: UploadedDocument = {
          ...document,
          state: 'failed',
          failureReason: text.trim().length === 0
            ? 'No text could be read. If this is a scan, it needs OCR before upload.'
            : 'The text in this file could not be read as words. This usually means a scan, or '
              + 'a PDF that stores its text in an unusual encoding. Try saving it as a Word '
              + 'document or exporting the text, and upload that.',
        };
        await this.store.put(failed);
        return failed;
      }
      const extracted: UploadedDocument = { ...document, state: 'extracted', text, pageCount };
      await this.store.put(extracted);
      return extracted;
    } catch (error) {
      const failed: UploadedDocument = {
        ...document,
        state: 'failed',
        failureReason: error instanceof Error ? error.message : 'Extraction failed.',
      };
      await this.store.put(failed);
      return failed;
    }
  }

  async markProcessed(documentId: string, proposedCount: number): Promise<UploadedDocument> {
    const document = await this.require(documentId);
    const updated: UploadedDocument = { ...document, state: 'processed', proposedCount };
    await this.store.put(updated);
    return updated;
  }

  /** Withdraws a document. Its knowledge is retired separately, by the caller. */
  async remove(documentId: string): Promise<UploadedDocument> {
    const document = await this.require(documentId);
    // The text goes with it: a customer who deletes a document expects its
    // content gone, not retained in a column nobody mentioned.
    const removed: UploadedDocument = {
      ...document, state: 'removed', text: undefined,
    };
    await this.store.put(removed);
    return removed;
  }

  async get(documentId: string): Promise<UploadedDocument | undefined> {
    return this.store.get(documentId);
  }

  async list(tenantId: string): Promise<readonly UploadedDocument[]> {
    return this.store.listByTenant(tenantId);
  }

  private async require(documentId: string): Promise<UploadedDocument> {
    const document = await this.store.get(documentId);
    if (!document) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such document.' });
    return document;
  }
}
