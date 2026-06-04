import { readFileSync, writeFileSync } from "node:fs";
import {
  parseGoalDagFileDocument,
  type GoalDagConflictHints,
  type GoalDagFileDefaults,
  type GoalDagFileDocument,
  type GoalDagFileNode,
  type GoalDagNode,
  type GoalModelRoutingConfig,
} from "agent-goal-runtime";

/**
 * Programmatic input to {@link buildGoalDagFromSpec}.
 *
 * Mirrors the runtime's on-disk DAG file shape, but with `version` optional
 * and without forcing the caller to pre-resolve the `GoalDagFileNode`
 * type. The runtime's `parseGoalDagFileDocument` is the source of truth
 * for shape and graph validity; this type only encodes what the planner
 * API is willing to accept.
 */
export interface GoalDagSpecNode {
  id: string;
  objective: string;
  after?: string[];
  outputs?: string[];
  validators?: string[];
  conflicts?: GoalDagConflictHints;
  scope?: string;
  workspaceStrategy?: string;
  risk?: GoalDagNode["risk"];
  completionGates?: string[];
  modelScenario?: string;
}

/**
 * Planner-side defaults.
 *
 * Accepts everything the runtime's on-disk {@link GoalDagFileDefaults}
 * accepts, plus `risk`. The planner flattens `risk` into each node that
 * does not set its own `risk` during {@link buildGoalDagFromSpec}, then
 * strips it from the emitted defaults so the resulting DAG file matches
 * the runtime's on-disk schema.
 */
export interface GoalDagSpecDefaults extends GoalDagFileDefaults {
  risk?: GoalDagNode["risk"];
}

export interface GoalDagSpec {
  /** Optional file-format version. Defaults to `1`. */
  version?: 1;
  objective: string;
  defaults?: GoalDagSpecDefaults;
  modelRouting?: GoalModelRoutingConfig;
  nodes: GoalDagSpecNode[];
}

/**
 * Parse a {@link GoalDagSpec} from a JSON string. The deep structural /
 * graph / model-scenario checks happen later in {@link buildGoalDagFromSpec}
 * when the spec is round-tripped through the runtime parser; here we just
 * confirm the shape is plumbable.
 */
export function parseGoalDagSpec(content: string): GoalDagSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid goal DAG spec JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseGoalDagSpecDocument(parsed);
}

export function parseGoalDagSpecDocument(input: unknown): GoalDagSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid goal DAG spec: root must be an object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.objective !== "string" || !record.objective.trim()) {
    throw new Error("Invalid goal DAG spec: objective must be a non-empty string");
  }
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new Error("Invalid goal DAG spec: nodes must be a non-empty array");
  }
  if (record.version !== undefined && record.version !== 1) {
    throw new Error("Invalid goal DAG spec: version must be 1 when present");
  }
  if (record.defaults && typeof record.defaults === "object" && !Array.isArray(record.defaults)) {
    const risk = (record.defaults as Record<string, unknown>).risk;
    if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high") {
      throw new Error(
        `Invalid goal DAG spec: defaults.risk must be one of low, medium, high (got ${JSON.stringify(risk)})`,
      );
    }
  }
  return record as unknown as GoalDagSpec;
}

/**
 * Build a validated {@link GoalDagFileDocument} from a spec.
 *
 * This is the producer-side counterpart to the runtime's
 * `parseGoalDagFileDocument`. We compose a draft document from the spec
 * and round-trip it through the runtime parser, which is the single
 * source of truth for id pattern, dependency existence, self-dependency,
 * cycle, and model-scenario referential-integrity rules. A failure
 * surfaces as a thrown error before the caller writes the file.
 *
 * Defaults handling: `spec.defaults.risk` is planner-only (the runtime
 * schema does not allow `risk` in defaults), so we propagate it onto
 * every node that does not set its own `risk` and strip it from the
 * emitted defaults. All other `spec.defaults` fields pass through
 * unchanged.
 */
export function buildGoalDagFromSpec(spec: GoalDagSpec): GoalDagFileDocument {
  const specDefaults = spec.defaults;
  const defaultRisk = specDefaults?.risk;
  // Runtime defaults (without the planner-only `risk` field).
  const runtimeDefaults: GoalDagFileDefaults | undefined = specDefaults
    ? cloneDefaults({
        outputs: specDefaults.outputs,
        validators: specDefaults.validators,
        workspaceStrategy: specDefaults.workspaceStrategy,
        completionGates: specDefaults.completionGates,
        conflicts: specDefaults.conflicts,
        modelScenario: specDefaults.modelScenario,
      })
    : undefined;

  const draft: GoalDagFileDocument = {
    version: spec.version ?? 1,
    objective: spec.objective,
    ...(runtimeDefaults && hasRuntimeDefaultContent(runtimeDefaults)
      ? { defaults: runtimeDefaults }
      : {}),
    ...(spec.modelRouting ? { modelRouting: cloneModelRouting(spec.modelRouting) } : {}),
    nodes: spec.nodes.map((node) => cloneNode(node, defaultRisk)),
  };
  return parseGoalDagFileDocument(draft);
}

