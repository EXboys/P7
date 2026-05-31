export type HallucinationCategory =
  | "fictional-import"
  | "nonexistent-api"
  | "wrong-type-signature";

export interface HallucinationFixture {
  id: string;
  category: HallucinationCategory;
  description: string;
  /** When true, this fixture represents a valid (non-hallucinated) change for negative testing. */
  isNegative?: boolean;
  /** Relative paths and source written before applying diff (hono/zod stack). */
  setupFiles: Record<string, string>;
  /** Synthetic diff body passed to reviewDiff (not necessarily real git --stat). */
  diffStat: string;
  /** Substrings that must appear in diffStat and guide blocker assertions. */
  expectedBlockers: string[];
}

export const HALLUCINATION_FIXTURES: HallucinationFixture[] = [
  {
    id: "fictional-import-fastify-redis",
    category: "fictional-import",
    description: "Import fictional npm package @fastify/redis (not in package.json)",
    setupFiles: {
      "src/cache.ts": `import { Hono } from "hono";

export const cacheApp = new Hono();
`,
    },
    diffStat: ` src/cache.ts | 2 +++
@@ -1,3 +1,5 @@
 import { Hono } from "hono";
+import Redis from "@fastify/redis";
 
 export const cacheApp = new Hono();
+const redis = Redis({ url: "redis://localhost" });`,
    expectedBlockers: ["@fastify/redis"],
  },
  {
    id: "fictional-import-org-ml-core",
    category: "fictional-import",
    description: "Import fictional scoped package @org/ml-core",
    setupFiles: {
      "src/scoring.ts": `import { z } from "zod";

export const scoreSchema = z.object({ value: z.number() });
`,
    },
    diffStat: ` src/scoring.ts | 3 +++
@@ -1,4 +1,7 @@
 import { z } from "zod";
+import { trainModel } from "@org/ml-core";
 
 export const scoreSchema = z.object({ value: z.number() });
+export const run = trainModel({ epochs: 3 });`,
    expectedBlockers: ["@org/ml-core"],
  },
  {
    id: "fictional-import-relative-crypto-v2",
    category: "fictional-import",
    description: "Relative import to non-existent ../../utils/crypto-v2",
    setupFiles: {
      "src/routes/auth.ts": `import { Hono } from "hono";

export const auth = new Hono();
`,
    },
    diffStat: ` src/routes/auth.ts | 2 +++
@@ -1,3 +1,5 @@
 import { Hono } from "hono";
+import { hashToken } from "../../utils/crypto-v2";
 
 export const auth = new Hono();
+auth.get("/token", (c) => c.json({ hash: hashToken("x") }));`,
    expectedBlockers: ["crypto-v2"],
  },
  {
    id: "nonexistent-api-connect-to-db",
    category: "nonexistent-api",
    description: "Call .connectToDB() on object without that method",
    setupFiles: {
      "src/db/client.ts": `export const dbClient = {
  query(sql: string) {
    return Promise.resolve([]);
  },
};
`,
    },
    diffStat: ` src/db/client.ts | 2 +++
@@ -1,6 +1,8 @@
 export const dbClient = {
   query(sql: string) {
     return Promise.resolve([]);
   },
+  async boot() {
+    await dbClient.connectToDB();
+  },
 };`,
    expectedBlockers: ["connectToDB"],
  },
  {
    id: "nonexistent-api-bun-kafka",
    category: "nonexistent-api",
    description: "Use non-existent Bun.kafka() API",
    setupFiles: {
      "src/queue.ts": `export function enqueue(topic: string, payload: string) {
  return { topic, payload };
}
`,
    },
    diffStat: ` src/queue.ts | 4 +++
@@ -1,3 +1,7 @@
 export function enqueue(topic: string, payload: string) {
   return { topic, payload };
 }
+export function publish(topic: string, body: string) {
+  const producer = Bun.kafka().producer({ topic });
+  return producer.send(body);
+}`,
    expectedBlockers: ["Bun.kafka"],
  },
  {
    id: "nonexistent-api-run-diagnostics",
    category: "nonexistent-api",
    description: "Call undefined global runDiagnostics()",
    setupFiles: {
      "src/health.ts": `import { Hono } from "hono";

export const health = new Hono();
health.get("/", (c) => c.json({ ok: true }));
`,
    },
    diffStat: ` src/health.ts | 3 +++
@@ -2,4 +2,7 @@ import { Hono } from "hono";
 
 export const health = new Hono();
 health.get("/", (c) => c.json({ ok: true }));
+health.get("/diag", () => {
+  return c.json(runDiagnostics());
+});`,
    expectedBlockers: ["runDiagnostics"],
  },
  {
    id: "wrong-type-signature-return-mismatch",
    category: "wrong-type-signature",
    description: "Function annotated to return string but returns number",
    setupFiles: {
      "src/format.ts": `export function label(id: number): string {
  return \`item-\${id}\`;
}
`,
    },
    diffStat: ` src/format.ts | 2 +++
@@ -1,3 +1,5 @@
-export function label(id: number): string {
-  return \`item-\${id}\`;
+export function label(id: number): string {
+  return id * 2;
 }`,
    expectedBlockers: ["string", "number"],
  },
  {
    id: "wrong-type-signature-param-incompatible",
    category: "wrong-type-signature",
    description: "Pass incompatible argument type into zod parse",
    setupFiles: {
      "src/validate.ts": `import { z } from "zod";

const idSchema = z.number();
export function parseId(raw: unknown) {
  return idSchema.parse(raw);
}
`,
    },
    diffStat: ` src/validate.ts | 2 +++
@@ -3,5 +3,7 @@ import { z } from "zod";
 const idSchema = z.number();
 export function parseId(raw: unknown) {
   return idSchema.parse(raw);
 }
+export function parseBatch(rows: string[]) {
+  return rows.map((r) => idSchema.parse(r));
+}`,
    expectedBlockers: ["string", "number"],
  },
  // --- Positive: fictional-import (真实包假导出) ---
  {
    id: "fictional-import-hono-sse-stream",
    category: "fictional-import",
    description: "Import non-existent named export StreamSSE from real package hono/sse",
    setupFiles: {
      "src/stream.ts": `import { Hono } from "hono";

export const streamApp = new Hono();
`,
    },
    diffStat: ` src/stream.ts | 2 +++
@@ -1,3 +1,5 @@
 import { Hono } from "hono";
+import { StreamSSE } from "hono/sse";

 export const streamApp = new Hono();
+export const handler = StreamSSE({ limit: 100 });`,
    expectedBlockers: ["StreamSSE"],
  },
  {
    id: "fictional-import-nodemailer-devdep",
    category: "fictional-import",
    description: "Import nodemailer which only exists in devDependencies, used in production source",
    setupFiles: {
      "src/email.ts": `export function sendMail(to: string, body: string) {
  return { ok: true, to, body };
}
`,
    },
    diffStat: ` src/email.ts | 2 +++
@@ -1,3 +1,5 @@
+import nodemailer from "nodemailer";
+
 export function sendMail(to: string, body: string) {
   return { ok: true, to, body };
 }
+export const transporter = nodemailer.createTransport({ host: "smtp.example.com" });`,
    expectedBlockers: ["nodemailer"],
  },
  // --- Positive: nonexistent-api (方法名 typo / 属性当方法) ---
  {
    id: "nonexistent-api-typo-query-all",
    category: "nonexistent-api",
    description: "Call .queryAll() which is a typo of .find() — no queryAll method exists",
    setupFiles: {
      "src/search.ts": `export const db = {
  find(query: string) {
    return Promise.resolve([]);
  },
};
export function search(query: string) {
  return db.find(query);
}
`,
    },
    diffStat: ` src/search.ts | 2 +++
@@ -5,5 +5,7 @@ export const db = {
   },
 };
 export function search(query: string) {
-  return db.find(query);
+  return db.queryAll(query);
 }`,
    expectedBlockers: ["queryAll"],
  },
  {
    id: "nonexistent-api-property-as-method",
    category: "nonexistent-api",
    description: "Call string property appConfig.name() as a function (arity mismatch implied)",
    setupFiles: {
      "src/config.ts": `export const appConfig = {
  name: "myapp",
  version: "1.0.0",
};
`,
    },
    diffStat: ` src/config.ts | 2 +++
@@ -1,4 +1,6 @@
 export const appConfig = {
   name: "myapp",
   version: "1.0.0",
 };
+export function getLabel() {
+  return appConfig.name("en");
+}`,
    expectedBlockers: ["appConfig.name"],
  },
  // --- Positive: wrong-type-signature (async/Promise / 泛型约束) ---
  {
    id: "wrong-type-signature-promise-return",
    category: "wrong-type-signature",
    description: "Function annotated to return number but returns Promise<number>",
    setupFiles: {
      "src/stats.ts": `export function getCount(): number {
  return 42;
}
`,
    },
    diffStat: ` src/stats.ts | 2 +++
@@ -1,3 +1,5 @@
-export function getCount(): number {
-  return 42;
+export function getCount(): number {
+  return Promise.resolve(42);
 }`,
    expectedBlockers: ["Promise", "number"],
  },
  {
    id: "wrong-type-signature-generic-constraint",
    category: "wrong-type-signature",
    description: "Pass objects without required id: number property to generic-constrained function",
    setupFiles: {
      "src/utils.ts": `export function first<T extends { id: number }>(items: T[]): T {
  return items[0];
}
`,
    },
    diffStat: ` src/utils.ts | 2 +++
@@ -1,4 +1,6 @@
 export function first<T extends { id: number }>(items: T[]): T {
   return items[0];
 }
+export function getName() {
+  return first([{ name: "alice" }, { name: "bob" }]);
+}`,
    expectedBlockers: ["id", "number"],
  },
  // --- Negative fixtures (valid changes, no hallucination) ---
  {
    id: "valid-import-hono",
    category: "fictional-import",
    description: "Valid import of Hono from real package hono — should NOT be flagged",
    isNegative: true,
    setupFiles: {
      "src/routes/user.ts": `import { Hono } from "hono";

export function handleUser() {
  return { id: 1 };
}
`,
    },
    diffStat: ` src/routes/user.ts | 2 +++
@@ -1,3 +1,5 @@
+import { Hono } from "hono";
+
 export function handleUser() {
   return { id: 1 };
 }
+const app = new Hono().basePath("/users");`,
    expectedBlockers: [],
  },
  {
    id: "valid-api-array-push",
    category: "nonexistent-api",
    description: "Valid use of Array.prototype.push — should NOT be flagged",
    isNegative: true,
    setupFiles: {
      "src/collect.ts": `export const items: string[] = [];
`,
    },
    diffStat: ` src/collect.ts | 2 +++
@@ -1,2 +1,4 @@
 export const items: string[] = [];
+export function addItem(item: string) {
+  items.push(item);
+}`,
    expectedBlockers: [],
  },
  {
    id: "wrong-type-signature-fictitious-zod-type",
    category: "wrong-type-signature",
    description: "Import non-exported type ZodUltraSchema from zod",
    setupFiles: {
      "src/schema.ts": `import { z } from "zod";

export const userSchema = z.object({ name: z.string() });
`,
    },
    diffStat: ` src/schema.ts | 2 +++
@@ -1,4 +1,6 @@
-import { z } from "zod";
+import { z, type ZodUltraSchema } from "zod";
 
 export const userSchema = z.object({ name: z.string() });
+export type UserUltra = ZodUltraSchema<typeof userSchema>;`,
    expectedBlockers: ["ZodUltraSchema"],
  },
];

export const HALLUCINATION_CATEGORIES: HallucinationCategory[] = [
  "fictional-import",
  "nonexistent-api",
  "wrong-type-signature",
];
