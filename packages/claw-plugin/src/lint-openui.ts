import {
  createParser,
  enrichErrors,
  type LibraryJSONSchema,
  type OpenUIError,
  type ParseResult,
  type Parser,
} from "@openuidev/lang-core";
import schemaJson from "./generated/openui-schema.json" with { type: "json" };

// `openui-schema.json` ships `{schema, componentNames}` — the JSON Schema
// emitted by `openuiLibrary.toJSONSchema()` plus a flat list of component
// names extracted at build time. The constrained `LibraryJSONSchema` type
// in lang-core only names the fields the parser reads (`$defs.*.{properties,
// required}`), so the cast at the boundary stays.
const LIBRARY_SCHEMA: LibraryJSONSchema = (schemaJson as unknown as { schema: LibraryJSONSchema })
  .schema;
const COMPONENT_NAMES: readonly string[] = (schemaJson as unknown as { componentNames: string[] })
  .componentNames;

/** Public-shape of a single lint finding returned to the LLM. */
export interface LintFinding {
  code: string;
  message: string;
  statement?: string;
  component?: string;
  path?: string;
  hint?: string;
}

/**
 * Loose typing for the AST nodes the lint walker inspects. The lang-core
 * `ASTNode` union models the parser's emitted shape, but at lint time we
 * also walk materialized element trees and a few dynamically-shaped
 * branches (e.g. `then`/`otherwise` on legacy conditional nodes). Narrowing
 * everything through this single union lets us dot-access the fields we
 * read while keeping the runtime walk over arbitrary subtrees.
 */
interface LintAstNode {
  k: string;
  name?: unknown;
  n?: unknown;
  args?: unknown;
  els?: unknown;
  entries?: unknown;
  mappedProps?: unknown;
  then?: unknown;
  otherwise?: unknown;
}

interface LintElementNode {
  type: "element";
  props?: unknown;
}

function isLintAstNode(value: unknown): value is LintAstNode {
  return (
    typeof value === "object" && value !== null && typeof (value as { k?: unknown }).k === "string"
  );
}

function isLintElementNode(value: unknown): value is LintElementNode {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "element"
  );
}

export interface LintReport {
  /** True if the code parses cleanly with no validation errors and all refs resolved. */
  ok: boolean;
  /** Structured findings, one per problem, ready to surface back to the LLM. */
  findings: LintFinding[];
  /** Human-readable note combining all findings — handy for quick glances. */
  summary: string;
}

let cachedParser: Parser | null = null;
function getParser(): Parser {
  if (!cachedParser) {
    cachedParser = createParser(LIBRARY_SCHEMA);
  }
  return cachedParser;
}

function unresolvedToFinding(name: string): LintFinding {
  return {
    code: "unresolved-ref",
    statement: name,
    message: `Reference "${name}" is used but never defined as a top-level statement. Add "${name} = ..." somewhere in the program.`,
    hint: 'Every identifier referenced inside a component must be assigned at the top level, e.g. `header = CardHeader("Title")` before use.',
  };
}

function orphanedToFinding(name: string): LintFinding {
  return {
    code: "orphan-statement",
    statement: name,
    message: `Statement "${name}" is defined but not reachable from \`root\`. It will be silently dropped at runtime.`,
    hint: "Reference it from root (or an ancestor of root), or delete the statement.",
  };
}

/**
 * Walk the materialized tree hunting for semantic issues the parser's value-
 * path validation can't catch — most notably inline `Query()` / `Mutation()`
 * inside an `Action([...])`, which goes unchecked because `materializeExpr`
 * skips reserved-call validation, and unresolved `@Run` targets.
 *
 * Returns additional findings to append to the parser's own errors.
 */
