/**
 * Entity-level semantic diff model: parses before/after AST signatures for each
 * changed entity and classifies the semantic change kind.
 *
 * Uses the TypeScript compiler API for structural signature extraction.
 * Pure functions — no I/O; callers provide source strings.
 *
 * @module
 */

import * as ts from "typescript";
import { createHash } from "node:crypto";

/* ── Entity types (inline, compatible with entity-diff.ts) ── */

/** Supported entity types in TypeScript/JavaScript. */
export type EntityType =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type_alias"
  | "enum"
  | "method";

/** Classification of how an entity changed across a diff. */
export type EntityChangeType = "added" | "modified" | "deleted";

/** A single entity change detected in a diff hunk. Mirrors ChangeEntity from entity-diff.ts. */
export interface ChangeEntity {
  /** Entity name as declared in source. */
  name: string;
  /** Entity type classification. */
  entityType: EntityType;
  /** How this entity changed relative to the base revision. */
  changeType: EntityChangeType;
  /** File path relative to repository root. */
  filePath: string;
  /** Approximate line number in the post-diff file. */
  lineNumber: number;
  /** Line number in the pre-diff file (only for modified/deleted). */
  previousLineNumber?: number;
}

/* ── Model types ── */

/** What kind of semantic change occurred between before/after signatures. */
export type SemanticChangeKind =
  | "no_structural_change"
  | "body_modified"
  | "signature_changed"
  | "modifiers_changed"
  | "type_parameters_changed"
  | "members_changed"
  | "entity_added"
  | "entity_deleted";

/** Structural signature extracted from a declaration node's AST. */
export interface AstSignature {
  /** Modifier keywords (export, public, private, static, abstract, readonly, async). */
  modifiers: string[];
  /** Formal parameter descriptors. */
  parameters: ParamSignature[];
  /** Stringified return type annotation, or null for inferred/implicit. */
  returnType: string | null;
  /** SHA-256 hex hash of the body text, or null for abstract/interface/enum/type-alias. */
  bodyHash: string | null;
  /** Member signatures for class / interface / enum bodies. */
  members: MemberSignature[];
  /** Heritage clauses (extends / implements). */
  heritageClauses: string[];
  /** Generic type parameter names. */
  typeParameters: string[];
}

export interface ParamSignature {
  name: string;
  typeAnnotation: string | null;
  optional: boolean;
}

export interface MemberSignature {
  name: string;
  kind: string;
  typeAnnotation: string | null;
}

/** Result of comparing two AST signatures. */
export interface SignatureComparison {
  kind: SemanticChangeKind;
  details: string;
}

/** Per-entity semantic diff model result. */
export interface EntityDiffModelEntry {
  entity: ChangeEntity;
  beforeSignature: AstSignature | null;
  afterSignature: AstSignature | null;
  comparison: SignatureComparison;
}

/** Top-level result from computeEntityDiffModel(). */
export interface EntityDiffModel {
  entries: EntityDiffModelEntry[];
}

/* ── Internal: entity-to-SyntaxKind mapping ── */

const ENTITY_KIND_MAP: Partial<Record<EntityType, ts.SyntaxKind>> = {
  function: ts.SyntaxKind.FunctionDeclaration,
  class: ts.SyntaxKind.ClassDeclaration,
  variable: ts.SyntaxKind.VariableDeclaration,
  interface: ts.SyntaxKind.InterfaceDeclaration,
  type_alias: ts.SyntaxKind.TypeAliasDeclaration,
  enum: ts.SyntaxKind.EnumDeclaration,
};

/* ── Public API: computeAstSignature ── */

/**
 * Compute the structural AST signature for a single entity from its source text.
 *
 * @param source — Full source file text containing the entity declaration.
 * @param entity — Entity descriptor (name + entityType).
 * @returns AstSignature if the declaration node is found, or null.
 */
export function computeAstSignature(
  source: string,
  entity: { name: string; entityType: EntityType },
): AstSignature | null {
  const sf = ts.createSourceFile("temp.ts", source, ts.ScriptTarget.Latest, true);

  const decl = entity.entityType === "method"
    ? findMethodInClasses(sf, entity.name)
    : findDeclarationNode(sf, entity);

  if (!decl) return null;

  return extractSignature(decl, sf, entity.entityType);
}

/* ── Public API: compareSignatures ── */

/**
 * Compare two AST signatures and classify the semantic change kind.
 *
 * Priority ordering: modifiers_changed > type_parameters_changed >
 * signature_changed > members_changed > body_modified > no_structural_change.
 *
 * @returns A SignatureComparison with the highest-priority change kind detected.
 */
