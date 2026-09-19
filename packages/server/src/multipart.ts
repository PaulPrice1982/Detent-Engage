/**
 * A minimal multipart/form-data reader, for file upload.
 *
 * Written rather than depended on, for the same reason the test runner is: this
 * must build behind a package firewall. It handles exactly what a browser file
 * input sends, and refuses anything it does not fully understand instead of
 * guessing: a parser that guesses at a boundary hands the wrong bytes to the
 * extraction agent.
 */

export interface UploadedPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
}

export function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  return boundary && boundary.length > 0 ? boundary : undefined;
}

/** Parses a multipart body. Returns undefined if it is not parseable. */
export function parseMultipart(body: Buffer, boundary: string): readonly UploadedPart[] | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: UploadedPart[] = [];

  let index = body.indexOf(delimiter);
  if (index < 0) return undefined;

  while (index >= 0) {
    const afterDelimiter = index + delimiter.length;
    // `--` after the boundary marks the end of the body.
    if (body.slice(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--') break;

    const headerStart = afterDelimiter + 2; // skip CRLF
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) return undefined;

    const headers = body.slice(headerStart, headerEnd).toString('utf8');
    const next = body.indexOf(delimiter, headerEnd);
    if (next < 0) return undefined;

    // The two bytes before the next delimiter are the CRLF that precedes it.
    const bytes = body.slice(headerEnd + 4, next - 2);

    const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) return undefined;
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();

    parts.push({ name, filename, contentType, bytes: new Uint8Array(bytes) });
    index = next;
  }

  return parts;
}

/** The text value of a named field. */
export function fieldOf(parts: readonly UploadedPart[], name: string): string | undefined {
  const part = parts.find((candidate) => candidate.name === name && candidate.filename === undefined);
  return part ? new TextDecoder().decode(part.bytes) : undefined;
}

/** The first file part, if any. */
export function fileOf(parts: readonly UploadedPart[], name: string): UploadedPart | undefined {
  return parts.find((candidate) => candidate.name === name && candidate.filename !== undefined
    && candidate.filename.length > 0);
}
