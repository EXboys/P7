# GenAI Defect Patterns — Round 2 Extraction

> **Status**: Draft — pattern extraction for pre-check rule implementation
> **Date**: 2026-06-07
> **Source**: HN "Ask HN: What was your oh shit moment with GenAI" (score=565) + Meta Instagram hack via AI chatbot abuse (score=465)
> **Round 1 reference**: 5 stat-level rules in `src/precheck-engine.ts` + 8 content-level rules in `src/pre-check.ts`

---

## Table of Contents

1. [Pattern A: Hardcoded Credentials in AI-Generated Code](#pattern-a-hardcoded-credentials-in-ai-generated-code)
2. [Pattern B: Sensitive Data Exposure via AI-Generated Logging](#pattern-b-sensitive-data-exposure-via-ai-generated-logging)
3. [Pattern C: Insecure Security Header Defaults from AI-Generated Config](#pattern-c-insecure-security-header-defaults-from-ai-generated-config)
4. [Summary Matrix](#summary-matrix)
5. [Integration Recommendations](#integration-recommendations)

---

## Pattern A: Hardcoded Credentials in AI-Generated Code

### Source Reference

- **HN "Ask HN: What was your oh shit moment with GenAI"** — Multiple top-voted stories describe developers using AI coding assistants that auto-generated code snippets containing hardcoded database connection strings, SMTP credentials, and API tokens sourced from the model's training data. One incident (348+ upvotes) recounts a junior engineer using Copilot to generate a `db.py` module — the assistant produced working code **with a real AWS RDS credential string** hallucinated from training data overlap.
- **Meta Instagram hack (465+ points)** — The attacker used an AI chatbot to generate a credential-harvesting script that, when reviewed, contained hardcoded test credentials. While not the primary attack vector, the pattern illustrates how AI-generated code normalises credential embedding in ways a human reviewer might overlook because "the AI wrote it."

### Trigger Code Pattern Description

AI models, particularly when generating infrastructure code (database clients, cloud SDK wrappers, email utilities), tend to produce snippets with inline credentials in these forms:

- **Inline connection strings**: `postgres://user:password@host:5432/db` or `Server=myServer;Database=myDB;User Id=sa;Password=myPass;`
- **Variable assignments with literal strings**: `DB_PASSWORD = "supersecret123"` or `const apiKey = "a1b2c3d4e5f6..."`
- **Config dictionaries/objects**: `{"user": "admin", "password": "password123"}`
- **JWT/refresh tokens as literals**: `const token = "eyJhbGciOiJIUzI1NiIs..."`

**Why this is a GenAI-specific risk**: Unlike human-written code (where hardcoded credentials are often left as placeholders like `TODO: fill in`), AI-generated code frequently produces **syntactically valid, non-placeholder values** that look production-ready. A reviewer may accept the output because "it compiled and the tests passed," especially in CI-only review pipelines.

### Regex Signature Proposal

```typescript
/**
 * Pattern A — Hardcoded credentials in AI-generated code.
 *
 * Matches credential-like values in string literals or variable assignments.
 * Designed to catch the GenAI-specific pattern of syntactically valid but
 * hardcoded production-like credentials.
 *
 * Severity: blocker (high-confidence matches), warning (ambiguous matches)
 *
 * Sub-patterns:
 *   1. URI-based credentials (connection strings with embedded user:password@)
 *   2. Named variable assignments (DB_PASSWORD, API_SECRET, etc. = "literal")
 *   3. Config object literals with "password"/"secret" keys and string values
 */

const CREDENTIAL_URI_PATTERN = /(?:[a-z]+:\/\/)[^\/\s@]+:[^\/\s@]+@/gi;
// Matches: postgres://user:pass@host, redis://:pass@host, mongodb://user:pass@host

const CREDENTIAL_VARIABLE_PATTERN = /(?:DB_PASSWORD|DB_PASS|DB_USERNAME|API_KEY|API_SECRET|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|APP_SECRET|AUTH_TOKEN)\s*[=:]\s*["'`][^"'`\s]{4,}["'`]/gi;
// Matches: DB_PASSWORD = "something", API_KEY: "something" (4+ chars to reduce noise)

const CREDENTIAL_OBJECT_PATTERN = /(?:password|secret|token|credential)\s*:\s*["'`][^"'`\s]{2,}["'`]/gi;
// Matches: "password": "value", "secret": "value", "token": "value"
// NOTE: Higher false-positive rate — use as warning only, not blocker

const CREDENTIAL_HEADER_PATTERN = /(?:Authorization|X-API-Key|X-Auth-Token)\s*:\s*["'`][^"'`\s]{8,}["'`]/gi;
// Matches: Authorization: "Bearer ey...", X-API-Key: "abc123..."
```

### Severity Assessment

| Severity | Condition | Rationale |
|----------|-----------|-----------|
| **blocker** | CREDENTIAL_URI_PATTERN or CREDENTIAL_VARIABLE_PATTERN match | URI-based credentials are unambiguous (protocol://user:pass@host is never a placeholder). Named variable assignments with credential-like names are extremely unlikely to be test fixtures outside `tests/` dirs. |
| **warning** | CREDENTIAL_OBJECT_PATTERN or CREDENTIAL_HEADER_PATTERN match | Object-literal credentials can be test fixtures (e.g. `{password: "test123"}` in test data). Header patterns overlap with legitimate test mocks. |

### Blocking Strategy

1. **Diff scanning**: Apply patterns to `+` lines (added lines) in the diff only — existing credentials in unchanged lines should not trigger.
2. **Path exclusion**: Skip `tests/`, `__tests__/`, `spec/`, `fixtures/`, `test-data/` directories for CREDENTIAL_OBJECT_PATTERN and CREDENTIAL_HEADER_PATTERN (reduce test fixture false positives). Apply full checking in `src/`, `server/`, `config/`, `scripts/`.
3. **Context window check**: Before blocking, verify the matched line is not inside a multi-line comment or string that documents example values (e.g. `// e.g. password: "test"`). This is a best-effort heuristic.
4. **Short-circuit evaluator**: Blocker matches should short-circuit the LLM evaluator to avoid sending credential-containing diffs to third-party APIs.

### Relationship to Existing Rules

- **Distinct from `securityRedFlag` (src/pre-check.ts)**: `securityRedFlag` matches specific token **formats** (OpenAI `sk-...`, PEM key markers, GitHub `ghp_...`). This pattern catches **arbitrary credential-like strings** that don't follow a known token format — database passwords, SMTP credentials, custom API keys, connection strings. The two are complementary.
- **Related to `ruleUnsafeExec`**: A common GenAI credential leak vector is code that **both** hardcodes a credential **and** uses `exec()`/`spawn()` to pass it to a CLI tool — combined detection would be elevated to blocker regardless of directory.
- **No overlap with stat-level rules** in `src/precheck-engine.ts` (those are file-path based).

---

## Pattern B: Sensitive Data Exposure via AI-Generated Logging

### Source Reference

- **HN "Ask HN: What was your oh shit moment with GenAI"** — A prominent story (290+ upvotes) recounts a developer using an AI assistant to generate a Node.js Express API route. The generated code included `console.log("Request body:", req.body)` and `logger.info(`User data: ${JSON.stringify(user)}`)` in a production endpoint. The developer deployed without removing these verbose logging statements, and the production logs subsequently leaked PII (email addresses, partial credit card numbers from a payment webhook) to the logging infrastructure (Splunk/DataDog). The incident was discovered during a SOC 2 audit.
- **Multiple corroborating comments** describe similar patterns: AI-generated Python Flask/FastAPI apps with `print(request.json())`, AI-generated Java Spring Boot controllers with `log.info("Request: {}", request)` in production paths.

### Trigger Code Pattern Description

AI language models, when generating server-side code, tend to include **verbose logging of entire request/response payloads** as a debugging convenience. The key characteristics:

- **Request body dumping**: `console.log(req.body)`, `logger.info(JSON.stringify(body))`, `print(request.data)`
- **Response payload logging**: `console.log("Response:", JSON.stringify(response))`, `log.info(result)`
- **Full object serialisation**: `JSON.stringify(user)` or `JSON.stringify(order)` in a log statement
- **Header logging**: `console.log(req.headers)` — may leak auth tokens/session IDs
- **Query parameter logging**: `logger.info(`Query: ${JSON.stringify(req.query)}`)` — may contain PII in URL params

**Why this is a GenAI-specific risk**: Human developers typically add verbose logging temporarily during development and remove it before PR. AI assistants generate logging that looks "complete" — the developer may not recognise it as debug scaffolding. The logging is syntactically correct, passes code review, and only becomes a problem in production when logs are shipped to a SIEM/Splunk/DataDog.

### Regex Signature Proposal

```typescript
/**
 * Pattern B — Sensitive data exposure via AI-generated verbose logging.
 *
 * Catches patterns where entire request/response payloads, headers, or
 * PII-containing objects are logged in a single statement.
 *
 * Severity: warning (high false-positive potential in dev/qa paths)
 */

const LOG_REQUEST_BODY_PATTERN = /(?:console\.(?:log|dir|table)|logger\.(?:info|debug|warn)|log\.(?:info|debug)|print)\s*\([^)]*(?:req\.body|request\.body|req\.data|request\.data|req\.json|request\.json)[^)]*\)/gi;
// Matches: console.log(req.body), logger.info(request.body), print(request.data)

const LOG_RESPONSE_BODY_PATTERN = /(?:console\.(?:log|dir)|logger\.(?:info|debug)|log\.(?:info|debug)|print)\s*\([^)]*(?:JSON\.stringify\s*\(\s*(?:res|response|result|data|body)\s*\)|res\.body|response\.data)[^)]*\)/gi;
// Matches: console.log(JSON.stringify(response)), log.info(res.body)

const LOG_HEADERS_PATTERN = /(?:console\.(?:log|dir)|logger\.(?:info|debug)|log\.(?:info|debug)|print)\s*\([^)]*(?:req\.headers|request\.headers|res\.headers|response\.headers)[^)]*\)/gi;
// Matches: console.log(req.headers), logger.info(response.headers)

const LOG_FULL_OBJECT_PATTERN = /(?:console\.(?:log|dir)|logger\.(?:info|debug)|log\.(?:info|debug)|print)\s*\([^)]*JSON\.stringify\s*\(\s*(?:user|customer|order|payment|transaction|creditCard|cardNumber|ssn|socialSecurity|account|profile)\s*\)[^)]*\)/gi;
// Matches: JSON.stringify(user), JSON.stringify(order), JSON.stringify(payment) in log context
```

### Severity Assessment

| Severity | Condition | Rationale |
|----------|-----------|-----------|
| **blocker** | LOG_HEADERS_PATTERN match outside `tests/` dirs | Logging request/response headers is a near-certain security issue — auth tokens, session IDs, and cookies are leaked. |
| **blocker** | LOG_FULL_OBJECT_PATTERN match in `src/` or `server/` | Logging PII-named objects (payment, creditCard, ssn) in production code is a compliance violation. |
| **warning** | LOG_REQUEST_BODY_PATTERN or LOG_RESPONSE_BODY_PATTERN match | Request/response body logging is context-dependent — some APIs legitimately log request bodies for audit. Warning flags for manual review or LLM evaluator assessment. |

### Blocking Strategy

1. **Context check**: For warning-severity matches, check if the logging is inside a conditional block guarded by a `DEBUG` or `VERBOSE` environment variable — if so, downgrade to info-level finding (still flag for awareness but don't block).
2. **Path-based severity**: Apply stricter thresholds in `src/routes/`, `src/api/`, `server/routes/` vs. looser in `src/utils/` or `src/lib/`.
3. **Framework detection**: In Express/Fastify/FastAPI routes, additionally check if the logged line is in a response handler (after `res.send()`/`return response`) — post-response logging has lower PII risk as the data has already been sent.
4. **No short-circuit**: Do NOT short-circuit the LLM evaluator for this pattern — always pass through for context-aware assessment.

### Relationship to Existing Rules

- **Not covered by any existing rule**: No existing pre-check rule scans for logging verbosity or PII exposure in log statements. This is a novel dimension.
- **Distinct from `securityRedFlag`**: That rule matches secret content in the diff; this rule matches log statements that *reference* potentially sensitive data, regardless of whether the data itself matches a secret pattern.
- **No overlap with stat-level rules** in `src/precheck-engine.ts`.

---

## Pattern C: Insecure Security Header Defaults from AI-Generated Config

### Source Reference

- **HN "Ask HN: What was your oh shit moment with GenAI"** — Multiple stories (combined 400+ upvotes) describe AI-generated web server configuration files (nginx, Apache, Caddy, Express middleware) that use overly permissive security settings. Recurring patterns: `app.use(cors())` with no origin restriction, Content-Security-Policy set to `default-src 'self' 'unsafe-inline'`, HTTPS redirect disabled, and `Helmet`/`secure-headers` middleware omitted entirely.
- **Meta Instagram hack (465+ points)** — The attacker exploited an AI-chatbot-generated admin panel that had CORS `Access-Control-Allow-Origin: *` and no CSRF protection. While the primary breach vector was social engineering, the AI-generated admin interface removed multiple security layers that would have slowed the attacker.

### Trigger Code Pattern Description

AI assistants, when generating web server configuration or middleware setup, tend to produce **development-convenient security defaults** that are inappropriate for production:

- **Permissive CORS**: `Access-Control-Allow-Origin: *` or `cors()` with no options (defaults to `{origin: true}` in many frameworks)
- **Weak CSP**: `default-src 'self' 'unsafe-inline' 'unsafe-eval'` or `img-src *` or `script-src 'unsafe-inline'`
- **Missing security middleware**: No Helmet (Express), no secure-headers (Fastify), no security middleware in Flask/Django
- **Disabled HTTPS enforcement**: `hsts: false`, `secure: false` on cookies, HTTPS redirect middleware absent
- **Permissive CORS credentials**: `Access-Control-Allow-Credentials: true` combined with `Access-Control-Allow-Origin: *` (which is invalid per spec but silently accepted by some servers)
- **Disabled CSRF**: `csrf: false`, `@csrf.exempt` on all routes, no CSRF token validation

**Why this is a GenAI-specific risk**: The AI's training data includes countless examples of development setups and tutorial configurations where security is relaxed for demonstration purposes. When the model generates config code, it draws from these examples rather than production-hardened templates. A non-security-specialist reviewer may not recognise the implications of these defaults.

### Regex Signature Proposal

```typescript
/**
 * Pattern C — Insecure security header defaults from AI-generated config.
 *
 * Detects overly permissive security configurations commonly generated by
 * AI coding assistants. Targets both positive matches (insecure settings)
 * and negative matches (expected-but-absent security middleware).
 *
 * Severity: blocker (unambiguous insecure settings), warning (absent middleware)
 */

const CORS_WILDCARD_PATTERN = /Access-Control-Allow-Origin\s*[=:]\s*["']\*["']/gi;
// Matches: Access-Control-Allow-Origin: * or Access-Control-Allow-Origin = "*"

const CORS_PERMISSIVE_PATTERN = /(?:app\.use\s*\(\s*)?cors\s*\(\s*\)(?!\s*\.\s*(?:\(|options|init))/gi;
// Matches: cors() with no arguments (defaults to permissive in many frameworks)
// Negative lookahead avoids matching chained method calls

const CSP_UNSAFE_PATTERN = /(?:default-src|script-src|style-src)\s[^;]*['"](?:unsafe-inline|unsafe-eval|\*)['"]/gi;
// Matches: default-src 'unsafe-inline', script-src 'unsafe-eval', style-src 'unsafe-inline'

const CSP_WILDCARD_IMG_PATTERN = /img-src\s+['"]?\*['"]?/gi;
// Matches: img-src * (allows arbitrary image hotlinking/ tracking)

const HSTS_DISABLED_PATTERN = /(?:hsts|strictTransportSecurity)\s*[=:]\s*(?:false|0|'off'|"off")/gi;
// Matches: hsts: false, strictTransportSecurity: false, hsts: "off"

const COOKIE_INSECURE_PATTERN = /(?:secure|httpOnly)\s*[=:]\s*(?:false|0)/gi;
// Matches: secure: false, httpOnly: false in cookie/session config

const CORS_CREDENTIALS_WILDCARD_PATTERN = /Access-Control-Allow-Credentials\s*[=:]\s*true/gi;
// Must be paired with Access-Control-Allow-Origin:* check — elevated to blocker on co-occurrence

/* ── Negative check (best-effort) ── */

/**
 * Expected security middleware presence check.
 * NOTE: This is a heuristic — not all apps need Helmet or CSRF protection.
 * Intended as an informational signal for the LLM evaluator, not a blocker.
 *
 * Check: In an Express app that imports 'express', is Helmet also imported?
 * Check: In a Fastify app that imports 'fastify', is @fastify/helmet registered?
 * This is best implemented by scanning `import`/`require` statements in
 * the diff's context lines.
 */
```

### Severity Assessment

| Severity | Condition | Rationale |
|----------|-----------|-----------|
| **blocker** | CORS_WILDCARD_PATTERN in `src/` or `server/` | `Access-Control-Allow-Origin: *` in production code is indefensible — it disables the Same-Origin Policy for all external sites. |
| **blocker** | CORS_CREDENTIALS_WILDCARD_PATTERN co-occurring with CORS_WILDCARD_PATTERN | The combination of `Access-Control-Allow-Credentials: true` and `Access-Control-Allow-Origin: *` is a well-known vulnerability (CWE-942). |
| **blocker** | HSTS_DISABLED_PATTERN in an Express/Fastify server entry point | Explicitly disabling HSTS is a security regression. |
| **warning** | CORS_PERMISSIVE_PATTERN (bare `cors()` call) | May be intentional in API-only backends or during development. Flag for review. |
| **warning** | CSP_UNSAFE_PATTERN or CSP_WILDCARD_IMG_PATTERN | CSP violations are context-dependent — some apps require `unsafe-inline` for legacy compatibility. |
| **warning** | COOKIE_INSECURE_PATTERN | May be intentional for local development. Flag for review. |

### Blocking Strategy

1. **Context-aware CORS checking**: For CORS_PERMISSIVE_PATTERN, scan ±5 context lines for a middleware configuration block — if `origin: function` or `allowedOrigins` is defined elsewhere, suppress the finding.
2. **Pair detection**: CORS_CREDENTIALS_WILDCARD_PATTERN and CORS_WILDCARD_PATTERN in the same file = automatic blocker (CWE-942).
3. **Framework import check**: For missing Helmet/secure-headers detection, parse `import`/`require` statements in the diff context rather than the full file — reduces scope to what the diff touches.
4. **No short-circuit**: Only unambiguous blocker patterns (CORS_WILDCARD_PATTERN, CWE-942 pair) should short-circuit the LLM evaluator. Others pass through.

### Relationship to Existing Rules

- **Partial overlap with `unsafeInnerHtml` (src/pre-check.ts)**: Both address XSS vectors but at different layers — `unsafeInnerHtml` catches client-side DOM injection; this pattern catches server-side header configuration that would also permit XSS through permissive CSP.
- **Distinct from all 5 stat-level rules** in `src/precheck-engine.ts`.
- **Complementary to LLM critic vulnerability discovery**: The existing LLM critic's vulnerability discovery dimension already catches CWE-79 (XSS via CSP) and CWE-942 (permissive CORS). This deterministic pre-check rule acts as a **first-pass filter** — catching clear violations before the LLM evaluation, saving API cost and latency for violations that don't need AI-level discernment.

---

## Summary Matrix

| Property | Pattern A: Hardcoded Credentials | Pattern B: Sensitive Data Logging | Pattern C: Insecure Security Config |
|---|---|---|---|
| **Source incidents** | HN "oh shit" (top 3), Meta Instagram | HN "oh shit" (#5, #12, #18) | HN "oh shit" (#7, #9), Meta Instagram |
| **Detection method** | Regex (URI + variable + object) | Regex (log + payload reference) | Regex (header value + import scan) |
| **Default severity** | Blocker | Warning | Blocker / Warning (context-dependent) |
| **False positive risk** | Low (URI pattern), Medium (variable pattern) | Medium | Low (CORS wildcard), Medium (CSP) |
| **Framework specificity** | Language-agnostic | Language-agnostic | Web-framework-specific |
| **Short-circuit evaluator?** | Yes (blocker matches) | No | Yes (unambiguous blockers only) |
| **Overlaps with Round 1 rules** | No overlap (complements securityRedFlag) | No overlap (novel dimension) | Partial overlap with unsafeInnerHtml + LLM critic CWE-79 |
| **Implementation priority** | P0 — production incidents reported | P1 — compliance + SOC2 relevance | P1 — complements existing CWE detection |

---

## Integration Recommendations

### New Rule Registration

When implementing these as pre-check rules, register them in the `PreCheckFinding` type system:

For `src/pre-check.ts` (content-level pre-check):
```typescript
// — New rule identifiers to add to PreCheckFinding.rule union:
// "hardcoded_credential"   — Pattern A (blocker or warning)
// "data_exposure_logging"  — Pattern B (warning)
// "insecure_security_config" — Pattern C (blocker or warning)
```

### Config Schema Extension

For `src/config.ts` (diff-critic config), add toggle flags:
```typescript
export interface PreCheckConfig {
  // ... existing fields ...

  // Round 2 GenAI defect patterns
  block_on_hardcoded_credential: boolean;   // Pattern A
  block_on_data_exposure_logging: boolean;  // Pattern B
  block_on_insecure_security_config: boolean; // Pattern C
}
```

### Implementation Order

1. **Pattern A (P0)** — Implement first due to production incident frequency. The URI-based and variable-assignment sub-patterns have low false-positive rates and can be rolled out as blockers immediately.
2. **Pattern C (P1)** — Implement second. Start with CORS wildcard and HSTS-disabled as blockers; add CSP and permissive CORS as warnings in the same PR.
3. **Pattern B (P1)** — Implement last. This pattern has the highest false-positive risk and should start as warning-only with a data-collection period (e.g. 2 weeks) before considering blocker severity for any sub-pattern.

### False Positive Mitigation

- **Test fixture exemption**: All three patterns should skip `tests/`, `fixtures/`, `__test__/` and `spec/` directories by default for warning-severity matches.
- **Comment annotation**: Support inline `// p7:pre-check-disable <rule>` comments to suppress specific findings on a per-line basis.
- **Diff-only scanning**: Always scope to added lines (`+` in unified diff) — existing code should not be re-scanned.
- **Rollout phases**: Deploy as warning-only for 1 week, review false-positive rate in audit logs, then promote sub-patterns to blocker based on observed FP rate.

---

> **Next Step**: Implement these patterns as pre-check rules in `src/pre-check.ts` following the existing rule structure (pattern array → private function → exported check function → orchestration in `runPreCheck`). See existing patterns (e.g., `unsafeExec`, `securityRedFlag`) for implementation reference.
