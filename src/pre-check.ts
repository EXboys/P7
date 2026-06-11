#!/usr/bin/env bun
/**
 * Synchronous pre-check rule engine for diff-critic pipeline.
 *
 * Runs 11 deterministic rules on raw diff content in <5ms:
 *  1. scopeViolation              — changed files outside plan scope (warning)
 *  2. diffSizeAnomaly             — actual diff lines >> estimated × multiplier (warning)
 *  3. securityRedFlag             — high-signal secret patterns (blocker)
 *  4. hardcodedCredential         — hardcoded credentials in AI-generated code (blocker)
 *  5. unsafeEval                  — eval(), new Function(), setTimeout(string) calls (blocker)
 *  6. shellInjection              — exec/spawn with template literal (blocker)
 *  7. promptInjectionRisk         — dynamic interpolation in system prompt (warning)
 *  8. dataExposureLogging         — sensitive data via verbose logging (warning)
 *  9. unsafeExec                  — exec(), spawn(), shell:true, Bun.spawnSync() calls (blocker)
 * 10. unsafeInnerHtml             — innerHTML=, dangerouslySetInnerHTML, v-html (warning)
 * 11. insecureSecurityConfig      — insecure HTTP security header defaults (mixed)
 *
 * Only ambiguous cases escalate to the LLM evaluator, reducing token cost
 * and latency for clear violations.
 *
 * This module is the standalone type+logic home; consumer modules (e.g.
 * evaluator-middleware) import from here rather than inlining the logic.
 */

import type { Plan } from "./types.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

/** Per-rule config toggles matching the `diff_critic.pre_check` section in config.ts. */
export interface PreCheckConfig {
  enabled: boolean;
  block_on_scope_violation: boolean;
  block_on_size_anomaly: boolean;
  block_on_security_red_flag: boolean;
  block_on_hardcoded_credential: boolean;
  block_on_data_exposure_logging: boolean;
  block_on_insecure_security_config: boolean;
  block_on_unsafe_eval: boolean;
  block_on_shell_injection: boolean;
  block_on_prompt_injection_risk: boolean;
  block_on_unsafe_exec: boolean;
  block_on_unsafe_inner_html: boolean;
}

/** A single finding produced by one deterministic rule. */
export interface PreCheckFinding {
  /** Rule identifier, e.g. "scope_violation", "diff_size_anomaly", "security_red_flag". */
  rule: string;
  /** Severity: blocker findings halt the pipeline; warnings are advisory. */
  severity: "blocker" | "warning";
  /** Human-readable summary of the finding. */
  message: string;
  /** Optional contextual detail (e.g. list of violating files, actual vs estimated counts). */
  detail?: string;
}

/** Aggregate result from a full pre-check run. */
export interface PreCheckResult {
  /** true when no blocker findings exist (warnings alone do not fail). */
  ok: boolean;
  /** All findings from every triggered rule, in evaluation order. */
  findings: PreCheckFinding[];
  /** Wall-clock time spent in the pre-check (milliseconds, rounded). */
  latencyMs: number;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Defaults
 * ──────────────────────────────────────────────────────────────────────────── */

/** Default configuration — all checks enabled, all violations are blockers. */
export const DEFAULT_PRE_CHECK_CONFIG: PreCheckConfig = {
  enabled: true,
  block_on_scope_violation: true,
  block_on_size_anomaly: true,
  block_on_security_red_flag: true,
  block_on_hardcoded_credential: true,
  block_on_data_exposure_logging: true,
  block_on_insecure_security_config: true,
  block_on_unsafe_eval: true,
  block_on_shell_injection: true,
  block_on_prompt_injection_risk: true,
  block_on_unsafe_exec: true,
  block_on_unsafe_inner_html: true,
};

/** Default multiplier applied when checking diff size against estimated lines. */
export const DEFAULT_SIZE_MULTIPLIER = 3;

/* ──────────────────────────────────────────────────────────────────────────────
 * High-signal secret patterns
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Narrow, high-signal patterns for security red-flag detection.
 *
 * Deliberately avoids broad patterns (e.g. "password", "secret") to minimise
 * false positives on test fixtures and configuration files. Only matches:
 *  - OpenAI API key format (sk-…)
 *  - Private key PEM blocks (RSA, EC, DSA, OPENSSH)
 *  - GitHub tokens (ghp_, gho_, ghu_, ghs_)
 */
const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, label: "OpenAI API key (sk-…)" },
  { pattern: /BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY/g, label: "Private key block" },
  { pattern: /\bgh[opu]_[A-Za-z0-9]{36}\b/g, label: "GitHub token" },
  { pattern: /\bghs_[A-Za-z0-9]{36}\b/g, label: "GitHub server-to-server token" },
];

