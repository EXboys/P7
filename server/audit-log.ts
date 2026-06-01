import { existsSync, readFileSync } from "fs";

export type AuditEntry = {
  at: string;
  event: string;
  detail: Record<string, unknown>;
  raw: string;
};

export type AuditLogQuery = {
  page?: number;
  perPage?: number;
  event?: string;
  alias?: string;
  q?: string;
};

export type AuditLogPage = {
  entries: AuditEntry[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  eventTypes: string[];
};

function parseLine(line: string): AuditEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const at = String(obj.at ?? "");
    const event = String(obj.event ?? "unknown");
    const { at: _a, event: _e, ...rest } = obj;
    return { at, event, detail: rest, raw: trimmed };
  } catch {
    return {
      at: "",
      event: "parse_error",
      detail: { line: trimmed.slice(0, 240) },
      raw: trimmed,
    };
  }
}

export function readAuditEntries(logPath: string): AuditEntry[] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf-8").split("\n");
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

function matchesFilter(entry: AuditEntry, opts: AuditLogQuery): boolean {
  if (opts.event) {
    const ev = opts.event.trim().toLowerCase();
    if (!entry.event.toLowerCase().includes(ev)) return false;
  }
  if (opts.alias) {
    const alias = opts.alias.trim().toLowerCase();
    const entryAlias = String(entry.detail.alias ?? "").toLowerCase();
    if (entryAlias !== alias) return false;
  }
  if (opts.q) {
    const q = opts.q.trim().toLowerCase();
    if (!entry.raw.toLowerCase().includes(q)) return false;
  }
  return true;
}

export function queryAuditLogs(logPath: string, opts: AuditLogQuery = {}): AuditLogPage {
  const perPage = Math.min(200, Math.max(10, opts.perPage ?? 20));
  const all = readAuditEntries(logPath);
  const eventTypes = [...new Set(all.map((e) => e.event))].sort();
  const filtered = all.filter((e) => matchesFilter(e, opts));
  filtered.reverse();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(totalPages, Math.max(1, opts.page ?? 1));
  const start = (page - 1) * perPage;
  const entries = filtered.slice(start, start + perPage);
  return { entries, total, page, perPage, totalPages, eventTypes };
}