/**
 * Convenience helper: read a spec file, build a validated document, write
 * a pretty-printed DAG JSON to disk, and return the document.
 */
export function buildGoalDagFromSpecFile(specPath: string, outPath: string): GoalDagFileDocument {
  const spec = parseGoalDagSpec(readFileSync(specPath, "utf8"));
  const document = buildGoalDagFromSpec(spec);
  writeFileSync(outPath, serializeGoalDagDocument(document), "utf8");
  return document;
}

/**
 * Serialize a {@link GoalDagFileDocument} to JSON. Pretty-printed by
 * default for human review; pass `{ pretty: false }` for compact output.
 */
export function serializeGoalDagDocument(
  document: GoalDagFileDocument,
  options: { pretty?: boolean } = {},
): string {
  return JSON.stringify(document, null, options.pretty === false ? undefined : 2);
}

/**
 * Validate a candidate JSON string as a Goal DAG document (i.e. the
 * on-disk format the runtime accepts via `/goal --dag <path>`). Useful
 * for the CLI / skill to dry-run a produced file before showing it to
 * the user.
 */
export function validateGoalDagJson(content: string): GoalDagFileDocument {
  return parseGoalDagFileDocument(JSON.parse(content) as unknown);
}

function cloneNode(node: GoalDagSpecNode, defaultRisk: GoalDagNode["risk"] | undefined): GoalDagFileNode {
  const out: GoalDagFileNode = {
    id: node.id,
    objective: node.objective,
  };
  if (node.after) out.after = [...node.after];
  if (node.outputs) out.outputs = [...node.outputs];
  if (node.validators) out.validators = [...node.validators];
  if (node.conflicts) out.conflicts = cloneConflicts(node.conflicts);
  if (node.scope !== undefined) out.scope = node.scope;
  if (node.workspaceStrategy !== undefined) out.workspaceStrategy = node.workspaceStrategy;
  if (node.risk !== undefined) out.risk = node.risk;
  else if (defaultRisk !== undefined) out.risk = defaultRisk;
  if (node.completionGates) out.completionGates = [...node.completionGates];
  if (node.modelScenario !== undefined) out.modelScenario = node.modelScenario;
  return out;
}

function hasRuntimeDefaultContent(defaults: GoalDagFileDefaults): boolean {
  return (
    defaults.outputs !== undefined ||
    defaults.validators !== undefined ||
    defaults.workspaceStrategy !== undefined ||
    defaults.completionGates !== undefined ||
    defaults.conflicts !== undefined ||
    defaults.modelScenario !== undefined
  );
}

function cloneDefaults(defaults: GoalDagFileDefaults): GoalDagFileDefaults {
  const out: GoalDagFileDefaults = {};
  if (defaults.outputs) out.outputs = [...defaults.outputs];
  if (defaults.validators) out.validators = [...defaults.validators];
  if (defaults.workspaceStrategy !== undefined) out.workspaceStrategy = defaults.workspaceStrategy;
  if (defaults.completionGates) out.completionGates = [...defaults.completionGates];
  if (defaults.conflicts) out.conflicts = cloneConflicts(defaults.conflicts);
  if (defaults.modelScenario !== undefined) out.modelScenario = defaults.modelScenario;
  return out;
}

function cloneConflicts(conflicts: GoalDagConflictHints): GoalDagConflictHints {
  const out: GoalDagConflictHints = {};
  if (conflicts.files) out.files = [...conflicts.files];
  if (conflicts.modules) out.modules = [...conflicts.modules];
  if (conflicts.capabilities) out.capabilities = [...conflicts.capabilities];
  return out;
}

function cloneModelRouting(config: GoalModelRoutingConfig): GoalModelRoutingConfig {
  const scenarios: GoalModelRoutingConfig["scenarios"] = {};
  for (const [id, scenario] of Object.entries(config.scenarios)) {
    scenarios[id] = { ...scenario };
  }
  const out: GoalModelRoutingConfig = { scenarios };
  if (config.controllerScenario) out.controllerScenario = config.controllerScenario;
  if (config.defaultSubagentScenario) out.defaultSubagentScenario = config.defaultSubagentScenario;
  if (config.rules) out.rules = config.rules.map((rule) => ({ ...rule }));
  return out;
}

// Re-export the runtime types so skill authors and the agent skill can
// import them from a single place. Keep this surface stable; the runtime
// types may grow over time. The locally-declared GoalDagSpec /
// GoalDagSpecNode are already exported above via their `export interface`
// declarations.
// Re-export the runtime types so skill authors and the agent skill can
// import them from a single place. Keep this surface stable; the runtime
// types may grow over time. The locally-declared GoalDagSpec /
// GoalDagSpecNode / GoalDagSpecDefaults are already exported above via
// their `export interface` declarations.
export type {
  GoalDagConflictHints,
  GoalDagFileDefaults,
  GoalDagFileDocument,
  GoalDagFileNode,
  GoalDagNode,
  GoalModelRoutingConfig,
};
