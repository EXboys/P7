import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { loadConfig } from "./config.ts";
import { initDb } from "./state.ts";
import { DEFAULT_BASH_COMMAND_ALLOWLIST } from "./execution/permission.ts";

/* ── Types ── */

export interface BoundaryAuditItem {
  /** Layer identifier: "filesystem" | "api-domain" | "bash-command" | "plan-scope" */
  layer: string;
  /** Short check label, kebab-case */
  check: string;
  /** pass / fail / risk (architectural concern) / info (informational) */
  status: "pass" | "fail" | "risk" | "info";
  /** Human-readable description of what was checked and the finding */
  detail: string;
}

export interface BoundaryAuditReport {
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    riskLevel: "low" | "medium" | "high";
  };
  /** All check items grouped by layer */
  items: BoundaryAuditItem[];
  /** Risk flags aggregated from across layers (architectural concerns, historical violations) */
  riskFlags: string[];
}

/* ── Helpers ── */

/** Resolve to the `src/` directory of this module. */
function srcDir(): string {
  return import.meta.dir;
}

/** Read a module-relative source file for pattern scanning. */
function readSource(relativePath: string): string {
  const path = join(srcDir(), relativePath);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/* ── Layer 1: Worktree filesystem isolation ── */

function auditFilesystem(projectPath: string, items: BoundaryAuditItem[], riskFlags: string[]): void {
  const permSrc = readSource("execution/permission.ts");

  // 1.1 Worktree isolation directory
  const wtDir = join(projectPath, ".p7", "worktrees");
  const wtExists = existsSync(wtDir);
  items.push({
    layer: "filesystem",
    check: "worktree-isolation-dir",
    status: wtExists ? "pass" : "fail",
    detail: wtExists
      ? `.p7/worktrees/ isolation directory exists at ${wtDir}`
      : `.p7/worktrees/ NOT found at ${wtDir} — executor cannot create isolated worktrees`,
  });

  // 1.2 isPathWithinWorktree function
  const hasIsPathWithin = permSrc.includes("function isPathWithinWorktree");
  items.push({
    layer: "filesystem",
    check: "is-path-within-worktree",
    status: hasIsPathWithin ? "pass" : "fail",
    detail: hasIsPathWithin
      ? "isPathWithinWorktree() defined in execution/permission.ts — enforces worktree boundary for Read/Write/Edit/Bash operations"
      : "isPathWithinWorktree() MISSING — file path boundary enforcement is absent",
  });

  // 1.3 Extra read paths (.p7/discovery)
  const discoveryDir = join(projectPath, ".p7", "discovery");
  const hasDiscovery = existsSync(discoveryDir);
  const hasExtraPaths = permSrc.includes("extraProjectPaths") || permSrc.includes("extraReadPaths");
  let extraPathsDetail: string;
  let extraPathsStatus: "pass" | "info";
  if (hasDiscovery && hasExtraPaths) {
    extraPathsDetail = ".p7/discovery/ directory exists and extraProjectPaths/extraReadPaths references found in buildPreToolHook";
    extraPathsStatus = "pass";
  } else if (hasDiscovery && !hasExtraPaths) {
    extraPathsDetail = ".p7/discovery/ exists BUT no extraProjectPaths reference in buildPreToolHook — discovery dir may not be readable by executor";
    extraPathsStatus = "info";
  } else if (!hasDiscovery && hasExtraPaths) {
    extraPathsDetail = ".p7/discovery/ not found locally — no discovery data generated yet; extra paths config present in code";
    extraPathsStatus = "info";
  } else {
    extraPathsDetail = ".p7/discovery/ not found and no extra path references in permission.ts";
    extraPathsStatus = "info";
  }
  items.push({
    layer: "filesystem",
    check: "extra-read-paths",
    status: extraPathsStatus,
    detail: extraPathsDetail,
  });

  // 1.4 Sensitive system path prefixes
  const hasSensitivePrefixes = permSrc.includes('"/etc/"') || permSrc.includes("sensitivePrefixes");
  items.push({
    layer: "filesystem",
    check: "sensitive-path-prefixes",
    status: hasSensitivePrefixes ? "pass" : "fail",
    detail: hasSensitivePrefixes
      ? "Sensitive system path prefixes (/etc/, /usr/, /bin/, /sbin/, /var/, /dev/, /proc/, etc.) are blocked by hasBashPathTraversal"
      : "No sensitive system path prefix blocking found in hasBashPathTraversal",
  });

  // 1.5 hasBashPathTraversal guard
  const hasPathTraversal = permSrc.includes("function hasBashPathTraversal");
  items.push({
    layer: "filesystem",
    check: "bash-path-traversal-guard",
    status: hasPathTraversal ? "pass" : "fail",
    detail: hasPathTraversal
      ? "hasBashPathTraversal() defined — blocks relative traversal (../), home dir (~), and sensitive absolute paths"
      : "hasBashPathTraversal() MISSING — Bash path traversal is not checked",
  });
}

/* ── Layer 2: API domain whitelist ── */

function auditApiDomain(projectPath: string, items: BoundaryAuditItem[], riskFlags: string[]): void {
  const apiDomainSrc = readSource("api-domain.ts");
  const sdkSrc = readSource("sdk.ts");

  // 2.1 Config: allowed_api_domains
  try {
    const cfg = loadConfig(projectPath);
    const domains = cfg.allowed_api_domains ?? ["api.anthropic.com"];
    const hasDomains = domains.length > 0;
    items.push({
      layer: "api-domain",
      check: "allowed-api-domains",
      status: hasDomains ? "pass" : "fail",
      detail: hasDomains
        ? `allowed_api_domains configured: [${domains.join(", ")}]`
        : "allowed_api_domains is empty — no API domains are whitelisted",
    });
  } catch (e) {
    items.push({
      layer: "api-domain",
      check: "allowed-api-domains",
      status: "fail",
      detail: `Failed to load project config: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 2.2 ANTHROPIC_BASE_URL dynamic extension
  const hasDynamicExt = apiDomainSrc.includes("resolveAllowedApiDomains");
  items.push({
    layer: "api-domain",
    check: "base-url-dynamic-extension",
    status: hasDynamicExt ? "pass" : "fail",
    detail: hasDynamicExt
      ? "resolveAllowedApiDomains() in api-domain.ts dynamically extends whitelist with ANTHROPIC_BASE_URL hostname, preventing misconfigured proxy rejection"
      : "resolveAllowedApiDomains() NOT found — ANTHROPIC_BASE_URL hostname is not auto-whitelisted",
  });

  // 2.3 apiHostnameFromBaseUrl utility
  const hasHostnameUtil = apiDomainSrc.includes("apiHostnameFromBaseUrl");
  items.push({
    layer: "api-domain",
    check: "hostname-parse-utility",
    status: hasHostnameUtil ? "pass" : "fail",
    detail: hasHostnameUtil
      ? "apiHostnameFromBaseUrl() parses ANTHROPIC_BASE_URL hostname with URL fallback"
      : "apiHostnameFromBaseUrl() NOT found — hostname parsing utility is missing",
  });

  // 2.4 validateApiDomain enforcement in SDK
  const hasValidateDomain = sdkSrc.includes("validateApiDomain");
  items.push({
    layer: "api-domain",
    check: "validate-api-domain-enforcement",
    status: hasValidateDomain ? "pass" : "fail",
    detail: hasValidateDomain
      ? "validateApiDomain() called in runSdkQuery() before every SDK query — API domain is verified at runtime"
      : "validateApiDomain() NOT referenced in sdk.ts — runtime API domain validation is absent",
  });
}

/* ── Layer 3: Bash command execution bounds ── */

function auditBashCommand(projectPath: string, items: BoundaryAuditItem[], riskFlags: string[]): void {
  const permSrc = readSource("execution/permission.ts");

  // 3.1 Positive allowlist: DEFAULT_BASH_COMMAND_ALLOWLIST
  const hasAllowlist = permSrc.includes("DEFAULT_BASH_COMMAND_ALLOWLIST");
  items.push({
    layer: "bash-command",
    check: "command-allowlist-defined",
    status: hasAllowlist ? "pass" : "fail",
    detail: hasAllowlist
      ? `DEFAULT_BASH_COMMAND_ALLOWLIST exported with ${DEFAULT_BASH_COMMAND_ALLOWLIST.size} commands (inspection, build, test, read-only utilities)`
      : "DEFAULT_BASH_COMMAND_ALLOWLIST NOT found — no positive allowlist exists",
  });

  // 3.2 Positive allowlist gate enforced
  const hasAllowlistGate = permSrc.includes("DEFAULT_BASH_COMMAND_ALLOWLIST.has(baseCommand)");
  items.push({
    layer: "bash-command",
    check: "positive-allowlist-gate",
    status: hasAllowlistGate ? "pass" : "fail",
    detail: hasAllowlistGate
      ? "Positive allowlist gate enforced: command base name must be in DEFAULT_BASH_COMMAND_ALLOWLIST before any secondary check"
      : "Positive allowlist gate NOT integrated into buildPreToolHook Bash handler",
  });

  // 3.3 Negative-list pattern (dangerousBash regex) — architectural risk
  const hasDangerousBash = permSrc.includes("dangerousBash");
  const negListLines: string[] = [];
  if (hasDangerousBash) {
    // Extract the dangerousBash regex pattern for the detail
    const match = permSrc.match(/const\s+dangerousBash\s*=\s*(\/.+\/[a-z]*)/);
    if (match) negListLines.push(match[1]);
  }
  items.push({
    layer: "bash-command",
    check: "negative-list-pattern",
    status: hasDangerousBash ? "risk" : "info",
    detail: hasDangerousBash
      ? `Negative-list (dangerousBash regex${negListLines.length ? `: ${negListLines[0].slice(0, 80)}…` : ""}) supplements positive allowlist — risky mutation commands are blocked by regex, but negative-list approach is inherently incomplete`
      : "No negative-list (dangerousBash) pattern found",
  });
  if (hasDangerousBash) {
    riskFlags.push(
      "bash-negative-list: Negative-list (dangerousBash regex) supplements the positive allowlist. " +
        "Negative-list patterns are inherently incomplete and may miss novel attack vectors. " +
        "Consider migrating to positive-only approach (see PR #155) to reduce bypass surface.",
    );
  }

  // 3.4 Path traversal gate in buildPreToolHook
  const hasTraversalGate = permSrc.includes("hasBashPathTraversal(") && permSrc.includes("Path traversal");
  items.push({
    layer: "bash-command",
    check: "path-traversal-gate",
    status: hasTraversalGate ? "pass" : "fail",
    detail: hasTraversalGate
      ? "hasBashPathTraversal() called as step 3 in buildPreToolHook Bash gate — prevents filesystem boundary escape via command arguments"
      : "hasBashPathTraversal() NOT integrated into buildPreToolHook Bash handler",
  });
}

/* ── Layer 4: Plan scope file authorization ── */

function auditPlanScope(projectPath: string, items: BoundaryAuditItem[], riskFlags: string[]): void {
  const permSrc = readSource("execution/permission.ts");

  // 4.1 allowedFiles set authorization in buildPreToolHook
  const hasAllowedFiles = permSrc.includes("allowedFiles");
  const hasPlanFileCheck = permSrc.includes("File not in plan");
  items.push({
    layer: "plan-scope",
    check: "file-level-authorization",
    status: hasAllowedFiles && hasPlanFileCheck ? "pass" : "fail",
    detail: hasAllowedFiles && hasPlanFileCheck
      ? "allowedFiles set enforced in buildPreToolHook — only files listed in the current Plan are writable; Read-only access is allowed for all boundary-checked paths"
      : hasAllowedFiles
        ? "allowedFiles set exists but file-authorization deny message ('File not in plan') NOT found — authorization may not be enforced"
        : "allowedFiles set NOT referenced in permission.ts — plan-scope file authorization is absent",
  });

  // 4.2 fatalExecutorPermissionViolations — Write/Edit outside-worktree detection
  const hasFatalViolations = permSrc.includes("fatalExecutorPermissionViolations");
  items.push({
    layer: "plan-scope",
    check: "fatal-violation-detection",
    status: hasFatalViolations ? "pass" : "fail",
    detail: hasFatalViolations
      ? "fatalExecutorPermissionViolations() filters Write/Edit operations targeting paths outside the worktree boundary — these cause execution failure"
      : "fatalExecutorPermissionViolations() NOT found — critical Write/Edit boundary violations are not distinguished from recoverable denials",
  });

  // 4.3 Historical permission violations from PlanState DB
  let historicalItems: Array<{ plan_id: string; error: string | null; status: string }> = [];
  try {
    const db = initDb(projectPath);
    historicalItems = db
      .query(
        `SELECT plan_id, error, status FROM plan_states
         WHERE error LIKE '%boundary%' OR error LIKE '%outside worktree%'
            OR findings LIKE '%boundary%' OR findings LIKE '%outside worktree%'
         ORDER BY updated_at DESC LIMIT 10`,
      )
      .all() as Array<{ plan_id: string; error: string | null; status: string }>;
  } catch {
    // DB not yet initialized or schema mismatch — first-run scenario
  }

  items.push({
    layer: "plan-scope",
    check: "historical-permission-violations",
    status: historicalItems.length === 0 ? "pass" : "risk",
    detail:
      historicalItems.length === 0
        ? "No historical boundary permission violations found in PlanState DB"
        : `Found ${historicalItems.length} historical boundary violation(s) in PlanState DB`,
  });

  if (historicalItems.length > 0) {
    riskFlags.push(
      `historical-violations: ${historicalItems.length} permission boundary violation(s) recorded in plan_states table`,
    );
    for (const v of historicalItems.slice(0, 3)) {
      const errSnippet = (v.error ?? "").slice(0, 120);
      riskFlags.push(`  plan=${v.plan_id} status=${v.status} error="${errSnippet}"`);
    }
    if (historicalItems.length > 3) {
      riskFlags.push(`  (${historicalItems.length - 3} more — query plan_states directly for full list)`);
    }
  }
}

/* ── Public API ── */

/**
 * Scan all 4 configured boundary layers for a project and return a structured
 * audit report with per-layer check items, summary statistics, and risk flags.
 */
export function auditBoundaries(projectPath: string): BoundaryAuditReport {
  const items: BoundaryAuditItem[] = [];
  const riskFlags: string[] = [];

  auditFilesystem(projectPath, items, riskFlags);
  auditApiDomain(projectPath, items, riskFlags);
  auditBashCommand(projectPath, items, riskFlags);
  auditPlanScope(projectPath, items, riskFlags);

  const totalChecks = items.length;
  const passed = items.filter((i) => i.status === "pass").length;
  const failed = items.filter((i) => i.status === "fail").length;

  let riskLevel: "low" | "medium" | "high" = "low";
  if (failed > 0) riskLevel = "high";
  else if (items.filter((i) => i.status === "risk").length > 0) riskLevel = "medium";

  return {
    summary: { totalChecks, passed, failed, riskLevel },
    items,
    riskFlags,
  };
}
