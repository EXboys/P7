/**
 * Entity-level diff parser that extracts function/class/variable/interface/type_alias/enum
 * change context from unified diff output.
 *
 * Parses unified diff text → per-file hunks with line numbers → regex-based entity
 * declaration detection → change classification (added/modified/deleted).
 *
 * @module
 */

/* ── Types ── */

/** Supported entity types in TypeScript/JavaScript. */
export type EntityType =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type_alias"
  | "enum"
  | "method";

/** Classification of how an entity changed across a diff. */
export type EntityChangeType = "added" | "modified" | "deleted";

/** A single entity change detected in a diff hunk. */
export interface ChangeEntity {
  /** Entity name as declared in source. */
  name: string;
  /** Entity type classification. */
  entityType: EntityType;
  /** How this entity changed relative to the base revision. */
  changeType: EntityChangeType;
  /** File path relative to repository root. */
  filePath: string;
  /** Approximate line number in the post-diff file (0 if deleted-only). */
  lineNumber: number;
  /** Line number in the pre-diff file (only for modified/deleted). */
  previousLineNumber?: number;
}

/** Per-file entity diff result. */
export interface FileEntityDiff {
  /** File path relative to repository root. */
  filePath: string;
  /** Entities detected in this file's diff hunks. */
  entities: ChangeEntity[];
}

/** Top-level result from {@link captureEntityDiff}. */
export interface EntityDiffResult {
  /** Per-file entity diffs. Only files with ≥1 detected entity are included. */
  files: FileEntityDiff[];
}

/* ── Regex patterns for TS/JS entity declarations ── */

const ENTITY_PATTERNS: Record<EntityType, RegExp> = {
  function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  variable: /(?:export\s+)?(?:const|let|var)\s+(\w+)\b/,
  interface: /(?:export\s+)?interface\s+(\w+)/,
  type_alias: /(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=/,
  enum: /(?:export\s+)?enum\s+(\w+)/,
  method: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?:\{|=>)/,
};

/* ── Internal data structures ── */

interface HunkLine {
  content: string;
  type: "context" | "added" | "deleted";
  /** Line number in the old (pre-diff) file; 0 if unknown. */
  oldLine: number;
  /** Line number in the new (post-diff) file; 0 if unknown. */
  newLine: number;
}

interface ParsedFile {
  filePath: string;
  hunks: HunkLine[][];
}

/** Per-entity observation aggregated across all hunks of one file. */
interface EntityObservation {
  name: string;
  entityType: EntityType;
  changeType: EntityChangeType;
  newLine: number;
  oldLine: number;
}

/* ── Unified diff parser ── */

/**
 * Split unified diff text into per-file sections with per-hunk line arrays.
 * Handles standard `git diff` output including new/deleted file markers.
 */
function parseDiff(diffText: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const lines = diffText.split("\n");
  let currentFile: ParsedFile | null = null;
  let currentHunk: HunkLine[] | null = null;
  let oldLineOffset = 0;
  let newLineOffset = 0;

  for (const line of lines) {
    // Detect file section boundary
    const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffMatch) {
      flushHunk();
      flushFile();
      currentFile = { filePath: diffMatch[2], hunks: [] };
      continue;
    }

    // Skip metadata lines
    if (/^(---|\+\+\+|index |new file|deleted file|rename |similarity|copy from|copy to)/.test(line)) continue;
    if (/^\\ No newline/.test(line)) continue;

    // Detect hunk header
    const hunkMatch = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
    if (hunkMatch) {
      flushHunk();
      oldLineOffset = parseInt(hunkMatch[1], 10);
      newLineOffset = parseInt(hunkMatch[2], 10);
      currentHunk = [];
      continue;
    }

    if (!currentFile || currentHunk === null) continue;

    // Classify hunk content lines by prefix
    if (line.startsWith("+")) {
      currentHunk.push({ content: line.slice(1), type: "added", oldLine: 0, newLine: newLineOffset++ });
    } else if (line.startsWith("-")) {
      currentHunk.push({ content: line.slice(1), type: "deleted", oldLine: oldLineOffset++, newLine: 0 });
    } else if (line.startsWith(" ")) {
      currentHunk.push({
        content: line.slice(1),
        type: "context",
        oldLine: oldLineOffset++,
        newLine: newLineOffset++,
      });
    }
    // Empty lines and other non-content lines are silently ignored
  }

  flushHunk();
  flushFile();
  return files;

  /* ── internal flush helpers ── */
  function flushHunk(): void {
    if (currentFile && currentHunk) currentFile.hunks.push(currentHunk);
    currentHunk = null;
  }
  function flushFile(): void {
    if (currentFile) files.push(currentFile);
    currentFile = null;
  }
}

/* ── Entity detection ── */

/**
 * Check a single source line against all entity declaration patterns.
 * Returns the first matching entity type and captured name, or null.
 */
function detectEntity(line: string): { entityType: EntityType; name: string } | null {
  for (const [type, pattern] of Object.entries(ENTITY_PATTERNS)) {
    const match = line.match(pattern);
    if (match) return { entityType: type as EntityType, name: match[1] };
  }
  return null;
}

