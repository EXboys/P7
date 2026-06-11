import { describe, expect, test } from "bun:test";
import { captureEntityDiff, type EntityDiffResult } from "../src/entity-diff.ts";

/* ── Helper ── */

/** Sum entity count across all files in a result. */
function entityCount(result: EntityDiffResult): number {
  return result.files.reduce((acc, f) => acc + f.entities.length, 0);
}

/** Find a specific entity by type and name. */
function findEntity(result: EntityDiffResult, entityType: string, name: string) {
  for (const file of result.files) {
    const e = file.entities.find((e) => e.entityType === entityType && e.name === name);
    if (e) return e;
  }
  return undefined;
}

/* ── Tests ── */

describe("captureEntityDiff", () => {
  // 1. Function detection — added, modified, deleted
  test("detects added / modified / deleted functions", () => {
    const diff = [
      "diff --git a/src/user.ts b/src/user.ts",
      "index abc..def 100644",
      "--- a/src/user.ts",
      "+++ b/src/user.ts",
      "@@ -1,8 +1,10 @@",
      " export function greet(name: string) {",
      "   return `Hello, ${name}`;",
      " }",
      "-export function oldHelper() {",
      "-  return 42;",
      "-}",
      "+export function newHelper() {",
      "+  return 99;",
      "+}",
      " export function existingFn() {",
      "   return true;",
      " }",
      "+export function addedFn() {",
      "+  return 'new';",
      "+}",
    ].join("\n");

    const result = captureEntityDiff(diff);

    // addedFn is purely added
    const added = findEntity(result, "function", "addedFn");
    expect(added?.changeType).toBe("added");
    expect(added?.lineNumber).toBeGreaterThan(0);

    // oldHelper is purely deleted
    const deleted = findEntity(result, "function", "oldHelper");
    expect(deleted?.changeType).toBe("deleted");

    // existingFn is in context with surrounding changes
    const modified = findEntity(result, "function", "existingFn");
    expect(modified?.changeType).toBe("modified");
    expect(modified?.lineNumber).toBeGreaterThan(0);

    // greet is also in context with surrounding changes
    expect(findEntity(result, "function", "greet")?.changeType).toBe("modified");
  });

  // 2. Class with method detection
  test("detects class and method entities", () => {
    const diff = [
      "diff --git a/src/model.ts b/src/model.ts",
      "index abc..def 100644",
      "--- a/src/model.ts",
      "+++ b/src/model.ts",
      "@@ -1,5 +1,12 @@",
      " export class UserModel {",
      "   id: number;",
      "   name: string;",
      "+",
      "+  getDisplayName() {",
      "+    return this.name;",
      "+  }",
      " }",
    ].join("\n");

    const result = captureEntityDiff(diff);

    // Class in context with changes nearby → modified
    const cls = findEntity(result, "class", "UserModel");
    expect(cls?.changeType).toBe("modified");

    // Method is added
    const method = findEntity(result, "method", "getDisplayName");
    expect(method?.changeType).toBe("added");
    expect(findEntity(result, "class", "UserModel")?.filePath).toBe("src/model.ts");
  });

  // 3. Variable declaration detection
  test("detects variable declarations", () => {
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "index abc..def 100644",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,3 +1,6 @@",
      " const BASE_URL = 'https://api.example.com';",
      "+export const API_VERSION = 'v2';",
      "+const TIMEOUT_MS = 5000;",
      " let currentEnv = 'production';",
    ].join("\n");

    const result = captureEntityDiff(diff);

    // BASE_URL in context → modified
    expect(findEntity(result, "variable", "BASE_URL")?.changeType).toBe("modified");
    // API_VERSION added
    expect(findEntity(result, "variable", "API_VERSION")?.changeType).toBe("added");
    // TIMEOUT_MS added
    expect(findEntity(result, "variable", "TIMEOUT_MS")?.changeType).toBe("added");
    // currentEnv in context → modified
    expect(findEntity(result, "variable", "currentEnv")?.changeType).toBe("modified");
  });

  // 4. Interface and type alias detection
  test("detects interfaces and type aliases", () => {
    const diff = [
      "diff --git a/src/types.ts b/src/types.ts",
      "index abc..def 100644",
      "--- a/src/types.ts",
      "+++ b/src/types.ts",
      "@@ -1,6 +1,11 @@",
      " export interface User {",
      "   id: number;",
      "   name: string;",
      " }",
      "+export interface Admin extends User {",
      "+  role: string;",
      "+}",
      " export type Status = 'active' | 'inactive';",
      "+export type ApiResponse<T> = { data: T; error?: string };",
    ].join("\n");

    const result = captureEntityDiff(diff);

    expect(findEntity(result, "interface", "User")?.changeType).toBe("modified");
    expect(findEntity(result, "interface", "Admin")?.changeType).toBe("added");
    expect(findEntity(result, "type_alias", "Status")?.changeType).toBe("modified");
    expect(findEntity(result, "type_alias", "ApiResponse")?.changeType).toBe("added");
  });

  // 5. Enum detection
  test("detects enum declarations", () => {
    const diff = [
      "diff --git a/src/status.ts b/src/status.ts",
      "index abc..def 100644",
      "--- a/src/status.ts",
      "+++ b/src/status.ts",
      "@@ -1,4 +1,8 @@",
      " export enum Status {",
      "   Active,",
      "   Inactive,",
      " }",
      "+",
      "+export enum Priority {",
      "+  Low,",
      "+  Medium,",
      "+  High,",
      "+}",
    ].join("\n");

    const result = captureEntityDiff(diff);

    expect(findEntity(result, "enum", "Status")?.changeType).toBe("modified");
    expect(findEntity(result, "enum", "Priority")?.changeType).toBe("added");
  });

  // 6. New file — all entities are added
  test("treats all entities as added in a new file", () => {
    const diff = [
      "diff --git a/src/helper.ts b/src/helper.ts",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/src/helper.ts",
      "@@ -0,0 +1,6 @@",
      "+export function helper() {",
      "+  return 1;",
      "+}",
      "+",
      "+export class Helper {}",
    ].join("\n");

    const result = captureEntityDiff(diff);
    expect(entityCount(result)).toBe(2);

    const fn = findEntity(result, "function", "helper");
    expect(fn?.changeType).toBe("added");
    expect(fn?.filePath).toBe("src/helper.ts");

    const cls = findEntity(result, "class", "Helper");
    expect(cls?.changeType).toBe("added");
  });

  // 7. Deleted file — all entities are deleted
  test("treats all entities as deleted in a removed file", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index abc1234..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,4 +0,0 @@",
      "-export function oldFn() {",
      "-  return 0;",
      "-}",
    ].join("\n");

    const result = captureEntityDiff(diff);
    expect(entityCount(result)).toBe(1);

    const fn = findEntity(result, "function", "oldFn");
    expect(fn?.changeType).toBe("deleted");
    expect(fn?.filePath).toBe("src/old.ts");
  });

  // 8. Empty diff → zero entities
  test("returns empty result for empty diff", () => {
    expect(captureEntityDiff("").files).toEqual([]);
    expect(captureEntityDiff("   ").files).toEqual([]);
  });

  // 9. Mixed entity types in a single file hunk
  test("detects mixed entity types in one file hunk", () => {
    const diff = [
      "diff --git a/src/mixed.ts b/src/mixed.ts",
      "index abc..def 100644",
      "--- a/src/mixed.ts",
      "+++ b/src/mixed.ts",
      "@@ -1,3 +1,10 @@",
      " export function existing() {",
      "   return 1;",
      " }",
      "+",
      "+export interface Options {",
      "+  debug: boolean;",
      "+}",
      "+",
      "+export const DEFAULT_OPTIONS: Options = { debug: false };",
    ].join("\n");

    const result = captureEntityDiff(diff);

    // Should detect 3 entities: function (context), interface (added), variable (added)
    expect(entityCount(result)).toBe(3);

    expect(findEntity(result, "function", "existing")?.changeType).toBe("modified");
    expect(findEntity(result, "interface", "Options")?.changeType).toBe("added");
    expect(findEntity(result, "variable", "DEFAULT_OPTIONS")?.changeType).toBe("added");
  });
});