export function compareSignatures(
  before: AstSignature,
  after: AstSignature,
): SignatureComparison {
  // 1. Modifiers changed (highest priority among structural changes)
  if (!arraysEqual(before.modifiers, after.modifiers)) {
    const removed = before.modifiers.filter((m) => !after.modifiers.includes(m));
    const added = after.modifiers.filter((m) => !before.modifiers.includes(m));
    const parts: string[] = [];
    if (removed.length) parts.push(`removed modifiers: ${removed.join(", ")}`);
    if (added.length) parts.push(`added modifiers: ${added.join(", ")}`);
    return { kind: "modifiers_changed", details: parts.join("; ") };
  }

  // 2. Type parameters changed
  if (!arraysEqual(before.typeParameters, after.typeParameters)) {
    return { kind: "type_parameters_changed", details: `type params: [${before.typeParameters.join(", ")}] → [${after.typeParameters.join(", ")}]` };
  }

  // 3. Heritage clauses changed (extends/implements)
  if (!arraysEqual(before.heritageClauses, after.heritageClauses)) {
    return { kind: "signature_changed", details: `heritage: [${before.heritageClauses.join(", ")}] → [${after.heritageClauses.join(", ")}]` };
  }

  // 4. Parameters changed
  if (!paramsEqual(before.parameters, after.parameters)) {
    return { kind: "signature_changed", details: "parameters changed" };
  }

  // 5. Return type changed
  if (before.returnType !== after.returnType) {
    return { kind: "signature_changed", details: `return type: ${before.returnType ?? "inferred"} → ${after.returnType ?? "inferred"}` };
  }

  // 6. Members changed (class/interface body)
  if (!membersEqual(before.members, after.members)) {
    return { kind: "members_changed", details: "class/interface members changed" };
  }

  // 7. Body hash changed
  if (before.bodyHash !== after.bodyHash) {
    return { kind: "body_modified", details: "function/class body text modified" };
  }

  return { kind: "no_structural_change", details: "no structural difference detected" };
}

/* ── Public API: computeEntityDiffModel ── */

/**
 * Compute the full entity diff model: for each changed entity, extract the
 * before/after AST signature and classify the semantic change kind.
 *
 * @param beforeSource — Pre-diff source text for the file.
 * @param afterSource  — Post-diff source text for the file.
 * @param entities     — List of ChangeEntity descriptors for entities in the diff.
 * @returns EntityDiffModel with one entry per entity.
 */
export function computeEntityDiffModel(
  beforeSource: string,
  afterSource: string,
  entities: ChangeEntity[],
): EntityDiffModel {
  const entries: EntityDiffModelEntry[] = [];

  for (const entity of entities) {
    // Deleted entities: only before exists
    if (entity.changeType === "deleted") {
      const beforeSig = computeAstSignature(beforeSource, entity);
      entries.push({
        entity,
        beforeSignature: beforeSig,
        afterSignature: null,
        comparison: { kind: "entity_deleted", details: `entity removed in ${entity.filePath}` },
      });
      continue;
    }

    // Added entities: only after exists
    if (entity.changeType === "added") {
      const afterSig = computeAstSignature(afterSource, entity);
      entries.push({
        entity,
        beforeSignature: null,
        afterSignature: afterSig,
        comparison: { kind: "entity_added", details: `new entity introduced in ${entity.filePath}` },
      });
      continue;
    }

    // Modified entities: compare before and after
    const beforeSig = computeAstSignature(beforeSource, entity);
    const afterSig = computeAstSignature(afterSource, entity);

    if (!beforeSig || !afterSig) {
      // One side failed to parse — partial information
      entries.push({
        entity,
        beforeSignature: beforeSig,
        afterSignature: afterSig,
        comparison: {
          kind: beforeSig && !afterSig ? "entity_deleted" : !beforeSig && afterSig ? "entity_added" : "signature_changed",
          details: !beforeSig && !afterSig
            ? "entity not found in either before or after source"
            : "entity signature could not be fully resolved",
        },
      });
      continue;
    }

    const comparison = compareSignatures(beforeSig, afterSig);
    entries.push({ entity, beforeSignature: beforeSig, afterSignature: afterSig, comparison });
  }

  return { entries };
}

/* ── AST node lookup ── */

/**
 * Walk the AST to find a declaration node matching the entity's name and type.
 */