function walkSemantic(parsed: ParseResult): LintFinding[] {
  const findings: LintFinding[] = [];
  const declaredQueries = new Set(parsed.queryStatements.map((q) => q.statementId));
  const declaredMutations = new Set(parsed.mutationStatements.map((m) => m.statementId));
  // Dedupe by AST-node identity: mappedProps + args duplicate the same node,
  // so path-based dedupe would over-count. WeakSet keys on node reference.
  const flaggedNodes = new WeakSet<object>();
  const visitedNodes = new WeakSet<object>();

  const isRunLike = (name: string): boolean => name === "Run" || name === "Set" || name === "Reset";

  const describeRunArgProblem = (
    compName: "Run" | "Set" | "Reset",
    argNode: unknown,
  ): { code: string; message: string; hint: string } | null => {
    if (!argNode || typeof argNode !== "object") {
      return {
        code: "action-bad-target",
        message: `@${compName}(...) received an empty or invalid target`,
        hint: `@${compName} must reference a declared top-level identifier (or $state for @Set/@Reset).`,
      };
    }
    const n = argNode as { k?: unknown; name?: unknown };
    const k = n.k;
    if (compName === "Run") {
      // Valid: RuntimeRef (resolved at materialize) or Ref (still-unresolved at walk time — reported separately as unresolved)
      if (k === "RuntimeRef" || k === "Ref") return null;
      if (k === "Comp") {
        const inlineName = String(n.name ?? "?");
        return {
          code: "action-inline-target",
          message: `@Run(${inlineName}(...)) was passed an inline call. @Run needs a reference to a top-level declared statement.`,
          hint: `Declare \`myMutation = ${inlineName}("tool", { ... })\` at the top level, parameterize via $state, then use \`@Run(myMutation)\`.`,
        };
      }
      return {
        code: "action-bad-target",
        message: `@Run expects a reference to a declared Query or Mutation, got k="${String(k)}"`,
        hint: `Declare the target at the top level (e.g. \`refresh = Query(...)\`) and pass its name: \`@Run(refresh)\`.`,
      };
    }
    // Set / Reset: must point at a $state declaration (StateRef).
    if (k === "StateRef" || k === "Ref") return null;
    return {
      code: "action-bad-target",
      message: `@${compName} expects a $state target, got k="${String(k)}"`,
      hint: `Declare \`$myVar = ...\` at the top level and pass it: \`@${compName}($myVar${compName === "Set" ? ", newValue" : ""})\`.`,
    };
  };

  const visit = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== "object") return;
    if (visitedNodes.has(node)) return;
    visitedNodes.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], [...path, `[${i}]`]);
      return;
    }
    // Element node (rendered component) — recurse into its props
    if (isLintElementNode(node) && node.props && typeof node.props === "object") {
      for (const [key, value] of Object.entries(node.props as Record<string, unknown>)) {
        visit(value, [...path, key]);
      }
    }
    // AST node
    if (isLintAstNode(node)) {
      // Inline reserved (Query / Mutation) surviving the materialize pass means
      // it's embedded in an expression position — parser won't have flagged it.
      if (
        node.k === "Comp" &&
        (node.name === "Query" || node.name === "Mutation") &&
        !flaggedNodes.has(node)
      ) {
        flaggedNodes.add(node);
        const statementGuess = path.find(
          (seg) => typeof seg === "string" && /^[a-z][a-zA-Z0-9_]*$/.test(seg),
        );
        findings.push({
          code: "inline-reserved",
          message: `${node.name}(...) is used inline. It must be declared as a top-level statement — e.g. \`myRef = ${node.name}("tool", { ... })\` — then referenced by name.`,
          ...(statementGuess ? { statement: statementGuess } : {}),
          component: node.name,
          hint: `When the call needs per-row data, route it through $state: \`$selectedId = null; myRef = ${node.name}("tool", { params: {id: $selectedId}, ... }); Button(..., Action([@Set($selectedId, row.id), @Run(myRef)]))\`.`,
        });
      }
      // Action step calls — @Run / @Set / @Reset must have valid targets
      if (
        node.k === "Comp" &&
        typeof node.name === "string" &&
        isRunLike(node.name) &&
        !flaggedNodes.has(node)
      ) {
        flaggedNodes.add(node);
        const firstArg = Array.isArray(node.args) ? node.args[0] : undefined;
        const compName = node.name as "Run" | "Set" | "Reset";
        const problem = describeRunArgProblem(compName, firstArg);
        if (problem) {
          findings.push({
            code: problem.code,
            message: problem.message,
            component: compName,
            hint: problem.hint,
          });
        } else if (compName === "Run" && isLintAstNode(firstArg)) {
          if (firstArg.k === "Ref" && typeof firstArg.n === "string") {
            const refName = firstArg.n;
            if (!declaredQueries.has(refName) && !declaredMutations.has(refName)) {
              findings.push({
                code: "action-unknown-target",
                message: `@Run(${refName}) references "${refName}", which is not declared as a top-level Query or Mutation.`,
                component: "Run",
                statement: refName,
                hint: `Add \`${refName} = Query("tool", ...)\` or \`${refName} = Mutation("tool", ...)\` at the top level.`,
              });
            }
          }
        }
      }
      // Recurse known children
      if (Array.isArray(node.args)) visit(node.args, [...path, "args"]);
      if (Array.isArray(node.els)) visit(node.els, [...path, "els"]);
      if (Array.isArray(node.entries)) visit(node.entries, [...path, "entries"]);
      if (node.mappedProps && typeof node.mappedProps === "object") {
        for (const [key, value] of Object.entries(node.mappedProps as Record<string, unknown>)) {
          visit(value, [...path, "mappedProps", key]);
        }
      }
      if (node.then) visit(node.then, [...path, "then"]);
      if (node.otherwise) visit(node.otherwise, [...path, "otherwise"]);
      return;
    }
    // Generic fallback — recurse object keys
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (value && typeof value === "object") visit(value, [...path, key]);
    }
  };

  visit(parsed.root, ["root"]);
  return findings;
}