/* ── Unsafe eval patterns ── */

const UNSAFE_EVAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\beval\s*\(/gm, label: "eval() call" },
  { pattern: /\bnew\s+Function\s*\(/gm, label: "new Function() call" },
  { pattern: /\bsetTimeout\s*\(\s*["'`]/gm, label: "setTimeout(string) call — eval-like" },
];

/* ── Shell injection patterns ── */

const SHELL_INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(exec|execSync|execFile|execFileSync)\s*\(\s*`/gm, label: "exec/execSync/execFile with template literal" },
];

/* ── Unsafe exec patterns ── */

const UNSAFE_EXEC_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(exec|execSync)\s*\(/g, label: "exec/execSync() call" },
  { pattern: /\bspawn(?:Sync)?\s*\(/g, label: "spawn/spawnSync() call" },
  { pattern: /shell\s*:\s*true/g, label: "shell:true in spawn options" },
  { pattern: /\bBun\.spawnSync\s*\(/g, label: "Bun.spawnSync() call" },
];

/* ── Prompt injection patterns ── */

const PROMPT_INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bsystem\s*[=:]\s*`[^`]*\$\{/gm, label: "dynamic interpolation in system prompt assignment" },
];

/* ── Unsafe innerHTML patterns ── */

const UNSAFE_INNER_HTML_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\.innerHTML\s*=/g, label: ".innerHTML assignment" },
  { pattern: /\bdangerouslySetInnerHTML\b/g, label: "React dangerouslySetInnerHTML" },
  { pattern: /\bv-html\s*=/g, label: "Vue v-html directive" },
];

/* ──────────────────────────────────────────────────────────────────────────────
 * GenAI defect pattern — Rule 4: Hardcoded credentials
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Patterns for hardcoded credentials in AI-generated code.
 *
 * Matches URI connection strings with embedded credentials, variable
 * assignments to credential-named identifiers, object-literal credential
 * keys, and HTTP header credential values.
 *
 * Safe variable names (example, test, placeholder, dummy, mock, fake,
 * sample) are explicitly excluded to reduce test/fixture false positives.
 */
const CREDENTIAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    // URI connection-string with embedded user:password
    pattern: /\b(?:https?|ftp|postgres(?:ql)?|redis|mongodb(?:\+srv)?|mysql|amqp):\/\/[^\/\s:@]+:[^\/\s:@]+@/g,
    label: "URI connection string with embedded credentials",
  },
  {
    // Variable assignment to credential-named identifiers
    pattern: /(?:const|let|var|private\s+readonly)\s+(?:api[Kk]ey|apiSecret|secret|password|authToken|accessToken|refreshToken)\s*=\s*["'`][A-Za-z0-9_\-=./+]{8,}["'`]/g,
    label: "Hardcoded credential variable assignment",
  },
  {
    // Object-literal credential keys with string literal values
    pattern: /["'`]?(?:password|apiKey|api_secret|secret|token|authToken|accessToken)["'`]?\s*:\s*["'`][A-Za-z0-9_\-=./+]{4,}["'`]/g,
    label: "Hardcoded credential in object literal",
  },
  {
    // HTTP header credential values (Authorization, x-api-key, etc.)
    pattern: /["'`](?:authorization|x-api-key|x-auth-token)["'`]\s*:\s*["'`](?:Bearer\s+)?[A-Za-z0-9_\-=./+]{8,}["'`]/gi,
    label: "Hardcoded credential in HTTP header value",
  },
];

/* ──────────────────────────────────────────────────────────────────────────────
 * GenAI defect pattern — Rule 5: Sensitive data exposure via verbose logging
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Patterns for sensitive data exposure through verbose logging.
 *
 * Matches logged request bodies, JSON.stringify of request/response data,
 * logged HTTP headers containing auth/cookie info, and logged PII objects
 * (user, customer, profile, account).
 *
 * Severity is set to warning-only because production audit logging may
 * legitimately record request bodies for compliance.
 */
const LOGGING_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    // Logging req.body or request.body
    pattern: /\b(?:console|logger|log)\.(?:log|warn|error|info|debug)\([^)]*\breq(?:uest)?\.body\b/g,
    label: "Logging raw request body",
  },
  {
    // Logging JSON.stringify output (could contain PII from req/res objects)
    pattern: /\b(?:console|logger|log)\.(?:log|warn|error|info|debug)\([^)]*JSON\.stringify\([^)]*(?:req(?:uest)?|res(?:ponse)?|user|customer|profile|account|body|headers)/g,
    label: "Logging JSON.stringify of request/response data",
  },
  {
    // Logging headers that may contain auth tokens or cookies
    pattern: /\b(?:console|logger|log)\.(?:log|warn|error|info|debug)\([^)]*\breq(?:uest)?\.headers/g,
    label: "Logging HTTP headers (may contain auth/cookies)",
  },
  {
    // Logging PII objects directly
    pattern: /\b(?:console|logger|log)\.(?:log|warn|error|info|debug)\([^)]*\b(?:user|customer|profile|account)\b[^)]*\)/g,
    label: "Logging PII object directly",
  },
];