function findDeclarationNode(
  node: ts.Node,
  entity: { name: string; entityType: EntityType },
): ts.Node | null {
  const expectedKind = ENTITY_KIND_MAP[entity.entityType];
  if (expectedKind === undefined) return null;

  let found: ts.Node | null = null;

  function visit(n: ts.Node): void {
    if (found) return;
    if (n.kind === expectedKind) {
      const n2 = n as ts.NamedDeclaration;
      // VariableDeclaration has a slightly different name property
      const name =
        ts.isVariableDeclaration(n2)
          ? (n2.name as ts.Identifier).escapedText?.toString()
          : n2.name && ts.isIdentifier(n2.name)
            ? n2.name.escapedText?.toString()
            : undefined;

      if (name === entity.name) {
        found = n;
        return;
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(node);
  return found;
}

/**
 * Search for a method declaration by name within all class declarations.
 */
function findMethodInClasses(node: ts.Node, methodName: string): ts.MethodDeclaration | null {
  let found: ts.MethodDeclaration | null = null;

  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isClassDeclaration(n)) {
      for (const member of n.members) {
        if (ts.isMethodDeclaration(member)) {
          const name =
            member.name && ts.isIdentifier(member.name)
              ? member.name.escapedText?.toString()
              : undefined;
          if (name === methodName) {
            found = member;
            return;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(node);
  return found;
}

/* ── Signature extraction ── */

/**
 * Extract structural signature from a declaration AST node.
 */
function extractSignature(node: ts.Node, sf: ts.SourceFile, entityType: EntityType): AstSignature {
  const base: AstSignature = {
    modifiers: extractModifiers(node),
    parameters: [],
    returnType: null,
    bodyHash: null,
    members: [],
    heritageClauses: [],
    typeParameters: [],
  };

  if (entityType === "function" && ts.isFunctionDeclaration(node)) {
    return extractFunctionSignature(node, sf, base);
  }

  if (entityType === "class" && ts.isClassDeclaration(node)) {
    return extractClassSignature(node, sf, base);
  }

  if (entityType === "variable" && ts.isVariableDeclaration(node)) {
    return extractVariableSignature(node, sf, base);
  }

  if (entityType === "interface" && ts.isInterfaceDeclaration(node)) {
    return extractInterfaceSignature(node, sf, base);
  }

  if (entityType === "type_alias" && ts.isTypeAliasDeclaration(node)) {
    return extractTypeAliasSignature(node, base);
  }

  if (entityType === "enum" && ts.isEnumDeclaration(node)) {
    return extractEnumSignature(node, base);
  }

  if (entityType === "method" && ts.isMethodDeclaration(node)) {
    return extractMethodSignature(node, sf, base);
  }

  return base;
}

/* ── Entity-specific extractors ── */

function extractFunctionSignature(
  node: ts.FunctionDeclaration,
  sf: ts.SourceFile,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    parameters: node.parameters.map(paramToSignature),
    returnType: node.type ? node.type.getText(sf) : null,
    typeParameters: extractTypeParamNames(node),
    bodyHash: node.body ? hashText(node.body.getText(sf)) : null,
  };
}

function extractClassSignature(
  node: ts.ClassDeclaration,
  sf: ts.SourceFile,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    typeParameters: extractTypeParamNames(node),
    heritageClauses: extractHeritageClauses(node, sf),
    members: node.members.map((m) => memberToSignature(m, sf)),
    bodyHash: node.members.length > 0
      ? hashText(node.members.map((m) => m.getText(sf)).join("\n"))
      : null,
  };
}

function extractVariableSignature(
  node: ts.VariableDeclaration,
  sf: ts.SourceFile,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    returnType: node.type
      ? node.type.getText(sf)
      : node.initializer
        ? inferTypeFromInitializer(node.initializer)
        : null,
    // For arrow functions / function expressions, extract body hash
    bodyHash: extractBodyHashFromInitializer(node.initializer, sf),
  };
}

function extractInterfaceSignature(
  node: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    typeParameters: extractTypeParamNames(node),
    heritageClauses: extractHeritageClauses(node, sf),
    members: node.members.map((m) => memberToSignature(m, sf)),
  };
}

function extractTypeAliasSignature(
  node: ts.TypeAliasDeclaration,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    typeParameters: extractTypeParamNames(node),
    returnType: node.type ? node.type.getText() : null,
  };
}

function extractEnumSignature(
  node: ts.EnumDeclaration,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    members: node.members.map((m) => ({
      name: m.name && ts.isIdentifier(m.name) ? m.name.escapedText?.toString() ?? "" : "",
      kind: "enum_member",
      typeAnnotation: m.initializer ? m.initializer.getText() : null,
    })),
  };
}

