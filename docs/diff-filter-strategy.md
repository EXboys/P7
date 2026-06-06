# Diff Slice Pre-Filter Strategy

> **Status**: Draft — design proposal
> **Date**: 2026-06-06
> **Scope**: Token waste reduction for diff review across both evaluator paths (Gemma + diff-critic)

---

## 1. Problem Analysis

### Token Waste Profile (from audit)

Based on the token consumption audit in `docs/PIPELINE.md` and spot-checks of recent diff reviews, the current approach sends **entire `git diff` output** to the evaluator (Gemma: plain-text diff via `formatDiffSlice`; diff-critic: file-by-file via `Read` tool). This includes substantial low-information content:

| Waste Category | Estimated % of diff tokens | Typical sources |
|---|---|---|
| Format noise | 15–25% | Whitespace-only hunks, import reordering, trailing comma changes, line-ending normalization |
| Comment-only hunks | 5–12% | Copyright header bumps, inline comment rewording, docstring formatting, TODO cleanup |
| Boilerplate / generated | 10–30% | `package-lock.json`, `yarn.lock`, generated protobuf stubs, compiler output, vendor/ dirs |
| **Total addressable** | **30–67%** | Cumulative across categories (overlap varies per diff) |

A reduction of even 30% in diff review tokens directly translates to:
- Lower latency (shorter prompt → faster inference)
- Reduced API cost (Gemma local: shorter context; Claude: fewer input tokens billed)
- Better signal-to-noise ratio for the reviewer (less distraction)

### Current Paths

**Gemma path** (`formatDiffSlice` in pipeline):
```
git diff stat → formatDiffSlice(diffStat) → GemmaLocalClient.generate
```
- Sends raw `diffStat` string (full unified diff) as the prompt body
- No pre-processing before injection

**Claude / diff-critic path** (`reviewDiff`):
```
setupFiles → reviewDiff(filePath, diffStat) → DiffCriticFinding[]
```
- Reads files via the `Read` tool for each changed file
- The `Read` tool itself truncates large files, but still reads low-information sections (comment-heavy blocks, boilerplate)

---

## 2. Filter Taxonomy: Three Categories

### 2.1 Format Noise

**Definition**: Changes that alter only the syntactic formatting of code without affecting semantics.

**Line-level heuristics**:
- Whitespace-only line diffs (`^[+-]\s*$`)
- Lines differing only in indentation (tab→space, re-indent within parent block)
- Import/require reordering (hunk where all additions/removals are `import` statements with no other changes)
- Trailing comma addition/removal in object/array literals
- Line-ending normalization (`\r\n` → `\n`)

**Hunk-level heuristics**:
- Hunk where every changed line matches a format-only pattern above
- Large-scale reformatting hunks (>50 lines, >90% are indent-only or semicolon-only)
- Auto-fix hunks from linters (prettier, eslint --fix, gofmt, rustfmt, black)

**Risk**: Import reordering can mask actual dependency changes (e.g., adding a new import alongside reordering). Only flag hunks that are **100%** import-line changes when the import lines are merely reordered without net additions.

### 2.2 Comment-Only Changes

**Definition**: Hunks whose entire delta consists of comment lines (no executable code changes).

**Line-level heuristics**:
- Diff lines matching comment syntax for the detected language:
  - TypeScript/JavaScript: `^\s*//` or `^\s*\*` or `^\s*/\*`
  - Python: `^\s*#`
  - Go: `^\s*//`
  - Rust: `^\s*//` or `^\s*///`
  - Generic: `^\s*<!--`
- Blank lines *within* a comment block are allowed (contiguous comment context)

**Hunk-level heuristics**:
- All addition/removal lines in the hunk are comment lines (or blank lines in comment context)
- Exception: hunks where the comment documents a real API change visible in adjacent code context should NOT be filtered (see risk below)

**Risk**: Comment-only hunks may contain:
- API contract clarifications ("`param` now accepts negative values")
- Deprecation notices
- Security-relevant documentation

**Guardrail**: Do NOT apply `strip_comment_only` to hunks that match any of these patterns:
- Contains "NOTE:", "WARNING:", "DEPRECATED", "SECURITY", "BREAKING" keywords
- Is in a public API surface file (detected by presence of `export`, `pub fn`, `pub struct` in surrounding context)

### 2.3 Boilerplate / Generated Code

**Definition**: Files or hunks that are auto-generated, vendored, or mechanically produced with minimal human-review value.