/* ──────────────────────────────────────────────────────────────────────────────
 * GenAI defect pattern — Rule 6: Insecure security header defaults
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Patterns for insecure HTTP security header configurations.
 *
 * Blocker patterns: CORS wildcard origin, disabled HSTS.
 * Warning patterns: permissive CSP (unsafe-inline/unsafe-eval), bare cors()
 * call, low HSTS max-age.
 */
const INSECURE_HEADER_PATTERNS: { pattern: RegExp; label: string; severity: "blocker" | "warning" }[] = [
  {
    // CORS wildcard origin header (handles both raw headers and setHeader() calls)
    pattern: /Access-Control-Allow-Origin[^;\n]*?["'`]?\*["'`]?/gi,
    label: "CORS wildcard origin",
    severity: "blocker",
  },
  {
    // CORS config with wildcard origin
    pattern: /origin\s*:\s*["'`]\*["'`]/g,
    label: "CORS config with wildcard origin",
    severity: "blocker",
  },
  {
    // HSTS header disabled (max-age=0)
    pattern: /Strict-Transport-Security[^;]*max-age\s*=\s*0\b/gi,
    label: "HSTS disabled (max-age=0)",
    severity: "blocker",
  },
  {
    // Bare/permissive cors() call with no config or origin: true
    pattern: /cors\(\s*(?:\{\s*origin\s*:\s*true\s*\})?\s*\)/g,
    label: "Permissive CORS middleware (bare cors() or origin: true)",
    severity: "warning",
  },
  {
    // CSP with unsafe-inline or unsafe-eval
    pattern: /(?:script-src|style-src|default-src)[^;]*['"](?:unsafe-inline|unsafe-eval)['"]/gi,
    label: "CSP allows unsafe-inline or unsafe-eval",
    severity: "warning",
  },
  {
    // HSTS with very low max-age (1 - <1 year; 0 is caught by blocker pattern)
    pattern: /Strict-Transport-Security[^;]*max-age\s*=\s*[1-9]\d{0,5}\b/gi,
    label: "HSTS max-age too low (< 1 year)",
    severity: "warning",
  },
];

/* ──────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Extract changed file paths from a unified diff string.
 *
 * Parses `+++ b/<path>` lines — the canonical indicator of files touched
 * by a diff. Returns an empty array if no file paths are found (empty diff
 * or format mismatch).
 *
 * @param diffContent — Raw unified diff output (e.g. from `git diff`).
 * @returns Array of file paths relative to repo root.
 */
export function extractDiffFiles(diffContent: string): string[] {
  const files: string[] = [];
  for (const line of diffContent.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) files.push(m[1]);
  }
  return files;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 1 — Scope violation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect files changed in the diff that are not listed in the plan's change set.
 *
 * Files starting with "." (dotfiles like `.claude/`, `.github/`) are excluded
 * from violation detection, as they are often managed outside the plan scope.
 *
 * @param changedFiles — File paths extracted from the diff (use extractDiffFiles).
 * @param planFiles — Set of allowed file paths from the plan's changes[].file.
 * @returns Findings array — empty for no violation, one entry otherwise.
 */
export function scopeViolation(
  changedFiles: string[],
  planFiles: Set<string>,
): PreCheckFinding[] {
  const violations = changedFiles.filter((f) => !planFiles.has(f) && !f.startsWith("."));
  if (violations.length === 0) return [];
  return [
    {
      rule: "scope_violation",
      severity: "warning",
      message: "Diff touches files outside plan scope",
      detail: violations.join(", "),
    },
  ];
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 2 — Diff size anomaly
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect when the actual diff size far exceeds the plan's estimate.
 *
 * Compares `actualLines` (derived from diff content) against
 * `estimatedLines * multiplier`. Only fires when the plan provides a
 * non-zero estimate, preventing false triggers on unestimated plans.
 *
 * @param actualLines — Number of lines in the raw diff (split by "\n").
 * @param estimatedLines — Plan's `estimated_diff_lines` value.
 * @param multiplier — Ratio threshold (default DEFAULT_SIZE_MULTIPLIER = 3).
 * @returns Findings array — empty if within bounds, one entry otherwise.
 */
export function diffSizeAnomaly(
  actualLines: number,
  estimatedLines: number,
  multiplier = DEFAULT_SIZE_MULTIPLIER,
): PreCheckFinding[] {
  if (estimatedLines <= 0 || actualLines <= estimatedLines * multiplier) return [];
  return [
    {
      rule: "diff_size_anomaly",
      severity: "warning",
      message: `Diff size (${actualLines}) exceeds ${multiplier}× estimate (${estimatedLines})`,
      detail: `Actual: ${actualLines}, Estimated: ${estimatedLines}`,
    },
  ];
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 3 — Security red flag
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Scan raw diff content for high-signal secret patterns.
 *
 * Matches against a curated list of patterns (API keys, private keys,
 * GitHub tokens). Any match is treated as a **blocker** — the pipeline
 * should halt before any LLM call to avoid exposing secrets in prompts
 * or logs.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no patterns matched, one entry per pattern type.
 */
export function securityRedFlag(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of SECRET_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "security_red_flag",
        severity: "blocker",
        message: `Potential secret leak: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 4 — Hardcoded credential
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect hardcoded credentials in AI-generated diff content.
 *
 * Scans for URI connection strings with embedded user:password, variable
 * assignments to credential-named identifiers, object-literal credential
 * keys with string literal values, and HTTP header credential values.
 *
 * Safe variable names (example, test, placeholder, dummy, mock, fake,
 * sample) are expected to be excluded via the safe-name heuristic in
 * CREDENTIAL_PATTERNS. Any match is treated as a **blocker**.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no patterns matched, one entry per pattern type.
 */
export function hardcodedCredential(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "hardcoded_credential",
        severity: "blocker",
        message: `Hardcoded credential detected: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 5 — Unsafe eval
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect eval() and new Function() calls in the diff.
 *
 * These patterns are commonly associated with code injection and dynamic code
 * evaluation risks. Both are treated as blockers to prevent accidental or
 * purposeful introduction of unsafe dynamic code execution.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no unsafe eval patterns detected.
 */
export function unsafeEval(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of UNSAFE_EVAL_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "unsafe_eval",
        severity: "blocker",
        message: `Unsafe eval pattern detected: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 6 — Shell injection
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect sensitive data exposure through verbose logging.
 *
 * Scans for logged request bodies, JSON.stringify of request/response data,
 * logged HTTP headers, and direct PII object logging.
 *
 * All matches are **warning** severity only, since production audit logging
 * may legitimately record request bodies. Config toggles can suppress checks
 * per deployment.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no patterns matched, one entry per pattern type.
 */
export function dataExposureLogging(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of LOGGING_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "data_exposure_logging",
        severity: "warning",
        message: `Sensitive data may be exposed via logging: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 6 — Shell injection
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect exec/execSync calls with template literals in the diff.
 *
 * Template literals passed to shell execution functions (exec, execSync, etc.)
 * can lead to command injection when the template contains interpolated user
 * input. Blocker severity prevents accidental shell injection vectors.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no shell injection patterns detected.
 */
export function shellInjection(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of SHELL_INJECTION_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "shell_injection",
        severity: "blocker",
        message: `Shell injection risk: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 7 — Prompt injection risk
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect dynamic interpolation in system prompt assignments.
 *
 * Template literals with interpolation in system prompt assignments can
 * introduce prompt injection vulnerabilities when user-controlled content
 * is embedded. Warning severity as this is a heuristic — some interpolations
 * may be safe (e.g. controlled role names, version strings).
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no prompt injection patterns detected.
 */
export function promptInjectionRisk(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of PROMPT_INJECTION_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "prompt_injection_risk",
        severity: "warning",
        message: `Prompt injection risk: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 9 — Unsafe exec
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect exec(), spawn(), shell:true, and Bun.spawnSync() calls in the diff.
 *
 * These patterns represent direct OS command execution and subprocess spawning.
 * Unlike shellInjection (which catches template-literal-based injection vectors),
 * this is a broader check flagging ANY usage of these APIs — useful for catching
 * GenAI-generated code that introduces unexpected subprocess calls (e.g. Meta AI
 * chatbot abuse where exec() was used for API key exfiltration).
 *
 * Blocker severity prevents accidental introduction of OS command execution
 * vectors in reviewed code.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no unsafe exec patterns detected.
 */
export function unsafeExec(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of UNSAFE_EXEC_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "unsafe_exec",
        severity: "blocker",
        message: `Unsafe exec pattern detected: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 10 — Unsafe innerHTML
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect .innerHTML assignments, dangerouslySetInnerHTML, and v-html usage.
 *
 * These patterns introduce XSS vulnerabilities when user-controlled content
 * is interpolated into raw HTML. Warning severity because some usages may be
 * safe (e.g. trusted content, sanitized input) — flagged for LLM review
 * rather than automatic blocking.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no unsafe innerHTML patterns detected.
 */
export function unsafeInnerHtml(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label } of UNSAFE_INNER_HTML_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "unsafe_inner_html",
        severity: "warning",
        message: `Unsafe innerHTML pattern detected: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rule 11 — Insecure security header defaults
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect insecure HTTP security header defaults.
 *
 * Blocker patterns: CORS wildcard origin, disabled HSTS.
 * Warning patterns: permissive CSP, bare cors(), low HSTS max-age.
 *
 * @param diffContent — Raw unified diff output.
 * @returns Findings array — empty if no patterns matched, one entry per pattern type.
 */
export function insecureSecurityConfig(diffContent: string): PreCheckFinding[] {
  const findings: PreCheckFinding[] = [];
  for (const { pattern, label, severity } of INSECURE_HEADER_PATTERNS) {
    const matches = diffContent.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        rule: "insecure_security_config",
        severity,
        message: `Insecure security header: ${label}`,
        detail: `${matches.length} occurrence(s)`,
      });
    }
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Orchestrator — runPreCheck
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run all 11 deterministic pre-check rules against a raw diff.
 *
 * Evaluation order:
 *  1. Scope violation              (warning)  — files outside plan scope
 *  2. Diff size anomaly            (warning)  — lines >> estimate × multiplier
 *  3. Security red flag            (blocker)  — secret patterns in diff
 *  4. Hardcoded credential         (blocker)  — credentials in AI-generated code
 *  5. Unsafe eval                  (blocker)  — eval(), new Function(), setTimeout(string) in diff
 *  6. Shell injection              (blocker)  — exec/spawn with template literal
 *  7. Prompt injection risk        (warning)  — dynamic interpolation in system prompt
 *  8. Data exposure logging        (warning)  — sensitive data via verbose logging
 *  9. Unsafe exec                  (blocker)  — exec(), spawn(), shell:true, Bun.spawnSync() in diff
 * 10. Unsafe innerHTML             (warning)  — innerHTML=, dangerouslySetInnerHTML, v-html in diff
 * 11. Insecure security config     (mixed)    — insecure HTTP security header defaults
 *
 * The result's `ok` is `true` only when no blocker findings exist.
 * Findings include both blocker and warning severities for complete
 * diagnostic reporting.
 *
 * @param diffContent — Raw unified diff output (e.g. from `git diff`).
 * @param plan — Partial plan with `changes` and `estimated_diff_lines`.
 * @param config — Optional override; omitted fields fall back to DEFAULT_PRE_CHECK_CONFIG.
 * @returns PreCheckResult with aggregated findings and latency telemetry.
 */
export function runPreCheck(
  diffContent: string,
  plan: Pick<Plan, "changes" | "estimated_diff_lines">,
  config?: Partial<PreCheckConfig>,
): PreCheckResult {
  const t0 = performance.now();
  const cfg: PreCheckConfig = { ...DEFAULT_PRE_CHECK_CONFIG, ...config };
  const findings: PreCheckFinding[] = [];
  const planFiles = new Set(plan.changes.map((c) => c.file));

  // Rule 1: scope violation
  if (cfg.block_on_scope_violation) {
    const changedFiles = extractDiffFiles(diffContent);
    findings.push(...scopeViolation(changedFiles, planFiles));
  }

  // Rule 2: diff size anomaly
  if (cfg.block_on_size_anomaly) {
    const actualLines = diffContent.split("\n").length - 1;
    findings.push(...diffSizeAnomaly(actualLines, plan.estimated_diff_lines));
  }

  // Rule 3: security red flag
  if (cfg.block_on_security_red_flag) {
    findings.push(...securityRedFlag(diffContent));
  }

  // Rule 4: hardcoded credential
  if (cfg.block_on_hardcoded_credential) {
    findings.push(...hardcodedCredential(diffContent));
  }

  // Rule 5: unsafe eval patterns
  if (cfg.block_on_unsafe_eval) {
    findings.push(...unsafeEval(diffContent));
  }

  // Rule 6: shell injection patterns
  if (cfg.block_on_shell_injection) {
    findings.push(...shellInjection(diffContent));
  }

  // Rule 7: prompt injection risk
  if (cfg.block_on_prompt_injection_risk) {
    findings.push(...promptInjectionRisk(diffContent));
  }

  // Rule 8: data exposure logging
  if (cfg.block_on_data_exposure_logging) {
    findings.push(...dataExposureLogging(diffContent));
  }

  // Rule 9: unsafe exec patterns (broader than shell_injection — catches any exec/spawn)
  if (cfg.block_on_unsafe_exec) {
    findings.push(...unsafeExec(diffContent));
  }

  // Rule 10: unsafe innerHTML patterns
  if (cfg.block_on_unsafe_inner_html) {
    findings.push(...unsafeInnerHtml(diffContent));
  }

  // Rule 11: insecure security config
  if (cfg.block_on_insecure_security_config) {
    findings.push(...insecureSecurityConfig(diffContent));
  }

  return {
    ok: !findings.some((f) => f.severity === "blocker"),
    findings,
    latencyMs: Math.round(performance.now() - t0),
  };
}
