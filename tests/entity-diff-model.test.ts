import { describe, expect, test } from "bun:test";
import {
  computeAstSignature,
  compareSignatures,
  computeEntityDiffModel,
  type ChangeEntity,
  type AstSignature,
  type SignatureComparison,
} from "../src/entity-diff-model.ts";

/* ── Helpers ── */

/** Create a minimal AstSignature for quick comparison tests. */
function sig(overrides: Partial<AstSignature> = {}): AstSignature {
  return {
    modifiers: [],
    parameters: [],
    returnType: null,
    bodyHash: null,
    members: [],
    heritageClauses: [],
    typeParameters: [],
    ...overrides,
  };
}

/* ── Tests: computeAstSignature ── */

describe("computeAstSignature", () => {
  test("extracts full signature from a function declaration", () => {
    const source = `
      export async function fetchUser(id: number, name?: string): Promise<User> {
        const result = await api.get("/user/" + id);
        return result.data;
      }
    `;

    const sig = computeAstSignature(source, { name: "fetchUser", entityType: "function" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toEqual(["export", "async"]);
    expect(sig!.parameters).toHaveLength(2);
    expect(sig!.parameters[0]).toEqual({ name: "id", typeAnnotation: "number", optional: false });
    expect(sig!.parameters[1]).toEqual({ name: "name", typeAnnotation: "string", optional: true });
    expect(sig!.returnType).toBe("Promise<User>");
    expect(sig!.typeParameters).toEqual([]);
    expect(sig!.bodyHash).toBeTruthy();
    expect(typeof sig!.bodyHash).toBe("string");
    expect(sig!.bodyHash!.length).toBe(64); // SHA-256 hex
  });

  test("extracts signature from a class declaration", () => {
    const source = `
      export abstract class BaseService<T> implements Initializable {
        protected abstract init(): void;
        public readonly name: string = "Base";
      }
    `;

    const sig = computeAstSignature(source, { name: "BaseService", entityType: "class" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("export");
    expect(sig!.modifiers).toContain("abstract");
    expect(sig!.typeParameters).toEqual(["T"]);
    expect(sig!.heritageClauses.length).toBeGreaterThanOrEqual(1);
    expect(sig!.members.length).toBeGreaterThanOrEqual(2);

    // Verify member extraction
    const memberNames = sig!.members.map((m) => m.name);
    expect(memberNames).toContain("init");
    expect(memberNames).toContain("name");

    const initMember = sig!.members.find((m) => m.name === "init");
    expect(initMember?.kind).toBe("method");

    const nameMember = sig!.members.find((m) => m.name === "name");
    expect(nameMember?.kind).toBe("property");
    expect(sig!.bodyHash).toBeTruthy();
  });

  test("extracts signature from a variable declaration with type annotation", () => {
    const source = `export const MAX_RETRIES: number = 5;`;

    const sig = computeAstSignature(source, { name: "MAX_RETRIES", entityType: "variable" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("export");
    expect(sig!.returnType).toBe("number");
    expect(sig!.bodyHash).toBeNull();
  });

  test("extracts signature from a variable with arrow function initializer", () => {
    const source = `
      export const handler = (req: Request): Response => {
        return new Response("ok");
      };
    `;

    const sig = computeAstSignature(source, { name: "handler", entityType: "variable" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("export");
    expect(sig!.returnType).toBe("function");
    expect(sig!.bodyHash).toBeTruthy();
    expect(typeof sig!.bodyHash).toBe("string");
    expect(sig!.bodyHash!.length).toBe(64);
  });

  test("extracts signature from an interface declaration", () => {
    const source = `
      export interface Config<T> {
        readonly endpoint: string;
        timeout: number;
        onReady(): void;
      }
    `;

    const sig = computeAstSignature(source, { name: "Config", entityType: "interface" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("export");
    expect(sig!.typeParameters).toEqual(["T"]);
    expect(sig!.members.length).toBeGreaterThanOrEqual(3);

    const endpoint = sig!.members.find((m) => m.name === "endpoint");
    expect(endpoint?.kind).toBe("property");

    const onReady = sig!.members.find((m) => m.name === "onReady");
    expect(onReady?.kind).toBe("method");
  });

  test("extracts signature from a type alias", () => {
    const source = `export type ApiResponse<T> = { data: T; error?: string; };`;

    const sig = computeAstSignature(source, { name: "ApiResponse", entityType: "type_alias" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("export");
    expect(sig!.typeParameters).toEqual(["T"]);
    expect(sig!.returnType).toContain("data");
    expect(sig!.returnType).toContain("T");
  });

  test("extracts signature from an enum declaration", () => {
    const source = `
      export enum Color {
        Red = "RED",
        Green = "GREEN",
        Blue = "BLUE",
      }
    `;

    const sig = computeAstSignature(source, { name: "Color", entityType: "enum" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("export");
    expect(sig!.members).toHaveLength(3);

    const red = sig!.members.find((m) => m.name === "Red");
    expect(red?.typeAnnotation).toBe('"RED"');
  });

  test("extracts signature from a method inside a class", () => {
    const source = `
      class UserService {
        async getUser(id: number): Promise<User> {
          return await db.users.findOne(id);
        }
      }
    `;

    const sig = computeAstSignature(source, { name: "getUser", entityType: "method" });
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toContain("async");
    expect(sig!.parameters).toHaveLength(1);
    expect(sig!.parameters[0]).toEqual({ name: "id", typeAnnotation: "number", optional: false });
    expect(sig!.returnType).toBe("Promise<User>");
    expect(sig!.bodyHash).toBeTruthy();
  });

  test("returns null for unknown entity name", () => {
    const source = `export function existing(): void {}`;
    const sig = computeAstSignature(source, { name: "nonExistent", entityType: "function" });
    expect(sig).toBeNull();
  });

  test("returns null for mismatched entity type", () => {
    const source = `export function foo(): void {}`;
    const sig = computeAstSignature(source, { name: "foo", entityType: "class" });
    expect(sig).toBeNull();
  });

  test("returns null for empty source", () => {
    const sig = computeAstSignature("", { name: "foo", entityType: "function" });
    expect(sig).toBeNull();
  });
});

/* ── Tests: compareSignatures ── */

describe("compareSignatures", () => {
  test("detects body_modified when only body hash differs", () => {
    const before = sig({
      bodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const after = sig({
      bodyHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("body_modified");
    expect(result.details).toContain("body");
  });

  test("detects signature_changed when parameters differ", () => {
    const before = sig({
      parameters: [{ name: "a", typeAnnotation: "number", optional: false }],
    });
    const after = sig({
      parameters: [
        { name: "a", typeAnnotation: "number", optional: false },
        { name: "b", typeAnnotation: "string", optional: false },
      ],
    });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("signature_changed");
    expect(result.details).toContain("parameters");
  });

  test("detects signature_changed when return type differs", () => {
    const before = sig({ returnType: "number" });
    const after = sig({ returnType: "string" });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("signature_changed");
    expect(result.details).toContain("return type");
  });

  test("detects signature_changed when heritage clauses differ", () => {
    const before = sig({ heritageClauses: ["implements Serializable"] });
    const after = sig({ heritageClauses: ["implements Serializable", "extends Base"] });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("signature_changed");
    expect(result.details).toContain("heritage");
  });

  test("detects modifiers_changed when modifiers differ", () => {
    const before = sig({ modifiers: ["public", "readonly"] });
    const after = sig({ modifiers: ["private", "readonly"] });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("modifiers_changed");
    expect(result.details).toContain("modifiers");
  });

  test("detects type_parameters_changed when generics differ", () => {
    const before = sig({ typeParameters: ["T"] });
    const after = sig({ typeParameters: ["T", "U"] });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("type_parameters_changed");
    expect(result.details).toContain("type params");
  });

  test("detects members_changed when class/interface members differ", () => {
    const before = sig({
      members: [
        { name: "a", kind: "property", typeAnnotation: "number" },
      ],
    });
    const after = sig({
      members: [
        { name: "a", kind: "property", typeAnnotation: "number" },
        { name: "b", kind: "property", typeAnnotation: "string" },
      ],
    });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("members_changed");
  });

  test("returns no_structural_change for identical signatures", () => {
    const s = sig({ bodyHash: "abc123", returnType: "void", modifiers: ["export"] });
    const result = compareSignatures(s, { ...s });
    expect(result.kind).toBe("no_structural_change");
  });

  test("prioritizes modifiers_changed over body_modified", () => {
    const before = sig({
      modifiers: ["export"],
      bodyHash: "aaaa",
    });
    const after = sig({
      modifiers: ["export", "async"],
      bodyHash: "bbbb",
    });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("modifiers_changed");
  });

  test("prioritizes signature_changed over members_changed", () => {
    const before = sig({
      parameters: [{ name: "x", typeAnnotation: "number", optional: false }],
      members: [{ name: "a", kind: "property", typeAnnotation: "string" }],
    });
    const after = sig({
      parameters: [{ name: "x", typeAnnotation: "string", optional: false }],
      members: [{ name: "b", kind: "property", typeAnnotation: "number" }],
    });

    const result = compareSignatures(before, after);
    expect(result.kind).toBe("signature_changed");
  });
});

/* ── Tests: computeEntityDiffModel (integration) ── */

describe("computeEntityDiffModel", () => {
  test("classifies a body-only function change as body_modified", () => {
    const before = `
      function greet(name: string): string {
        return "Hello, " + name;
      }
    `;
    const after = `
      function greet(name: string): string {
        return "Hi, " + name;
      }
    `;
    const entities: ChangeEntity[] = [
      { name: "greet", entityType: "function", changeType: "modified", filePath: "src/greet.ts", lineNumber: 1 },
    ];

    const model = computeEntityDiffModel(before, after, entities);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].comparison.kind).toBe("body_modified");
    expect(model.entries[0].beforeSignature).not.toBeNull();
    expect(model.entries[0].afterSignature).not.toBeNull();
  });

  test("classifies a parameter change as signature_changed", () => {
    const before = `
      function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const after = `
      function add(a: number, b: number, c?: number): number {
        return a + b + (c ?? 0);
      }
    `;
    const entities: ChangeEntity[] = [
      { name: "add", entityType: "function", changeType: "modified", filePath: "src/math.ts", lineNumber: 1 },
    ];

    const model = computeEntityDiffModel(before, after, entities);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].comparison.kind).toBe("signature_changed");
  });

  test("classifies an added entity as entity_added", () => {
    const before = "";
    const after = `export function newFn(): void {}`;
    const entities: ChangeEntity[] = [
      { name: "newFn", entityType: "function", changeType: "added", filePath: "src/new.ts", lineNumber: 1 },
    ];

    const model = computeEntityDiffModel(before, after, entities);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].comparison.kind).toBe("entity_added");
    expect(model.entries[0].beforeSignature).toBeNull();
    expect(model.entries[0].afterSignature).not.toBeNull();
  });

  test("classifies a deleted entity as entity_deleted", () => {
    const before = `export function oldFn(): void {}`;
    const after = "";
    const entities: ChangeEntity[] = [
      { name: "oldFn", entityType: "function", changeType: "deleted", filePath: "src/old.ts", lineNumber: 1 },
    ];

    const model = computeEntityDiffModel(before, after, entities);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].comparison.kind).toBe("entity_deleted");
    expect(model.entries[0].beforeSignature).not.toBeNull();
    expect(model.entries[0].afterSignature).toBeNull();
  });

  test("handles mixed entity types in one call", () => {
    const before = `
      function keep(): number { return 1; }
      function remove(): number { return 2; }
    `;
    const after = `
      function keep(): number { return 99; }
      function add(): number { return 3; }
    `;
    const entities: ChangeEntity[] = [
      { name: "keep", entityType: "function", changeType: "modified", filePath: "src/mixed.ts", lineNumber: 1 },
      { name: "remove", entityType: "function", changeType: "deleted", filePath: "src/mixed.ts", lineNumber: 2 },
      { name: "add", entityType: "function", changeType: "added", filePath: "src/mixed.ts", lineNumber: 2 },
    ];

    const model = computeEntityDiffModel(before, after, entities);
    expect(model.entries).toHaveLength(3);

    const keep = model.entries.find((e) => e.entity.name === "keep");
    expect(keep?.comparison.kind).toBe("body_modified");

    const remove = model.entries.find((e) => e.entity.name === "remove");
    expect(remove?.comparison.kind).toBe("entity_deleted");

    const add = model.entries.find((e) => e.entity.name === "add");
    expect(add?.comparison.kind).toBe("entity_added");
  });

  test("returns entity_added when entity not found in before but found in after (modified type)", () => {
    const before = `export function foo(): number { return 1; }`;
    const after = `export function bar(): number { return 2; }`;
    const entities: ChangeEntity[] = [
      { name: "bar", entityType: "function", changeType: "modified", filePath: "src/foo.ts", lineNumber: 1 },
    ];

    const model = computeEntityDiffModel(before, after, entities);
    // bar doesn't exist in before → treat as added
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].comparison.kind).toBe("entity_added");
  });

  test("handles empty entity list gracefully", () => {
    const model = computeEntityDiffModel("before", "after", []);
    expect(model.entries).toEqual([]);
  });
});