**File-level heuristics**:
- Lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`
- Generated code markers: first line contains `@generated`, `auto-generated`, `DO NOT EDIT`, `This file is auto-generated`
- Compiled output: `*.min.js`, `*.bundle.js`, `*.generated.ts`, `*_pb.js`, `*_pb.ts` (protobuf)
- Vendor directories: `vendor/`, `third_party/`, `.gen/`

**Hunk-level heuristics**:
- Configuration template noise: version bumps in `.tool-versions`, `.nvmrc`, `.ruby-version`
- Dependency hash updates: lines matching `"integrity":`, `sha256-` patterns
- CI config boilerplate: `steps:` YAML blocks that only change version tags

**Risk**: Some generated files contain semantically important changes (e.g., protobuf field renumbering). Lockfile changes can indicate transitive dependency vulnerabilities being fixed.

**Guardrail**: For lockfiles, apply a summary-only mode: replace the full diff with a single line `[lockfile] package-lock.json: +N/-M entries` rather than stripping entirely. For generated code, enforce a minimum threshold: only strip files where >90% of the lines are auto-generated markers.

---

## 3. Detection Approaches

### 3.1 Language-Aware Heuristics (Recommended for Phase 1)

Lightweight, no-AI pre-filter that operates on the raw diff text:

1. **Parse raw diff** into hunks (file header + per-file hunks)
2. **Classify per hunk** using regex-based heuristics
3. **Apply filter rules**: strip, summarize, or pass through based on category
4. **Reassemble** the filtered diff

**Complexity**: Low (pure string processing, no external dependencies)
**Accuracy**: Medium (language-specific patterns needed for comment detection)
**Performance**: Negligible overhead (<10ms for typical diffs)

### 3.2 AI-Assisted Classification (Phase 2)

For edge cases where heuristics cannot decide, delegate to a fast local model call:

- "Is this hunk semantically meaningful?" — yes/no with confidence
- Only invoked when hunk confidence from heuristics is below threshold (<0.7)
- Budget: max 5% of evaluation budget (to avoid paradoxical token waste)

### 3.3 Recommendation

**Phase 1 (this workstream):** Implement language-aware heuristics only. Use regex-based detection for all three categories. This covers 80%+ of addressable waste with minimal complexity.

**Phase 2 (future):** Add optional AI-assisted classification for ambiguous hunks, tuned on false-positive data collected from Phase 1 operation.

---

## 4. Integration Points

### 4.1 Gemma Path Integration

Insert the filter **between diff extraction and `formatDiffSlice`**:

```
git diff stat → filterDiff(diffStat, config) → formatDiffSlice(filteredDiff) → GemmaLocalClient.generate
```

Implementation: A `filterDiff(diffContent, config)` call in the pipeline step before `formatDiffSlice`. The filtered `diffContent` is then formatted as usual. No changes needed to the formatter or the Gemma client.

**File location**: `src/diff-filter.ts` — new module called from the pipeline orchestration.

### 4.2 Claude / diff-critic Path Integration

The Claude path reads files via the `Read` tool for each changed file. Since the tool reads whole files, the filter operates differently:

1. **Per-file diff pre-analysis**: Run `filterDiff` on the diff output to identify which hunks are low-information per file
2. **Read guidance**: Pass a hint to the critic prompt listing "low-information sections" per file, so the critic can skip or skim them
3. **Alternative**: Filter out entire files from the review set when >90% of their diff is boilerplate (with configurable opt-out)

**File location**: Same `src/diff-filter.ts` — exports a `classifyDiffHunks(diffContent)` function that returns per-file hunk annotations consumable by the critic prompt builder.

### 4.3 Config Integration

Filter behaviour is controlled via the `diff_filter` sub-object of `diff_critic` in `config.json`:

```typescript
diff_critic: {
  // ... existing fields ...
  diff_filter: {
    enabled: true,
    strip_format_noise: true,
    strip_comment_only: true,
    strip_boilerplate: true,
    max_hunk_lines: 200,
  }
}
```

---

## 5. Configuration Schema

```typescript
interface DiffFilterConfig {
  /** Master switch. Set false to bypass all filtering for debugging. */
  enabled: boolean;
  /** Strip whitespace-only / formatting-only hunks. */
  strip_format_noise: boolean;
  /** Strip hunks whose delta is 100% comment lines. */
  strip_comment_only: boolean;
  /** Strip or summarize boilerplate / generated files. */
  strip_boilerplate: boolean;
  /**
   * Maximum hunk length in lines. Hunks exceeding this are truncated
   * to a summary: `[+N/-M lines truncated]`. 0 = no truncation.
   * Default 200.
   */
  max_hunk_lines: number;
}
```

### Default Values

| Field | Default | Rationale |
|---|---|---|
| `enabled` | `true` | Filtering should be on by default to realise savings immediately |
| `strip_format_noise` | `true` | Format noise has near-zero semantic value; false-positive risk is low |
| `strip_comment_only` | `true` | High savings; guardrails catch critical doc changes |
| `strip_boilerplate` | `true` | Biggest single source of waste; file-level heuristics catch >95% |
| `max_hunk_lines` | `200` | Typical good hunk is <50 lines; 200 gives generous headroom |

---

## 6. Expected Token Reduction Estimates

| Category | Savings per diff-scenario | Conservatism factor |
|---|---|---|
| **Format noise** | 8–15% | Direct savings; false positives re-add <1% |
| **Comment-only** | 3–8% | Guardrails reduce coverage; depends on codebase commenting culture |
| **Boilerplate** | 10–25% | Largest variance; lockfile-dependent projects (Node.js, Rust) benefit most |
| **Hunk truncation** (max_hunk_lines) | 2–5% | Only triggers on unusually large hunks (>200 lines); rare in practice |
| **Total estimated** | **20–40%** | Non-additive due to category overlap; actual savings require measurement |

> **Note**: These estimates are based on spot-checks and general knowledge of typical diffs. Post-implementation measurement is required to calibrate.

---

## 7. Quality Risk Assessment

### False Positive Rates (estimated)

| Category | FP rate (estimated) | Impact |
|---|---|---|
| Format noise | <1% | Import reordering that hides real changes |
| Comment-only | 3–5% | API doc changes, deprecation notices in comment blocks |
| Boilerplate | <2% | Lockfile changes that fix security vulnerabilities |

### Degradation Guardrails

1. **Per-hunk annotation**: Stripped hunks are logged with reason and category for post-hoc audit
2. **A/B comparison mode**: Config option to run both filtered and unfiltered in parallel, recording verdict divergence without affecting behaviour
3. **Kill switch**: `diff_filter.enabled: false` to bypass entirely if degradation is suspected
4. **Gradual rollout**: Phase 1 ships with `enabled: true` by default but logs all filtered hunks; Phase 2 enables actual stripping after confidence is validated

### Verdict Quality Monitoring

Compare these metrics before and after filter activation:

| Metric | Degradation signal |
|---|---|
| Finding count per review | >20% drop → likely false negatives |
| False positive rate (hallucination fixtures) | >5pp increase → filter stripping signal |
| Average review score | >0.5σ shift → degradation |
| User report rate | Any increase in "missed findings" reports |

---

## 8. Validation Approach

### A/B Comparison on Historical Diffs

1. Collect 50–100 recent diffs from the repository (mix of feature work, refactors, lockfile bumps)
2. Run the review pipeline **without** filtering → record findings
3. Run the review pipeline **with** filtering → record findings
4. Compare:
   - Finding set overlap (did we miss anything?)
   - Token counts (how much did we save?)
   - Processing time (faster?)
5. Publish results as a comparative evaluation report (see `docs/gemma-vs-diff-critic-comparison.md` for precedent)

### Automated Tests

- **Unit tests** for each heuristic category:
  - Known format-only hunks are correctly identified
  - Known comment-only hunks are correctly identified
  - Known boilerplate files are correctly identified
  - Mixed hunks (comments + code) are NOT classified as comment-only
- **Fixture-based integration tests**:
  - 10+ fixture diffs with expected filter outcomes
  - Test that guardrails work (e.g., keyword "WARNING" in comment prevents stripping)
- **Regression tests**:
  - Filter + review pipeline on hallucination fixtures → no degradation in finding quality

---

## 9. Future Work (Phase 2)

- **AI-assisted classifier** for ambiguous hunks (invoke Gemma on single-hunk sub-prompts)
- **Per-developer filter calibration** (learn which comment patterns are routinely meaningful for each contributor)
- **Filter feedback loop**: track user-flagged "missed finding in filtered hunk" → auto-adjust heuristics
- **Cross-hunk context preservation**: when filtering a hunk that references symbols introduced elsewhere, preserve a stub annotation
