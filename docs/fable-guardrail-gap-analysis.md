# Fable-Class Tool-Calling Guardrail Gap Analysis

> **Analysis date**: 2026-06-11
> **Target**: `src/execution/permission.ts` @ `2a0ae20`
> **Scope**: Systematic gap audit between P7 executor permission hook and **Fable-class** tool-calling security guardrail patterns.
> **Methodology**: Fable patterns are inferred from HN discussion threads (HN 43115280, 43116818, 43117461), general agent-security literature, and the open-source tool-use security canon. Where Fable's internal mechanisms are undocumented, the best-known equivalent pattern from the broader agent-security literature is used as the reference.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Guardrail Dimension Mapping](#2-guardrail-dimension-mapping)
   - [2.1 Rate Limiting & Budget Control](#21-rate-limiting--budget-control)
   - [2.2 Context-Aware Permission Decisions](#22-context-aware-permission-decisions)
   - [2.3 Tiered / Graduated Approval](#23-tiered--graduated-approval)
   - [2.4 Output Validation & Filtering](#24-output-validation--filtering)
   - [2.5 Audit Trail & Forensics](#25-audit-trail--forensics)
   - [2.6 Sequential Tool-Use Constraints](#26-sequential-tool-use-constraints)
   - [2.7 Escalation & Human-in-the-Loop](#27-escalation--human-in-the-loop)
   - [2.8 Tool Composition Safety](#28-tool-composition-safety)
   - [2.9 Failure Recovery & Compensation](#29-failure-recovery--compensation)
   - [2.10 Adaptive / Learning Guardrails](#210-adaptive--learning-guardrails)
3. [Cross-Cutting Risk Flags](#3-cross-cutting-risk-flags)
4. [Recommendation Priority Matrix](#4-recommendation-priority-matrix)
5. [Summary: Where P7 Stands](#5-summary-where-p7-stands)

---

## 1. Executive Summary

P7's `permission.ts` implements a **static, two-gate permission model**:

1. **Bash gate** — Positive allowlist (`DEFAULT_BASH_COMMAND_ALLOWLIST`, ~50 commands) + negative regex for dangerous patterns + path-traversal scanning.
2. **Filesystem gate** — Worktree boundary enforcement + plan-scope file match for Write/Edit.

This model is effective for its original design goal (prevent filesystem escapes and mutation outside plan scope), but it lacks **dynamic, context-aware, and graduated safety mechanisms** that characterize Fable-class tool-calling guardrail systems.

| Metric | Value |
|--------|-------|
| Guardrail dimensions analyzed | 10 |
| Dimensions with blocker gaps | 4 |
| Dimensions with major gaps | 3 |
| Dimensions with minor gaps | 3 |
| Dimensions adequately covered | 0 |

---

## 2. Guardrail Dimension Mapping

### 2.1 Rate Limiting & Budget Control

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Token-aware rate limiting: per-agent-session tool-call quotas, cost budgets, and cooldown periods. Requests exceeding thresholds are queued, degraded (e.g., read-only fallback), or denied. Budgets are tracked against user/team allocations, not just session limits. |
| **P7 current state** | Partial — `executor.ts` has `deriveMaxTurns()` (30–60 turn cap based on estimated diff), `scaleLimits()` (maxFiles/maxDiffLines by complexity), and `withExponentialBackoff` for retry. `sdk-cost.ts` tracks token usage but does not enforce hard ceilings mid-execution. There is no per-agent-session tool-call counter, no cooldown mechanism, and no budget-aware degradation (e.g., "read-only mode after N denied calls"). |
| **Gap severity** | **MAJOR** |
| **Evidence** | `src/executor.ts` lines 58–69: `deriveMaxTurns` and `scaleLimits` are pre-computed from plan metadata and never adjusted at runtime. Tool-call frequency is unbounded within the turn limit. `sdk-cost.ts` is additive-only — no threshold enforcement. The `max_consecutive_failures` circuit breaker in `stability.md` applies to pipeline failures, not tool-call rate. |
| **Recommendation** | Introduce a per-execution `ToolBudget` object (extends `SdkCostSummary`) that tracks (a) total tool calls, (b) denied tool calls, (c) cumulative token cost. Enforce maxCalls (e.g., 200) and maxDeniedRatio (e.g., 30% denials → degrade to read-only). Add a cooldown that rejects all Bash/Write/Edit calls after 10 consecutive denials within a sliding 60-second window. |

---

### 2.2 Context-Aware Permission Decisions

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Permission outcomes vary with conversation state: a `Read` on a known file after a successful `Write` to the same path is low-risk; a `Bash` command containing a newly introduced variable from an untrusted source is high-risk. The permission engine considers the *relationship* between the current tool call and prior context (recent tool history, conversation topics, source of arguments). |
| **P7 current state** | Stateless — every tool call is evaluated independently. `buildPreToolHook` does not receive or consult prior tool outcomes, conversation state, or argument provenance. The `onDeny` callback records a reason string but does not feed back into subsequent decisions. The hook has no internal memory — there is no `ToolCallHistory` or `PermissionState` object. |
| **Gap severity** | **BLOCKER** |
| **Evidence** | `permission.ts` lines 176–260: The `PreToolUse` handler is a pure function with no mutable state or reference to prior calls. Each invocation starts from scratch. The `onDeny` callback (line 156) is fire-and-forget: it logs but doesn't update any decision state. The executor in `executor.ts` line 294 passes `onDeny` as a closure that only appends to `deniedOps[]` — no state machine. |
| **Recommendation** | Add a `PermissionContext` interface that tracks the last N tool calls (tool name, path, decision outcome, timestamp). Pass it to the hook factory. Implement escalation rules: (a) if the last 3 Bash calls were denied → deny the next Bash call regardless of content; (b) if a `Write` follows a `Read` on the same path → auto-allow; (c) if a `Bash` command references a file path that was just denied by the filesystem gate → deny. |

---

### 2.3 Tiered / Graduated Approval

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Tool calls are classified into risk tiers (auto-allow, confirm, require-approval, always-deny). The tier can escalate within a session: after N auto-allowed calls, the next call of the same type may require confirmation. Low-risk repetitive operations (e.g., repeated `Read` on adjacent files) are auto-merged into a batch approval. |
| **P7 current state** | Binary — `allow()` or `deny()` with no intermediate states. There is no "confirm" tier, no "warn-but-allow" mode, and no batching of low-risk operations. All writes to plan-authorized files are auto-allowed without any secondary signal (e.g., diff size, file sensitivity). |
| **Gap severity** | **BLOCKER** |
| **Evidence** | `permission.ts` lines 194–198: `allow()` returns a hard-coded `"allow"` decision. `deny()` returns `"deny"`. There is no third path. The `PreToolUse.hookSpecificOutput.permissionDecision` type is a union of exactly two strings — adding a third (`"escalate"`, `"confirm"`) would not be recognized by the caller. The executor (line 294) installs the hook but never handles non-binary outcomes. |
| **Recommendation** | Extend `permissionDecision` to support `"allow" | "deny" | "confirm"`. Add a `TierConfig` that maps tool/command pairs to risk tiers. Implement a session-level counter that auto-escalates after N identical approvals (e.g., 20 `Read` calls on non-plan files → escalate from auto-allow to confirm). Batch contiguous read-only operations on paths under the same directory into a single approval event. |

---

### 2.4 Output Validation & Filtering

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Tool outputs are validated before being passed to the next tool or returning to the LLM: schema validation for structured data, content policy filtering for generated text, secret/mask filtering for logs, and size/cost sanity checks. Excessively large outputs are truncated or rejected. |
| **P7 current state** | Weak — `pre-check.ts` validates *diff content* against 11 deterministic rules (scope, credentials, unsafe patterns), but this runs post-hoc on the final diff, not on each tool output. There is no output-side validation for `Read` results (e.g., file content size limits), `Bash` stdout (e.g., binary content detection), or `Glob`/`Grep` results (e.g., excessive match count). Tool outputs are passed directly to the LLM without filtering. |
| **Gap severity** | **MAJOR** |
| **Evidence** | `pre-check.ts` lines 29–45: All 11 rules inspect the *diff string* produced by code changes, not the tool outputs in real time. There is no `PostToolUse` hook anywhere in the codebase (`grep -r "PostToolUse" src/` returns empty). `sdk-tool-log.ts` records tool calls for diagnostics but performs no content validation. `src/executor.ts` line 358 formats permission findings into a human-readable block — retrospective, not proactive. |
| **Recommendation** | Introduce a `PostToolUse` hook (mirroring the existing `PreToolUse`) that validates tool outputs: (a) `Read` output > 10,000 lines → truncate with a warning; (b) `Bash` stdout containing binary/null bytes → reject or sanitize; (c) `Grep`/`Glob` results > 500 entries → cap and notify. Add an output-size budget that increments with each tool call and soft-caps at 50 KB accumulated output. |

---

### 2.5 Audit Trail & Forensics

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Every tool call is recorded with full context: timestamp, caller identity (user/agent), input parameters, decision outcome, decision reason, output summary (size, type). Records are queryable for post-hoc analysis, and anomaly detection runs against the audit stream in near-real-time. Retention policies and data classification labels are applied. |
| **P7 current state** | Present but sparse — `sdk-tool-log.ts` records tool call summaries to per-job log files via `appendExecuteToolLog`. The `onDeny` callback appends reasons to `deniedOps[]`. There is no structured audit store (searchable by path, tool type, or time range), no caller attribution beyond the job ID, and no anomaly detection. Output summaries are not recorded — only the fact of the call. |
| **Gap severity** | **MINOR** |
| **Evidence** | `sdk-tool-log.ts` lines 13–21: `emptyToolTrace` and `appendExecuteToolLog` maintain a line-based log with no indexing. `ingestSdkMessageForToolTrace` (line 49) extracts tool names and paths from SDK messages but does not persist them in a queryable store. `permission.ts` has no logging facility of its own — it delegates to the caller-supplied `onDeny`. There is no `onAllow` callback. |
| **Recommendation** | Replace the string-based `deniedOps[]` with a `PermissionRecord[]` array persisted to SQLite (reusing `state.ts`'s `initDb` infrastructure). Each record stores: `{id, jobId, toolName, input (truncated), decision, reason, timestampMs, outputSizeBytes}`. Add a `queryRecentPermits(jobId, windowMs)` function for post-hoc analysis. Consider adding a simple anomaly check: "more than 5 denials for the same tool/path in 60s" → flag. |

---

### 2.6 Sequential Tool-Use Constraints

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Tools have ordering and dependency constraints: `Write` cannot follow `Write` to the same path without an intervening `Read` (force awareness); `Bash` operations that mutate filesystem state must be preceded by a `Write` establishing the target file; destructive commands (`rm`, `mv`) require a prior `Read` of the target. These constraints prevent accidental overwrites and ensure the agent is acting on current state. |
| **P7 current state** | Absent — no ordering constraints between tool calls. An agent could issue `Write` → `Write` to the same path without a `Read` in between. There is no "must-read-before-write" enforcement. The only sequential guard is in the pipeline (`executor.ts`'s linear step order: SDK → typecheck → test → critic), not within an SDK execution pass. |
| **Gap severity** | **BLOCKER** |
| **Evidence** | `permission.ts` has no concept of call order — it evaluates each call independently against static allow/deny rules. The `PreToolUse` handler receives a single `input` object with no access to the call sequence. In `executor.ts`, the SDK pass (lines ~460–546) runs the SDK query multiple times, but each pass is a fresh LLM session with no tool-ordering memory across calls. |
| **Recommendation** | Add a `SequentialConstraint` module that tracks the last tool call per path. Rules: (a) `Write` to path P requires a `Read` of path P within the last 3 tool calls; (b) `Write` to path P cannot be repeated without an intervening `Read` or `Edit`; (c) `Bash` commands that reference a file path P must be preceded by a permission-approved file operation on P. Enforce these in the `PreToolUse` hook using the `PermissionContext` state (see §2.2). |

---

### 2.7 Escalation & Human-in-the-Loop

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Unclear or high-risk tool calls are escalated to a human operator via a structured notification (chat, dashboard widget, email). The escalation includes: the call context, risk assessment, proposed action, and available responses (allow-once, allow-session, deny, modify-and-allow). The system degrades gracefully while awaiting human response (e.g., queues the call, switches to read-only mode). |
| **P7 current state** | Absent — there is no human-in-the-loop path. All decisions are automated and terminal. The `onDeny` callback logs the denial but cannot request human intervention. The pipeline can stall (`recoverStall` in `pipeline-steps.ts`) but this is a timeout-based recovery, not an escalation. |
| **Gap severity** | **MAJOR** |
| **Evidence** | `permission.ts` returns only `allow` or `deny` — no `escalate` path. The executor installs the hook with a local `onDeny` closure (executor.ts line 294) that appends to a string array — no communication channel to a human operator. `src/notify/` contains DingTalk and generic notification senders, but they are not wired into the permission system. |
| **Recommendation** | Add an `escalate` decision outcome backed by a `HumanEscalation` interface. When a tool call matches escalation criteria (e.g., first `Bash` call containing `rm`, path outside plan but within worktree with extra path allowed), invoke the existing notify infrastructure (`src/notify/sender.ts`) to push a structured escalation request. While awaiting response, queue the tool call with a TTL (default 300s); if TTL expires, auto-deny and log. |

---

### 2.8 Tool Composition Safety

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Certain tool compositions are recognized as dangerous regardless of the individual tool safety: piping `Write` output into `Bash` (data exfiltration), using `Grep` results as arguments to `Bash` (injection), or chaining `Read` → `Write` across different file trees (copy-before-verify risk). The guardrail detects these chains and either blocks them or adds review checkpoints. |
| **P7 current state** | Absent — there is no cross-tool composition analysis. Each tool call is evaluated in isolation. An agent could `Grep` for API keys, then `Bash echo` the results to a network endpoint (if `curl` were in the allowlist, which it isn't), or `Read` a config file and `Write` it to a different path. The only composition guard is implicit in the Bash allowlist (no `curl`/`wget`/`ssh`), which prevents network exfiltration but not local composition risks. |
| **Gap severity** | **MINOR** |
| **Evidence** | The `PreToolUse` handler checks one tool at a time with no reference to the preceding tool call's output or arguments. The `PermissionContext` (§2.2) would provide the necessary state but does not yet exist. The Bash allowlist's omission of network commands is the only effective composition guard — it's indirect and incomplete. |
| **Recommendation** | Build on the `PermissionContext` (from §2.2) to track the last tool's output summary (size, path, key tokens). Implement composition rules: (a) `Bash` with arguments derived from the immediately preceding `Read`/`Grep` output is flagged with warning severity; (b) `Write` to a path different from the preceding `Read`'s path, with the same extension, is flagged as a potential copy-without-review; (c) consecutive `Grep` → `Bash` on the same search pattern is flagged for injection risk. |

---

### 2.9 Failure Recovery & Compensation

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | When a tool call fails partially (timeout, truncated output, unexpected format), the guardrail system can retry with modified parameters, degrade the output (return partial data with a warning), or compensate (e.g., fall back to a different tool). Failed calls are not silent — the agent is informed of the failure mode and available alternatives. |
| **P7 current state** | Minimal — `withExponentialBackoff` in `retry.ts` provides retry for SDK pipeline operations, but individual tool calls within an SDK pass (where permission.ts operates) have no recovery. A denied tool call returns a hard error to the agent; the agent may retry with different parameters, but there is no infrastructure for degraded responses or automatic fallback. The `onDeny` callback records but does not compensate. |
| **Gap severity** | **MINOR** |
| **Evidence** | `permission.ts` has no retry, fallback, or partial-allow logic. `retry.ts`'s `withExponentialBackoff` is used for pipeline-level operations (executor.ts line ~150), not for tool-call-level recovery. `sdk-tool-log.ts` tracks denied calls but cannot trigger recovery actions. The executor's retry-with-context mechanism (`execute-retry-context.ts`) applies to full plan execution failures, not individual tool calls. |
| **Recommendation** | Add a `CompensationStrategy` type: `{onDeny: "retry" | "fallback" | "warn-and-continue" | "abort"}`. Wire it into the permission hook so that denied calls can trigger: (a) retry with a modified pattern (e.g., split a large `Read` into chunked reads); (b) fallback to an alternative tool (e.g., `Glob` → `ls`); (c) warn-and-continue for non-critical reads. Log the compensation action for audit. |

---

### 2.10 Adaptive / Learning Guardrails

| Aspect | Detail |
|--------|--------|
| **Fable-class pattern** | Guardrail rules adapt based on historical patterns: frequently denied operations on specific paths get stricter pre-emptive blocking; frequently allowed operations get streamlined (batch approval, reduced logging). False positives (denials that the human overrides) cause rule relaxation. Rule effectiveness is measured via precision/recall on a labeled dataset of allowed/denied calls. |
| **P7 current state** | Static — all allowlist entries and path rules are defined at compile time. The `DEFAULT_BASH_COMMAND_ALLOWLIST` is a `ReadonlySet` with no runtime modification. `extraProjectPaths` is configurable at init but never adjusted during execution. There is no feedback loop from denial outcomes to rule tuning. |
| **Gap severity** | **MAJOR** |
| **Evidence** | `permission.ts` lines 90–118: `DEFAULT_BASH_COMMAND_ALLOWLIST` is `const` and `ReadonlySet` — no mutation path exists. The `buildPreToolHook` factory (line 153) accepts configurable paths but returns a static hook closure. `pre-check.ts`'s `PreCheckConfig` (line 32) has toggleable rules but no runtime learning — all toggles are pre-set in `config.ts`. There is no rule-effectiveness metric collection. |
| **Recommendation** | Replace the `ReadonlySet` with a `MutableAllowlist` wrapper that supports (a) adding/removing commands at runtime via config hot-reload; (b) tracking per-command denial frequency; (c) auto-suggesting allowlist changes when a command is denied >5 times across different jobs (indicating a legit use case). Add a `RuleEffectivenessSnapshot` type collected every 50 tool calls: `{precision, recall, deniedCount, allowedCount, falsePositiveEstimate}`. Persist to SQLite for trend analysis. Audit all pre-check rule precision/recall via the `convergence-metrics.ts` infrastructure. |

---

## 3. Cross-Cutting Risk Flags

| Flag | Risk Level | Description |
|------|-----------|-------------|
| **No `PostToolUse` hook** | HIGH | The entire guardrail architecture is pre-call only. There is zero validation of tool outputs — the LLM receives raw tool results without any filtering, truncation, or content policy check. |
| **Binary-only decisions** | HIGH | The allow/deny dichotomy prevents graduated responses. There is no "confirm," "warn-and-allow," "escalate," or "degrade" path — every decision is terminal and automated. |
| **Stateless permission engine** | HIGH | No call history, no conversation context, no argument provenance tracking. Each call is evaluated in a vacuum, making sequence-aware attacks (e.g., slow exfiltration across many calls) undetectable. |
| **No human escalation path** | MEDIUM | The pipeline can stall but cannot ask for help. A `deny` that a human would override (false positive) is permanent for that execution. |
| **Static allowlist** | MEDIUM | The command allowlist is immutable at runtime. Adding a command requires a code change and deployment. No feedback loop exists for false positives. |
| **No tool-call budget enforcement** | MEDIUM | `deriveMaxTurns` caps LLM turns but not tool calls within a turn. An agent could issue 100 tool calls in one turn and exhaust context without triggering any guardrail. |
| **Granularity mismatch** | LOW | The filesystem gate operates at file level (plan scope), but the Bash gate operates at command level. A command allowed by the Bash gate can access any file within the worktree, bypassing the per-file plan scope check. |
| **Audit trail is append-only text** | LOW | Tool logs are unstructured text files under `.p7/job-logs/`. No indexing, no query capability, no cross-job aggregation. Forensic analysis requires manual grep. |

---

## 4. Recommendation Priority Matrix

| Priority | Dimension | Impact | Effort | Recommendation |
|----------|-----------|--------|--------|----------------|
| **P0** | Context-aware decisions (§2.2) | Blocking | Medium | Add `PermissionContext` with call history |
| **P0** | Tiered approval (§2.3) | Blocking | Medium | Three-tier decision model |
| **P0** | Sequential constraints (§2.6) | Blocking | Small | Add per-path tool-ordering rules |
| **P1** | Output validation (§2.4) | Major | Medium | `PostToolUse` hook with content filters |
| **P1** | Rate limiting (§2.1) | Major | Small | `ToolBudget` with runtime enforcement |
| **P1** | Escalation (§2.7) | Major | Large | Human-in-the-loop via notify infra |
| **P2** | Adaptive guardrails (§2.10) | Major | Large | Mutable allowlist + effectiveness metrics |
| **P2** | Tool composition (§2.8) | Minor | Medium | Cross-call composition analysis |
| **P3** | Audit trail (§2.5) | Minor | Medium | SQLite-backed permission records |
| **P3** | Failure recovery (§2.9) | Minor | Small | Compensation strategies for denied calls |

**Effort estimates**: Small = <50 lines, Medium = 50–200 lines, Large = 200+ lines or cross-module refactoring.

---

## 5. Summary: Where P7 Stands

```
                      Fable-class target
                    ╔══════════════════╗
                    ║  Comprehensive   ║
                    ║  guardrail suite ║
                    ╚══════════════════╝
                            ▲
                            │                         P7 today
                            │              ╔══════════════════╗
                            │              ║  Static 2-gate   ║
                            │              ║  allow/deny only ║
                            │              ╚══════════════════╝
                            │                      ▲
                            └──────────────────────┘
                        10 dimensions,
                        7 with major+ gaps
```

P7's permission model is a **solid foundation** — the worktree isolation, Bash command allowlist, plan-scope file gate, and pre-check rule engine provide meaningful safety guarantees that many agent frameworks lack entirely. However, compared to Fable-class guardrail systems, the architecture is:

- **Static** where it should be dynamic (allowlist, rules, tiers)
- **Stateless** where it should be context-aware (no call history, no sequence tracking)
- **Binary** where it should be graduated (allow/deny only, no escalation or confirmation)
- **Pre-only** where it should be bidirectional (no output validation after tool execution)

The P0 recommendations (context-aware decisions, tiered approval, sequential constraints) form the minimal viable upgrade to close the most critical gaps. They require ~300–500 lines of new TypeScript across 3–4 files, reusing existing infrastructure (`executor.ts`'s hook integration, `state.ts`'s SQLite, `notify/` for escalation).

---

*Analysis generated by P7 executor. Fable patterns are inferred from public discussion and general agent-security research; see risks section of the originating plan for caveats.*
