import { describe, expect, test } from "bun:test";
import {
  hardcodedCredential,
  dataExposureLogging,
  insecureSecurityConfig,
  runPreCheck,
  type PreCheckConfig,
} from "../src/pre-check.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Pattern A — Hardcoded credentials
 * ──────────────────────────────────────────────────────────────────────────── */

describe("hardcodedCredential", () => {
  /* ── Positive fixtures ── */

  test("detects URI connection string with embedded credentials", () => {
    const diff = `
+const db = new Sequelize("postgresql://admin:supersecret@prod-db.internal:5432/mydb");
+const redis = new Redis("redis://user:password@cache-cluster:6379");
`;
    const findings = hardcodedCredential(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].severity).toBe("blocker");
    expect(findings[0].rule).toBe("hardcoded_credential");
  });

  test("detects credential-named variable assignment with string literal", () => {
    const diff = `
+const apiKey = "sk-proj-abc123def456ghijklmn";
+let secret = "my-very-secret-token-12345";
+const authToken = "Bearer eyJhbGciOiJIUzI1NiJ9.xxx";
+const accessToken = "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
+const apiSecret = "super.secret.value@123";
`;
    const findings = hardcodedCredential(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const ruleFindings = findings.filter((f) => f.rule === "hardcoded_credential");
    expect(ruleFindings.length).toBeGreaterThanOrEqual(1);
  });

  test("detects object-literal credential keys", () => {
    const diff = `
+const config = {
+  password: "hunter2",
+  apiKey: "sk-1234567890abcdef",
+  token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
+  secret: "my-secret-value",
+};
`;
    const findings = hardcodedCredential(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("detects hardcoded credential in HTTP header value", () => {
    const diff = `
+const headers = {
+  "Authorization": "Bearer sk-proj-abcdefghij1234567890",
+  "x-api-key": "my-api-key-value-12345",
+};
`;
    const findings = hardcodedCredential(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  /* ── Negative fixtures ── */

  test("ignores safe variable names (example, test, placeholder, dummy)", () => {
    const diff = `
+const example = "test-value";
+const testApiKey = "test_api_key_value";
+const placeholder = "placeholder";
+const dummySecret = "not-a-real-secret";
+const sampleToken = "sample";
`;
    const findings = hardcodedCredential(diff);
    expect(findings.length).toBe(0);
  });

  test("ignores non-credential URIs without embedded credentials", () => {
    const diff = `
+const url = "https://api.example.com/v1/endpoint";
+const mongo = "mongodb+srv://localhost:27017/mydb";
`;
    const findings = hardcodedCredential(diff);
    expect(findings.length).toBe(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Pattern B — Sensitive data exposure via verbose logging
 * ──────────────────────────────────────────────────────────────────────────── */

describe("dataExposureLogging", () => {
  /* ── Positive fixtures ── */

  test("detects logging of req.body", () => {
    const diff = `
+app.post("/api/register", (req, res) => {
+  console.log("Registration request body:", req.body);
+  logger.info(req.body);
+});
`;
    const findings = dataExposureLogging(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].rule).toBe("data_exposure_logging");
  });

  test("detects JSON.stringify logging of PII objects", () => {
    const diff = `
+console.log("User data:", JSON.stringify(user));
+logger.error("Customer profile dump:", JSON.stringify(customer));
+log.info("Response body:", JSON.stringify(res.body));
`;
    const findings = dataExposureLogging(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("detects logging of HTTP headers", () => {
    const diff = `
+app.use((req, res, next) => {
+  console.log("Incoming headers:", req.headers);
+  log.debug("Request headers", request.headers);
+  next();
+});
`;
    const findings = dataExposureLogging(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("detects direct PII object logging", () => {
    const diff = `
+console.log("User profile loaded:", user);
+logger.warn("Failed account lookup", account);
+log.info("Customer data:", customer);
`;
    const findings = dataExposureLogging(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  /* ── Negative fixtures ── */

  test("ignores safe logging patterns (static strings, metrics, non-PII)", () => {
    const diff = `
+console.log("Request received at", new Date().toISOString());
+logger.info("User registered successfully", { userId: req.userId });
+log.metric("api.latency", elapsedMs);
+console.warn("Database connection lost, retrying...");
`;
    const findings = dataExposureLogging(diff);
    expect(findings.length).toBe(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Pattern C — Insecure security header defaults
 * ──────────────────────────────────────────────────────────────────────────── */

describe("insecureSecurityConfig", () => {
  /* ── Positive fixtures — blocker severity ── */

  test("detects CORS wildcard origin header (blocker)", () => {
    const diff = `
+res.setHeader("Access-Control-Allow-Origin", "*");
+res.setHeader("Access-Control-Allow-Methods", "GET, POST");
`;
    const findings = insecureSecurityConfig(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker).toBeDefined();
    expect(blocker!.rule).toBe("insecure_security_config");
  });

  test("detects CORS config with wildcard origin (blocker)", () => {
    const diff = `
+app.use(cors({
+  origin: "*",
+  methods: ["GET", "POST"],
+}));
`;
    const findings = insecureSecurityConfig(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker).toBeDefined();
  });

  test("detects disabled HSTS (blocker)", () => {
    const diff = `
+res.setHeader("Strict-Transport-Security", "max-age=0");
`;
    const findings = insecureSecurityConfig(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker).toBeDefined();
  });

  /* ── Positive fixtures — warning severity ── */

  test("detects permissive CORS middleware (warning)", () => {
    const diff = `
+app.use(cors());
+app.use(cors({ origin: true, credentials: true }));
`;
    const findings = insecureSecurityConfig(diff);
    const warnings = findings.filter((f) => f.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("detects CSP with unsafe-inline or unsafe-eval (warning)", () => {
    const diff = `
+res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval';");
+const csp = "style-src 'self' 'unsafe-inline';";
`;
    const findings = insecureSecurityConfig(diff);
    const warnings = findings.filter((f) => f.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("detects low HSTS max-age (warning)", () => {
    const diff = `
+res.setHeader("Strict-Transport-Security", "max-age=86400");
`;
    const findings = insecureSecurityConfig(diff);
    const warnings = findings.filter((f) => f.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  /* ── Negative fixtures ── */

  test("ignores safe CORS origins", () => {
    const diff = `
+app.use(cors({
+  origin: "https://trusted-frontend.example.com",
+  credentials: true,
+}));
+res.setHeader("Access-Control-Allow-Origin", "https://trusted-frontend.example.com");
`;
    const findings = insecureSecurityConfig(diff);
    const corsFindings = findings.filter(
      (f) => f.message.includes("CORS"),
    );
    expect(corsFindings.length).toBe(0);
  });

  test("ignores safe HSTS and CSP configs", () => {
    const diff = `
+res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
+res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self';");
`;
    const findings = insecureSecurityConfig(diff);
    expect(findings.length).toBe(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Integration: Config toggle suppression
 * ──────────────────────────────────────────────────────────────────────────── */

describe("config toggle suppression", () => {
  const emptyPlan = { changes: [], estimated_diff_lines: 0 };

  const CREDENTIAL_DIFF = `
+const apiKey = "sk-proj-abc123def456ghijklmn";
+console.log("User data:", JSON.stringify(user));
+res.setHeader("Access-Control-Allow-Origin", "*");
`;

  test("disabling all three new toggles suppresses their findings", () => {
    const config: Partial<PreCheckConfig> = {
      block_on_hardcoded_credential: false,
      block_on_data_exposure_logging: false,
      block_on_insecure_security_config: false,
    };
    const result = runPreCheck(CREDENTIAL_DIFF, emptyPlan, config);
    const newRuleFindings = result.findings.filter((f) =>
      ["hardcoded_credential", "data_exposure_logging", "insecure_security_config"].includes(f.rule),
    );
    expect(newRuleFindings.length).toBe(0);
  });

  test("partial toggle only suppresses specific rule", () => {
    const config: Partial<PreCheckConfig> = {
      block_on_hardcoded_credential: false,
      block_on_data_exposure_logging: true,
      block_on_insecure_security_config: true,
    };
    const result = runPreCheck(CREDENTIAL_DIFF, emptyPlan, config);
    const hardcoded = result.findings.filter((f) => f.rule === "hardcoded_credential");
    const logging = result.findings.filter((f) => f.rule === "data_exposure_logging");
    const insecure = result.findings.filter((f) => f.rule === "insecure_security_config");
    expect(hardcoded.length).toBe(0);
    expect(logging.length).toBeGreaterThanOrEqual(1);
    expect(insecure.length).toBeGreaterThanOrEqual(1);
  });
});
