# LoC Critique Analysis: 3 Fundamental Flaws as a Quality Proxy

> **Source**: David Curlewis, *Lines of Code Got a Better Publicist* (curlewis.co.nz, 2026-06-10) — HN #48489402, score 152
> **Analysis date**: 2026-06-11
> **Target**: P7 diff-critic multi-dimensional quality evaluation framework — replacing single-dimension LoC contribution assessment
> **Status**: Core arguments extracted and mapped to P7 quality dimensions

---

## 1. Overview

David Curlewis critiques the resurgence of LoC (Lines of Code) as a proxy for engineering productivity in the AI era. Companies like Google ("75% of new code is AI-generated") and Anthropic ("~80% of merged production code is written by Claude") have repackaged LoC as "AI-generated code percentage" — a vanity metric that inherits all of LoC's fundamental flaws.

> *"Percent of code written by AI is just lines of code with a better publicist."*

This note extracts the article's **3 fundamental flaws** of LoC as a quality proxy, maps each to P7's diff-critic framework, and identifies implications for replacing single-dimension LoC assessment with multi-dimensional quality evaluation.

---

## 2. Fundamental Flaw 1: Conflating Quantity with Quality (Semantic Emptiness)

**Core thesis**: A volume number cannot distinguish between "good changes" and "bad changes." LoC growth is orthogonal to system health (reliability, security, maintainability).

**Evidence cited in the article**:

| Study | Finding | LoC Implication |
|-------|---------|-----------------|
| GitClear (2025) | Code churn rising, refactoring collapsing | High LoC with quality degradation |
| METR (Jul 2025) | Experienced developers 19% *slower* with AI | LoC growth may reflect low-quality bloat |
| Anthropic RCT (2026) | Code comprehension 17% lower with AI | High output ≠ high understanding |
| NBER executive survey | ~90% of AI-adopting firms have no impact measurement | LoC fills the measurement vacuum |

**Implication for P7**: diff-critic currently evaluates diff quality via 6 dimensions but lacks a **semantic density** metric — the ratio of meaningful logic lines to boilerplate/formatting. A diff that passes type checks and tests can still be semantically empty.

---

## 3. Fundamental Flaw 2: Incentivizing Gaming Behavior (Perverse Incentives)

**Core thesis**: LoC metrics not only fail to measure quality — they *actively incentivize* counterproductive behavior:

- Writing verbose code instead of concise implementations
- Avoiding dead code deletion (reduces LoC)
- De-prioritizing refactoring (compresses code, lowers net line output)
- Chasing PR quantity over PR quality

**Real-world harm**: The article traces how vanity metrics drive real budget decisions and layoffs:

| Case | LoC Variant | Outcome |
|------|-------------|---------|
| Block (Jack Dorsey) | "AI made teams more efficient" (LoC-based inference) | 40%+ layoffs (4,000 people) |
| Atlassian | "AI changing skill mix requirements" | 10% layoffs (~1,600 people) |

> *"When a company says 'AI made everyone more productive, so we need fewer people', I want to see the evidence — and I don't believe it exists today."*

**Implication for P7**: diff-critic's rating system must avoid embedding LoC incentives. Required safeguards:

- Positive scoring for deletion/refactoring (removing redundancy)
- Recognition of high-impact minimal diffs
- Detection of code bloat as a negative signal
- Explicit rewarding of maintainability improvements over raw line count

---

## 4. Fundamental Flaw 3: Ignoring Structural Properties (Context Insensitivity)

**Core thesis**: LoC is an absolute number completely detached from the code's purpose, business context, and technical environment. The same 100 lines have radically different meaning depending on context:

| Context | +100 lines | -100 lines | ±100 lines |
|---------|-----------|-----------|-----------|
| New feature | Reasonable | Suspicious | Possible bug |
| Refactoring | Suspicious | Positive (cleanup) | Neutral |
| Bug fix | Needs review | Likely correct | Review each |
| Dead code removal | Negative | Positive | N/A |

**Evidence of context dependence**: The article shows how the same metric (LoC/AI-generation rate) is simultaneously cited as positive, negative, and neutral evidence from the same research community in the same period — because the metric itself is context-agnostic.

The article further exposes "AI maturity models" as LoC in disguise — measuring adoption intensity and calling it maturity:

