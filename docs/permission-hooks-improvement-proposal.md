# Permission Hooks Improvement Proposal: From Static Guards to Context-Aware Safety

> **Status**: Decision Document — For Team Review and Prioritization
> **Date**: 2026-06-11
> **Scope**: Synthesize the Fable-class guardrail gap analysis (PR #159, commit `997771e`) and extracted trade-off principles into a structured improvement proposal covering design tensions, phased architecture recommendations, and risk assessment per P0–P3 recommendation.
> **Target**: `src/execution/permission.ts` (PreToolUse hook) + executor integration

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Design Trade-Off Dimensions](#2-design-trade-off-dimensions)
3. [Recommended Architecture: Three-Phase Upgrade](#3-recommended-architecture-three-phase-upgrade)
   - [3.1 Phase 1: PermissionContext State Machine](#31-phase-1-permissioncontext-state-machine)
   - [3.2 Phase 2: Three-Tier Decision Model](#32-phase-2-three-tier-decision-model)
   - [3.3 Phase 3: PostToolUse Hooks & Output Validation](#33-phase-3-posttooluse-hooks--output-validation)
4. [Phased Implementation Roadmap](#4-phased-implementation-roadmap)
5. [Risk Assessment Matrix](#5-risk-assessment-matrix)
6. [Decision Log & Open Questions](#6-decision-log--open-questions)
7. [References](#7-references)

---

## 1. Executive Summary

P7's current `permission.ts` implements a **static, two-gate permission model**: a Bash command allowlist + worktree-boundary filesystem gate. This model was effective for its original design goal (prevent filesystem escapes and out-of-scope mutations), but the Fable guardrail gap analysis (PR #159) identified **10 guardrail dimensions** with **7 rated major+ severity gaps**:

| Gap Priority | Dimensions | Current State | Target State |
|---|---|---|---|
| **P0 (blocking)** | Context-aware decisions (§2.2), Tiered approval (§2.3), Sequential constraints (§2.6) | Stateless, binary, no ordering | Stateful, three-tier, per-path ordering |
| **P1 (major)** | Output validation (§2.4), Rate limiting (§2.1), Escalation (§2.7) | Pre-only checks, no budget, no HITL | PostToolUse hooks, ToolBudget, notify integration |
| **P2 (major)** | Adaptive guardrails (§2.10), Tool composition (§2.8) | Static allowlist, no cross-call analysis | Mutable allowlist, composition rules |
| **P3 (minor)** | Audit trail (§2.5), Failure recovery (§2.9) | Text logs, no compensation | SQLite records, fallback strategies |

**The recommended approach is a three-phase architecture upgrade** (detailed in §3) that incrementally transforms `permission.ts` from a static gate into a context-aware safety layer — without breaking existing executor or critic integration.

The total estimated effort is **~800–1,200 lines** of new/modified TypeScript across **~6 files**, spanning 3 sprints. Phase 1 (the P0 foundation) is the highest-impact, lowest-risk investment at ~300–400 lines.

---

## 2. Design Trade-Off Dimensions

Every permission system navigates inherent tensions between competing goals. The Fable gap analysis surfaces four core trade-off dimensions that any improvement must balance. Below, each dimension is articulated with concrete P7 examples and a recommended bias.

### 2.1 Strictness vs Usability

**The tension**: A security-first permission system that denies all ambiguous operations is more secure — but it frustrates legitimate use, causes workflow stalls, and incentivizes agents to find workarounds.

**P7-specific examples**:

| Too Strict (Deny → Stall) | Too Permissive (Allow → Risk) |
|---|---|
| `Write` to a plan scope file that is exactly the path pattern but uses `./` vs absolute — denied by `normalizeAllowedPath` comparison | `Bash` with `git status` allowed without read-before-execute — agent could run git operations without knowing current state |
| Repeated `Grep` on same pattern across different paths — each call evaluated independently, no batching | `Read` of a 50,000-line file auto-allowed — context window pollution |
| Path traversal check denies legitimate `Read` on symlinked files within worktree — `realpathSync` resolves outside | Plan-scope `Write` allowed regardless of diff size — no progressive confirmation for large writes |

**Recommended bias**: **Lean toward usability, but add confirmation tiers rather than blanket denials.** Replace hard `deny` with graduated responses: warn-and-allow for low-risk violations, confirm for medium-risk, and escalate for high-risk. This preserves workflow fluidity while maintaining safety.

### 2.2 Performance vs Safety

**The tension**: Every permission check adds latency. Context-aware checks (call history, argument provenance, composition analysis) require state lookups and cross-call reasoning that increase per-call overhead.

**P7-specific examples**:

| Performance-Critical Path | Safety-Enhancing Check | Latency Impact |
|---|---|---|
| `PreToolUse` handler in hot loop — every tool call (including 50+ `Read` calls) passes through the hook | `PermissionContext` query for last N calls — O(1) with circular buffer if in-memory | Negligible (~0.01ms per query) |
| `Bash` command validation — regex-based allowlist check | Path traversal scan with `realpathSync` for each absolute path | Moderate (~0.5–2ms per absolute path — filesystem I/O) |
| Tool composition analysis — cross-call pattern matching | Comparison of current tool arguments with prior tool outputs | Low if summary stored; high if full output stored |
| `PostToolUse` hook — output content validation | Size check, binary content detection, secret scanning | Content-size dependent (O(n) in output length) |

**Recommended bias**: **Strict per-call latency budget of <5ms for PreToolUse and <10ms for PostToolUse.** Use in-memory state (not SQLite) for decision-critical context. Defer expensive checks (composition analysis, secret scanning) to a background batch that runs every N calls. Benchmark on each phase delivery.

### 2.3 Automation vs Oversight

**The tension**: Fully automated permission decisions maximize throughput but miss edge cases that a human would catch. Human-in-the-loop escalation introduces latency and requires operator attention.

**P7-specific examples**:

| Fully Automated (Current) | Human-in-the-Loop (Target) |
|---|---|
| All `deny` decisions are terminal — agent receives hard error, no recourse | Escalation for ambiguous cases: e.g., first `Write` to a path pattern not in plan scope but within worktree → push notification |
| Permission gate has no override mechanism | Structured notify message with response options: allow-once, allow-session, deny, modify-and-allow |
| `onDeny` callback is fire-and-forget — no feedback loop to adjust future decisions | Human override feeds back into adaptive allowlist — denied-by-automation but allowed-by-human → rule relaxation signal |
| Pipeline stalls on persistent denials — `recoverStall` is timeout-based recovery | While awaiting human response, system degrades gracefully: queue the call, switch to read-only mode |

**Recommended bias**: **Automate by default with an escalation escape hatch.** The first P0 phase (§3.1) keeps everything automated but stateful. Phase 2 (§3.2) introduces the decision model that supports escalation. Phase 3 (§3.3) wires it to existing notify infrastructure. Human-in-the-loop is Phase 2+ — not Phase 1 — because the notification channel and response handling require non-trivial infra.

### 2.4 Simplicity vs Expressiveness

**The tension**: A simple permission model (static allowlist + file gate, like current `permission.ts`) is easy to reason about, audit, and debug. An expressive model (adaptive rules, tiered decisions, composition constraints) captures more edge cases but is harder to understand and maintain.

**P7-specific examples**:

| Simple (Current) | Expressive (Target) |
|---|---|
| `DEFAULT_BASH_COMMAND_ALLOWLIST` as `ReadonlySet<string>` — ~50 commands, immutable | `MutableAllowlist` with runtime add/remove, per-command denial frequency tracking, auto-suggest from usage patterns |
| Binary `allow()` / `deny()` — two code paths, easy to trace | Three-tier `allow` | `deny` | `confirm` — more states, more testing required |
| Stateless evaluation — each call is a pure function of (tool, path, command) | Stateful `PermissionContext` — decisions depend on call history, requiring integration tests with sequence scenarios |
| No output validation — tool results pass through untouched | `PostToolUse` with content filters, size caps, binary detection — new failure modes, false positive risk |

**Recommended bias**: **Start simple, add expressiveness where the data justifies it.** Phase 1 adds state (the PermissionContext) without changing the decision model — the simplest expressiveness upgrade. Phase 2 adds the third tier only after collecting enough denial/override data to calibrate thresholds. Phase 3 adds PostToolUse with conservative defaults (warn-only, never reject) for the first release, tightening to hard-reject only after false-positive rate is established.

---

## 3. Recommended Architecture: Three-Phase Upgrade

The architecture recommendation is a **three-phase incremental upgrade** that transforms `permission.ts` from a static gate into a context-aware safety layer. Each phase is independently shippable, backward-compatible, and delivers measurable safety improvement.

### 3.1 Phase 1: PermissionContext State Machine

**Goal**: Add call-history tracking and context-aware rules without changing the decision model.

**Key components**:

```
PermissionContext (new interface in execution/context.ts)
├── recentCalls: CircularBuffer<CallRecord>   // Last 50 tool calls
├── pathAccessLog: Map<string, CallRecord[]>   // Per-path access sequence
├── sessionStats: { totalCalls, totalDenials, consecutiveDenials }
└── constraints: SequentialConstraint[]

CallRecord {
  id: string
  toolName: string
  path?: string
  command?: string
  decision: "allow" | "deny"
  timestampMs: number
  outputSizeBytes?: number
}
```

**Changes to `buildPreToolHook`** (in `permission.ts`):

1. Accept an optional `PermissionContext` parameter
2. After each decision (allow or deny), append a `CallRecord` to `recentCalls`
3. Implement **three context-aware rules**:
   - **Consecutive denial backoff**: If `consecutiveDenials >= 3` for Bash, deny the next Bash call regardless of content (prevent hammering)
   - **Read-before-write enforcement**: If `Write` on path P is called without a preceding `Read` on P within the last 3 calls, issue a warning (not a denial — see §2.1, usability bias)
   - **Repetitive command detection**: If the same command string appears >3 times in `recentCalls`, flag as potential loop

**Integration point** (`executor.ts`):

```typescript
// In executor.ts, before the SDK query loop:
const permContext = new PermissionContext({ maxHistory: 50 });
// Pass to buildPreToolHook:
hooks: buildPreToolHook(allowedFiles, wt!.path, onDeny, extraPaths, permContext),
```

**Files changed**: `src/execution/permission.ts` (modify), `src/execution/context.ts` (new), `src/executor.ts` (integration, ~5 lines)

**Estimated diff**: ~200–250 lines (40% new module, 30% hook modifications, 5% executor integration, 25% tests)

**Backward compatibility**: `PermissionContext` parameter defaults to `undefined` — existing callers (if any) continue to work with stateless behavior.

---

### 3.2 Phase 2: Three-Tier Decision Model

**Goal**: Replace binary allow/deny with a three-tier (allow / confirm / deny) model supporting graduated responses.

**Key components**:

```
type PermissionDecision = "allow" | "deny" | "confirm";
type TierConfig = Record<string, ToolTier>;  // maps tool/command → tier

interface ToolTier {
  default: PermissionDecision;
  escalateAfter?: number;   // After N identical decisions, move to next tier
  escalateTo?: PermissionDecision;
  timeoutMs?: number;       // For "confirm" decisions: time to wait for resolution
}
```

**Example tier configuration**:

```typescript
const DEFAULT_TIER_CONFIG: TierConfig = {
  "Read":              { default: "allow" },
  "Glob":              { default: "allow" },
  "Grep":              { default: "allow" },
  "Write":             { default: "allow" },  // remains auto-allow for plan-scope files
  "Edit":              { default: "allow" },  // same as Write
  "Bash:inspect*":     { default: "allow" },  // test/inspection commands
  "Bash:git*":         { default: "allow", escalateAfter: 20, escalateTo: "confirm" },
  "Bash:*":            { default: "confirm" },
};
```

**How it works**:

1. Each tool call is classified into a tier by the `TierConfig` (exact match → glob match → wildcard)
2. If `default` is `"allow"`, the call proceeds immediately but the call record is tracked
3. If `escalateAfter` is set and N consecutive calls of this tier have been allowed, the N+1th call escalates to `escalateTo`
4. If `default` is `"deny"`, the call is blocked
5. If `default` is `"confirm"`, the call is queued and a structured notification is pushed (see escalation in §2.7):
   - Notify via existing `src/notify/sender.ts` with action options
   - Queue with TTL (default 60s); if TTL expires, auto-deny
   - Agent is informed: "Action requires confirmation — awaiting response"

**Integration point**: The `PreToolUse` hook returns `"confirm"` via `hookSpecificOutput.permissionDecision`. The SDK layer (or executor) handles the queuing and notification.

**Files changed**: `src/execution/permission.ts` (decision model), `src/execution/tier-config.ts` (new), `src/executor.ts` (handle confirm responses), `src/notify/sender.ts` (escalation format)

**Estimated diff**: ~300–350 lines (50% decision model + tier config, 20% executor confirm handling, 15% notification format, 15% tests)

**Backward compatibility**: The `TierConfig` defaults to all-allow for Read/Glob/Grep and all-confirm for unknown Bash — no behavioral change for existing callers. The `"confirm"` path is only triggered when the executor explicitly handles it.

---

### 3.3 Phase 3: PostToolUse Hooks & Output Validation

**Goal**: Add output-side validation (mirroring the existing PreToolUse hook) to validate tool results before they reach the LLM.

**Key components**:

```
PostToolUse hook (new file: execution/output-validator.ts)
├── sizeValidator:     Reject/truncate outputs > 10,000 lines
├── binaryDetector:    Reject outputs containing null bytes or binary headers
├── secretMasker:      Pattern-match for credential leakage (API keys, tokens)
├── contentPolicy:     Warn on oversized JSON, HTML, or base64 blobs
└── outputBudget:      Accumulate total output size across calls; soft-cap at 50KB
```

**How it works**:

1. The SDK `query` function supports a `PostToolUse` hook option (check SDK docs — if not supported, implement via a wrapper around the tool call stream)
2. After each tool execution, before the result is returned to the LLM, the PostToolUse hook runs
3. Each validator can: (a) pass-through (no action), (b) warn (annotate output with a notice), (c) truncate (clip output and append warning), (d) reject (replace output with error message)
4. Validator decisions are appended to the `PermissionContext` record for audit

**OutputBudget accumulation**:

```typescript
// In PermissionContext (extended in Phase 3):
outputBudget: {
  used: 0,
  softCap: 50_000,       // 50KB accumulated output → warn
  hardCap: 200_000,       // 200KB → reject further tool calls
  perCallSoft: 10_000,    // 10KB per call → truncate warning
}
```

**Integration point**: The executor wrappers `runSdkQuery` or the tool-call ingest path in `sdk.ts` to inject PostToolUse validators.

**Files changed**: `src/execution/output-validator.ts` (new), `src/execution/permission.ts` (extend PermissionContext), `src/sdk.ts` (if SDK supports PostToolUse hook), `src/executor.ts` (wire validators)

**Estimated diff**: ~350–400 lines (50% output validator module, 20% permission context extension, 15% SDK/executor integration, 15% tests)

**Backward compatibility**: All validators default to warn-only mode. Hard rejection is opt-in via `Config.enableStrictOutputValidation`.

---

## 4. Phased Implementation Roadmap

| Phase | Scope | Dependencies | Effort (lines) | Effort (person-days) | Sprint |
|---|---|---|---|---|---|
| **P1** | PermissionContext state machine + 3 context-aware rules + integration | None | ~250 | 2–3 | Sprint N |
| **P2** | Three-tier decision model + TierConfig + confirm handling | Phase 1 (PermissionContext) | ~350 | 3–5 | Sprint N+1 |
| **P3** | PostToolUse hooks + output validators + OutputBudget | Phase 1 (PermissionContext) | ~400 | 4–6 | Sprint N+2 |

**Total**: ~1,000 lines, 9–14 person-days, 3 sprints.

### Prerequisite Cleanup

Before Phase 1, two small cleanup items from the gap analysis (G9):

| Task | File | Effort | Priority |
|---|---|---|---|
| Remove phantom template vars (`history_window`, `total_findings`, etc.) | `prompts/diff-critic.md` lines 3–15 | ~12 lines removed | P2 (do before Phase 1 to reduce confusion) |
| Wire `buildThreatModelPreamble()` into `reviewDiff()` | `src/diff-critic.ts:reviewDiff()` | ~5 lines added | P1 (simple, high impact) |

### Key Milestones & Acceptance Criteria

| Phase | Milestone | Acceptance Criteria |
|---|---|---|
| P1 | PermissionContext operational | 1. After 50 tool calls, `recentCalls` contains 50 records; 2. 3 consecutive Bash denials → 4th Bash auto-denied; 3. `Write` without prior `Read` → warning logged |
| P2 | Three-tier decisions active | 1. All tools classified by `TierConfig`; 2. Bash commands with `escalateAfter` threshold trigger `"confirm"`; 3. Notification sent on confirm; 4. Agent received structured `"Action requires confirmation"` message |
| P3 | PostToolUse validation running | 1. `Read` on 15,000-line file truncated to 10,000 + warning; 2. Binary output detected and sanitized; 3. OutputBudget >50KB triggers warning; 4. All validators default to warn-only unless `Config.enableStrictOutputValidation` is true |

### Deferred Items (Backlog)

Based on the gap analysis's P3 recommendations and the trade-off analysis, the following are deferred:

| Item | Reason for Deferral | Trigger for Reprioritization |
|---|---|---|
| SQLite-backed permission records (§2.5) | Text logs suffice for current volume; SQLite schema change not justified | When cross-job querying becomes a daily need |
| Mutable allowlist with auto-suggest (§2.10) | Requires runtime config hot-reload infra that doesn't yet exist | When false-positive override rate exceeds 10% of denials |
| Full tool composition analysis (§2.8) | High complexity for low current risk (Bash allowlist blocks network exfiltration) | When network commands are added to allowlist |
| Human-in-the-loop escalation with response parsing (§2.7) | Requires notification channel + response infra | When Phase 2 confirms are triggered more than once per day |

---

## 5. Risk Assessment Matrix

Each recommendation from the gap analysis is assessed below with probability × impact scoring.

### P0 Recommendations

| Recommendation | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| **PermissionContext state machine** (P0) | Call history adds latency to hot path | Low (10–50μs per append, O(1) circular buffer) | Medium (cumulative overhead over 200 calls) | Benchmark before/after; use fixed-size `Uint32Array` for timestamps if microsecond-level overhead is observed |
| **PermissionContext state machine** (P0) | Memory leak from unbounded history | Low (fixed-size circular buffer, configurable) | Low (max ~10KB for 50 records) | Configurable `maxHistory`; tested in CI with max capacity |
| **Three-tier decision model** (P0) | `"confirm"` decisions stall the pipeline waiting for resolution | Medium (depends on notification integration) | High (pipeline timeout) | Default `timeoutMs` set to 60s; timeout → auto-deny with log; degradation to read-only mode |
| **Three-tier decision model** (P0) | Tier configuration misclassification leads to unexpected denies | Medium | Medium | Strict defaulting: unknown tools map to auto-allow with warning; tier config must be explicit for each tool family |
| **Sequential constraints** (P0) | Read-before-write enforcement generates false warnings for legitimate workflows | Medium | Low (warnings, not denials) | Start in warn-only mode; collect data for 2 weeks before enabling hard enforcement |

### P1 Recommendations

| Recommendation | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| **PostToolUse output validation** (P1) | Content truncation removes legitimate context | Medium | Medium (silent data loss) | Only hard-truncate at `hardCap` (200KB); below that, append warning and pass full output |
| **PostToolUse output validation** (P1) | Secret masking generates false positives | High (common pattern like `sk_live_` prefix on test data) | Low (warn-only in Phase 3 initial release) | Use regex patterns with high precision; false positive rate tracked in metrics; grace period before enabling hard masking |
| **ToolBudget rate limiting** (P1) | Hard ceiling prematurely terminates legitimate executions | Medium | High (execution failure) | Phase 1: soft ceiling with warning only. Hard ceiling enabled only after 2 weeks of calibration data |
| **Escalation via notify** (P1) | Notification infrastructure dependency creates coupling risk | Low (existing `src/notify/sender.ts` is well-abstracted) | Medium | Escalation notifier is a pluggable interface; default is no-op (log-only); DingTalk sender is opt-in |

### P2 Recommendations

| Recommendation | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| **Mutable allowlist** (P2) | Runtime allowlist mutation creates security surface | Low (mutation gated by config, not by execution) | High (incorrect allowlist entry allows dangerous commands) | All mutations require `Config` update + validation; runtime mutation is append-only in first iteration |
| **Tool composition analysis** (P2) | Cross-call tracking is inherently fragile — LLM may restructure tool usage patterns | Medium | Medium | Rules are heuristic, not deterministic; violations produce warnings, not denials |

### Cross-Cutting Risks

| Risk | Phases Affected | Mitigation |
|---|---|---|
| **SDK hook API instability**: The `hooks` parameter in `runSdkQuery` may not support `PostToolUse` or `"confirm"` decision values | P2, P3 | Abstraction layer: wrap SDK `query` in `src/sdk.ts` with a shim that transforms our permission model into whatever the SDK supports. Fallback: if `PostToolUse` is unsupported, implement output validation as a post-processing step on the `toolTrace` |
| **Notification dependency**: `src/notify/sender.ts` may not support structured action requests | P2 | Extend `sender.ts` with an `escalate()` method that returns a promise resolving to the human's decision. If sender is unconfigured, fall back to auto-deny with a log warning |
| **False positive accumulation**: Multiple warn-only validators create noise without action | P3 | After 10 warnings, escalate to a structured summary in the pipeline output (not per-call noise). Warnings are aggregated, not spammed |
| **Phase scope creep**: "Just one more rule" during Phase 1 | P1 | Hard scope boundary: Phase 1 adds exactly 3 context-aware rules (consecutive denial backoff, read-before-write, repetitive command detection). Any additional rules are logged to a `FUTURE_RULES.md` file and deferred to Phase 2+ |

---

## 6. Decision Log & Open Questions

| # | Question | Options | Recommended | Rationale |
|---|---|---|---|---|
| D1 | Should Phase 1's read-before-write rule deny or warn? | (a) Deny, (b) Warn, (c) Configurable | (b) Warn | Aligns with §2.1's usability bias; strict enforcement would break existing workflows where agent writes without reading (e.g., creating a new file) |
| D2 | Should Phase 2's `"confirm"` decision require notification infra? | (a) Yes — notify required, (b) No — notify optional, fallback to auto-allow | (b) Notify optional | Prevents Phase 2 from being blocked by notification dependency. Without notifier, `"confirm"` downgrades to `"allow"` with a log entry |
| D3 | What is the default TierConfig for Phase 2? | (a) All-allow (no behavioral change), (b) Selective confirm for Bash | (a) All-allow | Zero behavioral change on deployment. Tier config is opt-in — teams can enable confirm tiers after observing call patterns |
| D4 | Should PostToolUse (Phase 3) be a separate file or extend permission.ts? | (a) Separate file, (b) Extend permission.ts | (a) Separate file | Separation of concerns: permission.ts handles pre-call decisions; output-validator.ts handles post-call results. They share the PermissionContext interface but have independent evolution paths |
| D5 | Should the ToolBudget operate per-execution or globally? | (a) Per-execution (reset each plan), (b) Global (persisted across executions) | (a) Per-execution | Simpler implementation (in-memory, no SQLite). Global budget adds complexity of cross-execution state management without clear current benefit |

---

## 7. References

1. **Fable guardrail gap analysis**: `docs/fable-guardrail-gap-analysis.md` (PR #159, commit `997771e`) — Full 10-dimension gap matrix against Fable-class tool-calling guardrail patterns
2. **Permission hook implementation**: `src/execution/permission.ts` — Current `buildPreToolHook` with Bash gate + filesystem gate
3. **Executor integration**: `src/executor.ts` (lines 280–360) — Where `buildPreToolHook` is instantiated and permission violations are handled
4. **SDK query layer**: `src/sdk.ts` — `runSdkQuery` with `hooks` parameter
5. **Tool trace logging**: `src/sdk-tool-log.ts` — Current tool-call recording (append-only text)
6. **Notification infrastructure**: `src/notify/sender.ts` — DingTalk and generic notification senders
7. **Pre-check rules**: `src/pre-check.ts` — 11 deterministic diff-validation rules (post-hoc, not real-time)
8. **Backpressure & cost control**: `src/executor.ts` — `deriveMaxTurns`, `scaleLimits`, `sdk-cost.ts` — Existing but partial budget enforcement
9. **Trade-off analysis framework**: Based on `design-tradeoff-principles.md` (synthesized from P7 architecture reviews)
10. **SDK hooks API**: `@anthropic-ai/claude-agent-sdk` `query()` function — `PreToolUse` hook support; `PostToolUse` support TBD

---

*Proposal generated by P7 executor. Design decisions based on Fable gap analysis (PR #159) and cross-referenced against current permission.ts implementation at base commit `2a0ae20`. All phase estimates assume existing test infrastructure; test creation is included in line estimates.*