interface RawDetect {
  name: string;
  entityType: EntityType;
  lineType: "context" | "added" | "deleted";
  oldLine: number;
  newLine: number;
}

/** Run entity detection over every line in a hunk, deduplicating by key+lineType. */
function detectInHunk(hunk: HunkLine[]): RawDetect[] {
  const seen = new Set<string>();
  const result: RawDetect[] = [];

  for (const hl of hunk) {
    const d = detectEntity(hl.content);
    if (!d) continue;
    const key = `${d.entityType}:${d.name}:${hl.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...d, lineType: hl.type, oldLine: hl.oldLine, newLine: hl.newLine });
  }

  return result;
}

/* ── Change classification ── */

/**
 * Determine change type for an entity based on which line types it appears on.
 * `hunkHasDelta` indicates the surrounding hunk contains added/deleted lines.
 */
function classifyChange(
  onAdded: boolean,
  onDeleted: boolean,
  onContext: boolean,
  hunkHasDelta: boolean,
): EntityChangeType | null {
  if (onAdded && !onDeleted && !onContext) return "added";
  if (onDeleted && !onAdded && !onContext) return "deleted";
  if (onAdded && onDeleted) return "modified"; // signature changed
  if (onContext && hunkHasDelta) return "modified";
  return null; // context-only with no surrounding changes — not a real delta
}

/* ── Hunk-level aggregation ── */

/**
 * Process one hunk: detect entities and classify each within this hunk's context.
 * Returns observations keyed by `entityType:name`.
 */
function processHunk(hunk: HunkLine[]): Map<string, EntityObservation> {
  const map = new Map<string, EntityObservation>();
  const hasDelta = hunk.some((l) => l.type === "added" || l.type === "deleted");
  const detected = detectInHunk(hunk);

  // Group by entity key to merge across line types within the same hunk
  const grouped = new Map<string, { added: boolean; deleted: boolean; context: boolean; newLine: number; oldLine: number }>();
  for (const d of detected) {
    const key = `${d.entityType}:${d.name}`;
    const g = grouped.get(key) ?? { added: false, deleted: false, context: false, newLine: 0, oldLine: 0 };
    if (d.lineType === "added") g.added = true;
    if (d.lineType === "deleted") g.deleted = true;
    if (d.lineType === "context") g.context = true;
    if (d.lineType !== "deleted" && d.newLine > 0) g.newLine = d.newLine;
    if (d.lineType === "deleted" && d.oldLine > 0) g.oldLine = d.oldLine;
    grouped.set(key, g);
  }

  for (const [key, g] of grouped) {
    const changeType = classifyChange(g.added, g.deleted, g.context, hasDelta);
    if (changeType === null) continue;
    const [entityType, name] = key.split(":") as [EntityType, string];
    map.set(key, { name, entityType, changeType, newLine: g.newLine, oldLine: g.oldLine });
  }

  return map;
}

/* ── Public entry point ── */

/**
 * Parse a unified diff and extract entity-level change context.
 *
 * @param diffText — Raw unified diff output (e.g. from `git diff` or `git show`).
 * @returns Structured entity diff result grouped by file.
 *
 * @example
 * ```ts
 * const result = captureEntityDiff(diffOutput);
 * for (const file of result.files) {
 *   for (const entity of file.entities) {
 *     console.log(`${entity.changeType} ${entity.entityType} ${entity.name} at ${entity.filePath}:${entity.lineNumber}`);
 *   }
 * }
 * ```
 */
export function captureEntityDiff(diffText: string): EntityDiffResult {
  if (!diffText.trim()) return { files: [] };

  const parsed = parseDiff(diffText);
  const files: FileEntityDiff[] = [];

  for (const pf of parsed) {
    // Merge entity observations across all hunks in this file
    const merged = new Map<string, EntityObservation>();

    for (const hunk of pf.hunks) {
      const hunkResult = processHunk(hunk);
      for (const [key, obs] of hunkResult) {
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, obs);
        } else {
          // Conflict across hunks → upgrade to modified
          if (existing.changeType !== obs.changeType) {
            existing.changeType = "modified";
          }
          if (obs.newLine > 0) existing.newLine = obs.newLine;
          if (obs.oldLine > 0) existing.oldLine = obs.oldLine;
        }
      }
    }

    if (merged.size === 0) continue;

    const entities: ChangeEntity[] = [];
    for (const obs of merged.values()) {
      entities.push({
        name: obs.name,
        entityType: obs.entityType,
        changeType: obs.changeType,
        filePath: pf.filePath,
        lineNumber: obs.newLine || obs.oldLine,
        ...(obs.oldLine > 0 && obs.oldLine !== obs.newLine ? { previousLineNumber: obs.oldLine } : {}),
      });
    }

    entities.sort((a, b) => a.lineNumber - b.lineNumber);
    files.push({ filePath: pf.filePath, entities });
  }

  return { files };
}