function summarize(findings: LintFinding[]): string {
  if (findings.length === 0) return "ok";
  return findings
    .map((f) => {
      const parts = [
        f.statement ? `[${f.statement}]` : undefined,
        f.component ? `${f.component}` : undefined,
        f.path || undefined,
        f.message,
      ].filter(Boolean);
      return parts.join(" ");
    })
    .join("\n");
}

const componentNames = COMPONENT_NAMES as string[];

/**
 * Parse the given openui-lang program and surface any fixable issues.
 *
 * Only returns issues the LLM can correct by editing the source — validation
 * errors, missing refs, and orphan statements. Streaming/incomplete states are
 * ignored because tools always pass a fully-written program.
 */
export function lintOpenUICode(code: string): LintReport {
  if (typeof code !== "string" || code.trim().length === 0) {
    return {
      ok: false,
      findings: [
        {
          code: "empty-code",
          message: "Code is empty. Provide a valid openui-lang program.",
        },
      ],
      summary: "empty",
    };
  }

  const parser = getParser();
  let errors: OpenUIError[] = [];
  let unresolved: string[] = [];
  let orphaned: string[] = [];

  let semantic: LintFinding[] = [];
  try {
    const result = parser.parse(code);
    errors = enrichErrors(result.meta.errors, LIBRARY_SCHEMA, componentNames);
    unresolved = result.meta.unresolved ?? [];
    orphaned = result.meta.orphaned ?? [];
    semantic = walkSemantic(result);
  } catch (err) {
    return {
      ok: false,
      findings: [
        {
          code: "parse-exception",
          message: err instanceof Error ? err.message : "Parser threw while reading the program",
        },
      ],
      summary: "parse-exception",
    };
  }

  const findings: LintFinding[] = [
    ...errors.map(
      (e): LintFinding => ({
        code: e.code,
        message: e.message,
        ...(e.statementId ? { statement: e.statementId } : {}),
        ...(e.component ? { component: e.component } : {}),
        ...(e.path ? { path: e.path } : {}),
        ...(e.hint ? { hint: e.hint } : {}),
      }),
    ),
    ...unresolved.map(unresolvedToFinding),
    ...orphaned.map(orphanedToFinding),
    ...semantic,
  ];

  return {
    ok: findings.length === 0,
    findings,
    summary: summarize(findings),
  };
}