function extractMethodSignature(
  node: ts.MethodDeclaration,
  sf: ts.SourceFile,
  base: AstSignature,
): AstSignature {
  return {
    ...base,
    modifiers: extractModifiers(node),
    parameters: node.parameters.map(paramToSignature),
    returnType: node.type ? node.type.getText(sf) : null,
    typeParameters: extractTypeParamNames(node),
    bodyHash: node.body ? hashText(node.body.getText(sf)) : null,
  };
}

/* ── Helpers ── */

function extractModifiers(node: ts.Node): string[] {
  // ts.getModifiers expects HasModifiers — cast via 'as' to satisfy TS 5.8
  const mods = ts.getModifiers(node as unknown as ts.HasModifiers);
  if (mods && mods.length > 0) {
    return mods.map((m) => ts.tokenToString(m.kind) ?? ts.SyntaxKind[m.kind]);
  }

  // For variable declarations, modifiers live on the grandparent VariableStatement
  // (VariableDeclaration → VariableDeclarationList → VariableStatement)
  const parent = node.parent;
  if (parent && ts.isVariableDeclarationList(parent)) {
    const grandparent = parent.parent;
    if (grandparent && ts.isVariableStatement(grandparent)) {
      const parentMods = ts.getModifiers(grandparent as unknown as ts.HasModifiers);
      if (parentMods) {
        return parentMods.map((m) => ts.tokenToString(m.kind) ?? ts.SyntaxKind[m.kind]);
      }
    }
  }

  return [];
}

function paramToSignature(p: ts.ParameterDeclaration): ParamSignature {
  const isOptional = !!(p.questionToken ?? p.dotDotDotToken);
  return {
    name: p.name && ts.isIdentifier(p.name) ? p.name.escapedText?.toString() ?? "" : "",
    typeAnnotation: p.type ? p.type.getText() : null,
    optional: isOptional,
  };
}

function memberToSignature(m: ts.ClassElement | ts.TypeElement, sf: ts.SourceFile): MemberSignature {
  const isMethod = ts.isMethodDeclaration(m) || ts.isMethodSignature(m);
  const isProperty = ts.isPropertyDeclaration(m) || ts.isPropertySignature(m);
  const isGetter = ts.isGetAccessorDeclaration(m);
  const isSetter = ts.isSetAccessorDeclaration(m);

  let name = "";
  if ((isMethod || isProperty || isGetter || isSetter) && m.name && ts.isIdentifier(m.name)) {
    name = m.name.escapedText?.toString() ?? "";
  }

  // Determine member kind
  let kind: string;
  if (isMethod) kind = "method";
  else if (isProperty) kind = "property";
  else if (isGetter) kind = "getter";
  else if (isSetter) kind = "setter";
  else if (ts.isConstructorDeclaration(m)) kind = "constructor";
  else kind = ts.SyntaxKind[m.kind];

  return {
    name,
    kind,
    typeAnnotation: isMethod || ts.isMethodSignature(m)
      ? null
      : isProperty && (m as ts.PropertyDeclaration).type
        ? (m as ts.PropertyDeclaration).type!.getText(sf)
        : null,
  };
}

function extractTypeParamNames(
  node: ts.FunctionDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.MethodDeclaration,
): string[] {
  if (!node.typeParameters) return [];
  return node.typeParameters.map((tp) => tp.name.escapedText?.toString() ?? "");
}

function extractHeritageClauses(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  sf: ts.SourceFile,
): string[] {
  if (!node.heritageClauses) return [];
  return node.heritageClauses.map((hc) => hc.getText(sf));
}

function inferTypeFromInitializer(init: ts.Expression): string | null {
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return "function";
  if (ts.isObjectLiteralExpression(init)) return "object";
  if (ts.isArrayLiteralExpression(init)) return "array";
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return "string";
  if (ts.isNumericLiteral(init)) return "number";
  if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (init.kind === ts.SyntaxKind.NullKeyword) return "null";
  return null;
}

function extractBodyHashFromInitializer(init: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  if (!init) return null;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    if (init.body) {
      return hashText(init.body.getText(sf));
    }
  }
  return null;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/* ── Comparison helpers ── */

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function paramsEqual(a: ParamSignature[], b: ParamSignature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return false;
    if (a[i].typeAnnotation !== b[i].typeAnnotation) return false;
    if (a[i].optional !== b[i].optional) return false;
  }
  return true;
}

function membersEqual(a: MemberSignature[], b: MemberSignature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return false;
    if (a[i].kind !== b[i].kind) return false;
    if (a[i].typeAnnotation !== b[i].typeAnnotation) return false;
  }
  return true;
}
