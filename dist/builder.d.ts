import { type GoalDagConflictHints, type GoalDagFileDefaults, type GoalDagFileDocument, type GoalDagFileNode, type GoalDagNode, type GoalModelRoutingConfig } from "agent-goal-runtime";
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
export declare function parseGoalDagSpec(content: string): GoalDagSpec;
export declare function parseGoalDagSpecDocument(input: unknown): GoalDagSpec;
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
export declare function buildGoalDagFromSpec(spec: GoalDagSpec): GoalDagFileDocument;
/**
 * Convenience helper: read a spec file, build a validated document, write
 * a pretty-printed DAG JSON to disk, and return the document.
 */
export declare function buildGoalDagFromSpecFile(specPath: string, outPath: string): GoalDagFileDocument;
/**
 * Serialize a {@link GoalDagFileDocument} to JSON. Pretty-printed by
 * default for human review; pass `{ pretty: false }` for compact output.
 */
export declare function serializeGoalDagDocument(document: GoalDagFileDocument, options?: {
    pretty?: boolean;
}): string;
/**
 * Validate a candidate JSON string as a Goal DAG document (i.e. the
 * on-disk format the runtime accepts via `/goal --dag <path>`). Useful
 * for the CLI / skill to dry-run a produced file before showing it to
 * the user.
 */
export declare function validateGoalDagJson(content: string): GoalDagFileDocument;
export type { GoalDagConflictHints, GoalDagFileDefaults, GoalDagFileDocument, GoalDagFileNode, GoalDagNode, GoalModelRoutingConfig, };
