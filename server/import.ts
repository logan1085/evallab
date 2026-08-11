/**
 * Trace import.
 *
 * The spec's constraint is "paste, upload, or pull an export from whatever
 * platform is already running", so these parsers are deliberately forgiving
 * about field names: eval platforms disagree about whether the transcript lives
 * under `output`, `completion`, `messages`, or `trace`, and asking the user to
 * rename columns before they can try the product is a way to not get tried.
 */

export interface ParsedTrace {
  title: string;
  content: string;
  meta: Record<string, unknown>;
}

const TITLE_KEYS = ['title', 'name', 'id', 'case', 'test', 'test_name', 'input', 'prompt', 'question'];
const CONTENT_KEYS = ['content', 'transcript', 'trace', 'output', 'completion', 'response', 'messages', 'text', 'body'];

export function parseJsonl(body: string): { traces: ParsedTrace[]; skipped: number } {
  const traces: ParsedTrace[] = [];
  let skipped = 0;

  // Accept a JSON array as well as newline-delimited objects — people paste both.
  const trimmed = body.trim();
  if (trimmed.startsWith('[')) {
    try {
      const rows = JSON.parse(trimmed);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const trace = fromObject(row);
          if (trace) traces.push(trace);
          else skipped++;
        }
        return { traces, skipped };
      }
    } catch {
      // Fall through to line-by-line, which gives a better partial result.
    }
  }

  for (const line of trimmed.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const trace = fromObject(JSON.parse(text));
      if (trace) traces.push(trace);
      else skipped++;
    } catch {
      skipped++;
    }
  }

  return { traces, skipped };
}

function fromObject(row: unknown): ParsedTrace | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const obj = row as Record<string, unknown>;

  const contentKey = CONTENT_KEYS.find((k) => obj[k] !== undefined && obj[k] !== null);
  if (!contentKey) return null;
  const content = stringify(obj[contentKey]);
  if (!content.trim()) return null;

  const titleKey = TITLE_KEYS.find((k) => typeof obj[k] === 'string' && (obj[k] as string).trim());
  const title = titleKey ? truncate(String(obj[titleKey]).trim(), 90) : truncate(firstLine(content), 90);

  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === contentKey || k === titleKey) continue;
    meta[k] = v;
  }

  return { title: title || 'Untitled trace', content, meta };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // Message arrays are the common shape; render them as a readable transcript.
    const rendered = value.map((entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        const role = typeof e.role === 'string' ? e.role.toUpperCase() : null;
        const body = typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? e);
        return role ? `${role}: ${body}` : body;
      }
      return String(entry);
    });
    return rendered.join('\n\n');
  }
  return JSON.stringify(value, null, 2);
}

/** RFC 4180-ish: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(body: string): { traces: ParsedTrace[]; skipped: number } {
  const rows = splitCsvRows(body);
  if (rows.length < 2) return { traces: [], skipped: 0 };

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const traces: ParsedTrace[] = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.trim() === '')) continue;
    const obj: Record<string, unknown> = {};
    header.forEach((key, i) => {
      obj[key] = row[i] ?? '';
    });
    const trace = fromObject(obj);
    if (trace) traces.push(trace);
    else skipped++;
  }

  return { traces, skipped };
}

function splitCsvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Bulk paste: traces separated by a line of three or more dashes. The first
 * line of each block becomes the title if it looks like one.
 */
export function parsePaste(body: string): { traces: ParsedTrace[]; skipped: number } {
  const blocks = body
    .split(/^\s*-{3,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const traces = blocks.map((block) => {
    const lines = block.split('\n');
    const head = lines[0]!.trim();
    const looksLikeTitle = lines.length > 1 && head.length <= 90 && !head.includes(': ') && !/^\s/.test(lines[0]!);
    return looksLikeTitle
      ? { title: head, content: lines.slice(1).join('\n').trim(), meta: {} }
      : { title: truncate(firstLine(block), 90), content: block, meta: {} };
  });

  return { traces: traces.filter((t) => t.content.trim()), skipped: 0 };
}

export function parseImport(format: string, body: string): { traces: ParsedTrace[]; skipped: number } {
  switch (format) {
    case 'jsonl':
      return parseJsonl(body);
    case 'csv':
      return parseCsv(body);
    default:
      return parsePaste(body);
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? 'Untitled trace';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