> *"Every tools vendor now ships a maturity ladder whose top rung is, usually, 'use more of our product'. These ladders measure adoption intensity and call it maturity. Same substitution, nicer packaging."*

**Implication for P7**: diff-critic must ensure:

- Each dimension's weight **adapts dynamically to context** (new module vs legacy refactor)
- Review results are bound to file **history context** (first introduction vs hot-region modifications)
- Cross-file change synergy (deletion in one file + addition in another = migration) is evaluated holistically, not per-file

---

## 5. Mapping to P7 diff-critic Quality Dimensions

| LoC Flaw | Missing P7 Dimension | Current Status |
|----------|---------------------|----------------|
| Semantic emptiness (§2) | **Semantic density** (meaningful logic / total lines) | ❌ Missing |
| Gaming incentives (§3) | **Bloat detection** & **refactoring positive signal** | ❌ Missing |
| Gaming incentives (§3) | **High-impact minimal diff recognition** | ❌ Missing |
| Context insensitivity (§4) | **Context-adaptive weighting** (new feature vs fix vs refactor) | ❌ Missing |
| Context insensitivity (§4) | **Cross-file synergy analysis** | ❌ Missing |
| Context insensitivity (§4) | **Historical context binding** (file hotness, change frequency) | ❌ Missing |

### 5.1 Three-Pillar Framework

```
                    ┌─────────────────────────────┐
                    │  P7 Multi-Dimensional        │
                    │  Quality Evaluation Framework │
                    └──────────┬──────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  Semantic     │  │  Incentive   │  │  Context-    │
    │  Density      │  │  Audit       │  │  Aware       │
    │               │  │              │  │  Weighting   │
    ├──────────────┤  ├──────────────┤  ├──────────────┤
    │ • Logic/     │  │ • Bloat      │  │ • File       │
    │   template   │  │   detection  │  │   hot-spot   │
    │   ratio      │  │ • Refactor   │  │   analysis   │
    │ • AST        │  │   reward     │  │ • Change     │
    │   semantic   │  │ • Delete>add │  │   type       │
    │   compression│  │   scoring    │  │   adaptive   │
    │ • Info-per-  │  │ • Small diff │  │   weighting  │
    │   line ratio │  │   high-impact│  │ • Cross-file │
    │              │  │   recognition│  │   synergy    │
    └──────────────┘  └──────────────┘  └──────────────┘
```

### 5.2 Near-term ROADMAP Candidates

1. **Semantic density metric**: For each diff file, compute `(semantic logic lines / total diff lines)`. Flag diffs below threshold (e.g. <0.4) as "low semantic density."

2. **Change type classification**: Identify change type (new feature / refactor / fix / delete-only) from diff patterns; route LoC signal through type-specific evaluation formulas.

3. **Small-diff high-impact detection**: Identify changes with few lines but high system impact (e.g. single-line change to core utility function) — apply positive scoring offset.

4. **Bloat/pattern duplication detection**: When new code heavily duplicates existing patterns in the same module (e.g. repeated error handling boilerplate), flag as "pattern bloat."

---

## 6. References

- Curlewis, D. (2026-06-10). *Lines of Code Got a Better Publicist*. https://curlewis.co.nz/posts/lines-of-code-got-a-better-publicist/
- HN Discussion #48489402 (2026-06-11). https://news.ycombinator.com/item?id=48489402
- GitClear (2025). *Coding on Copilot*. https://gitclear.com/coding_on_copilot
- METR (Jul 2025). https://metr.org/blog/2025-07-10
- METR (Feb 2026). *Uplift Update*. https://metr.org/blog/2026-02-24-uplift-update/
- Anthropic (2026). *AI Assistance & Coding Skills RCT*. https://anthropic.com/research/AI-assistance-coding-skills

### P7 Internal References

- `docs/loc-metric-critique-analysis.md` — Detailed analysis with full evidence tables and sectional breakdown
- `ROADMAP.md` — Active Feature: "LoC度量批判与代码质量维度拓展"
- `docs/diff-filter-strategy.md` — Diff Slice Pre-Filter Strategy
- `docs/burr-pattern-design-recommendations.md` — StateContext architecture for quality state tracking
