import { readFileSync, writeFileSync } from "node:fs";
import { parseGoalDagFileDocument, } from "agent-goal-runtime";
/**
 * Parse a {@link GoalDagSpec} from a JSON string. The deep structural /
 * graph / model-scenario checks happen later in {@link buildGoalDagFromSpec}
 * when the spec is round-tripped through the runtime parser; here we just
 * confirm the shape is plumbable.
 */
export function parseGoalDagSpec(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Invalid goal DAG spec JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseGoalDagSpecDocument(parsed);
}
export function parseGoalDagSpecDocument(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Invalid goal DAG spec: root must be an object");
    }
    const record = input;
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
        const risk = record.defaults.risk;
        if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high") {
            throw new Error(`Invalid goal DAG spec: defaults.risk must be one of low, medium, high (got ${JSON.stringify(risk)})`);
        }
    }
    validateOptionalStringArray(record.openQuestions, "openQuestions");
    record.nodes.forEach((node, index) => validatePlanningMetadata(node, `nodes[${index}]`));
    return record;
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
 * Defaults handling: `spec.defaults.risk` is spec-only (the runtime schema
 * does not allow `risk` in defaults), so we propagate it onto every node
 * that does not set its own `risk` and strip it from the emitted defaults.
 * All other `spec.defaults` fields pass through unchanged.
 */
export function buildGoalDagFromSpec(spec) {
    const specDefaults = spec.defaults;
    const defaultRisk = specDefaults?.risk;
    const defaultWorkspaceStrategy = specDefaults?.workspaceStrategy;
    // Runtime defaults (without the spec-only `risk` field).
    const runtimeDefaults = specDefaults
        ? cloneDefaults({
            outputs: specDefaults.outputs,
            validators: specDefaults.validators,
            workspaceStrategy: specDefaults.workspaceStrategy,
            completionGates: specDefaults.completionGates,
            conflicts: specDefaults.conflicts,
            modelScenario: specDefaults.modelScenario,
        })
        : undefined;
    const draft = {
        version: spec.version ?? 1,
        objective: spec.objective,
        ...(runtimeDefaults && hasRuntimeDefaultContent(runtimeDefaults)
            ? { defaults: runtimeDefaults }
            : {}),
        ...(spec.modelRouting ? { modelRouting: cloneModelRouting(spec.modelRouting) } : {}),
        nodes: spec.nodes.map((node) => cloneNode(node, defaultRisk, defaultWorkspaceStrategy)),
    };
    assertCanonicalModelIds(draft);
    return parseGoalDagFileDocument(draft);
}
/**
 * Build a producer-side trace that explains evidence, state transitions,
 * dependencies, and model assignments. The trace is not part of the runtime
 * DAG schema and is intended for review / audit only.
 */
export function buildGoalDagPlanningTrace(spec, document = buildGoalDagFromSpec(spec)) {
    const warnings = [];
    const evidenceContext = collectEvidence(spec, warnings);
    const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
    const transitions = document.nodes.map((node) => {
        const specNode = nodesById.get(node.id);
        return {
            nodeId: node.id,
            consumes: [...(specNode?.consumes ?? [])],
            produces: [...(specNode?.produces ?? [])],
            evidence: [...(evidenceContext.byNode.get(node.id) ?? [])],
        };
    });
    const dependencyReview = document.nodes.map((node) => buildDependencyReviewRow(node.id, nodesById, evidenceContext.byNode, warnings));
    const modelAssignments = document.nodes.map((node) => buildModelAssignmentRow(node.id, spec, nodesById.get(node.id), warnings));
    const nodeQuality = document.nodes.map((node) => buildNodeQualityRow(node.id, spec, nodesById.get(node.id), warnings));
    return {
        version: 1,
        objective: document.objective,
        evidence: evidenceContext.evidence,
        transitions,
        dependencyReview,
        modelAssignments,
        nodeQuality,
        warnings,
        openQuestions: [...(spec.openQuestions ?? [])],
    };
}
/**
 * Convenience helper: read a spec file, build a validated document, write
 * a pretty-printed DAG JSON to disk, optionally write a planning trace, and
 * return the document.
 */
export function buildGoalDagFromSpecFile(specPath, outPath, options = {}) {
    const spec = parseGoalDagSpec(readFileSync(specPath, "utf8"));
    const document = buildGoalDagFromSpec(spec);
    writeFileSync(outPath, serializeGoalDagDocument(document), "utf8");
    if (options.tracePath) {
        const trace = buildGoalDagPlanningTrace(spec, document);
        writeFileSync(options.tracePath, serializeGoalDagPlanningTrace(trace), "utf8");
    }
    return document;
}
/**
 * Serialize a {@link GoalDagFileDocument} to JSON. Pretty-printed by
 * default for human review; pass `{ pretty: false }` for compact output.
 */
export function serializeGoalDagDocument(document, options = {}) {
    return JSON.stringify(document, null, options.pretty === false ? undefined : 2);
}
/** Serialize a planning trace JSON sidecar. */
export function serializeGoalDagPlanningTrace(trace, options = {}) {
    return JSON.stringify(trace, null, options.pretty === false ? undefined : 2);
}
/**
 * Validate a candidate JSON string as a Goal DAG document (i.e. the
 * on-disk format the runtime accepts via `/goal --dag <path>`). Useful
 * for the CLI / skill to dry-run a produced file before showing it to
 * the user.
 */
export function validateGoalDagJson(content) {
    return parseGoalDagFileDocument(JSON.parse(content));
}
function cloneNode(node, defaultRisk, defaultWorkspaceStrategy) {
    const out = {
        id: node.id,
        objective: node.objective,
    };
    const workspace = cloneNodeWorkspace(node.workspace) ?? defaultWorkspaceBindingForNode(node, defaultWorkspaceStrategy);
    if (node.after)
        out.after = [...node.after];
    if (node.outputs)
        out.outputs = cloneExpectedOutputs(node.id, node.outputs, workspace);
    if (node.validators)
        out.validators = [...node.validators];
    if (node.conflicts)
        out.conflicts = cloneConflicts(node.conflicts);
    if (node.scope !== undefined)
        out.scope = node.scope;
    if (node.workspaceStrategy !== undefined)
        out.workspaceStrategy = node.workspaceStrategy;
    if (workspace)
        out.workspace = workspace;
    if (node.risk !== undefined)
        out.risk = node.risk;
    else if (defaultRisk !== undefined)
        out.risk = defaultRisk;
    if (node.completionGates)
        out.completionGates = [...node.completionGates];
    if (node.modelScenario !== undefined)
        out.modelScenario = node.modelScenario;
    if (node.thinkingLevel !== undefined)
        out.thinkingLevel = node.thinkingLevel;
    return out;
}
function defaultWorkspaceBindingForNode(node, defaultWorkspaceStrategy) {
    const effectiveStrategy = node.workspaceStrategy ?? defaultWorkspaceStrategy;
    if (!effectiveStrategy?.toLowerCase().includes("native-git"))
        return undefined;
    return { worktreeSlug: node.id };
}
function cloneNodeWorkspace(workspace) {
    if (!workspace)
        return undefined;
    const out = {};
    if (workspace.worktreeSlug !== undefined)
        out.worktreeSlug = workspace.worktreeSlug;
    if (workspace.branch !== undefined)
        out.branch = workspace.branch;
    if (workspace.baseRef !== undefined)
        out.baseRef = workspace.baseRef;
    return out;
}
function cloneExpectedOutputs(nodeId, outputs, workspace) {
    return outputs.map((output) => normalizeWorkspaceRootRelativeOutput(nodeId, output, workspace));
}
function normalizeWorkspaceRootRelativeOutput(nodeId, output, workspace) {
    const normalized = output.replace(/\\/g, "/");
    const match = normalized.match(/^\.worktrees\/([^/]+)\/(.+)$/);
    if (!match)
        return output;
    const [, worktreeSlug, relativePath] = match;
    if (workspace?.worktreeSlug && worktreeSlug === workspace.worktreeSlug)
        return relativePath;
    throw new Error(`Invalid goal DAG spec: node ${nodeId} output ${JSON.stringify(output)} must be workspace-root-relative; ` +
        `put worktree binding in node.workspace instead of expected output paths`);
}
function hasRuntimeDefaultContent(defaults) {
    return (defaults.outputs !== undefined ||
        defaults.validators !== undefined ||
        defaults.workspaceStrategy !== undefined ||
        defaults.completionGates !== undefined ||
        defaults.conflicts !== undefined ||
        defaults.modelScenario !== undefined);
}
function cloneDefaults(defaults) {
    const out = {};
    if (defaults.outputs)
        out.outputs = [...defaults.outputs];
    if (defaults.validators)
        out.validators = [...defaults.validators];
    if (defaults.workspaceStrategy !== undefined)
        out.workspaceStrategy = defaults.workspaceStrategy;
    if (defaults.completionGates)
        out.completionGates = [...defaults.completionGates];
    if (defaults.conflicts)
        out.conflicts = cloneConflicts(defaults.conflicts);
    if (defaults.modelScenario !== undefined)
        out.modelScenario = defaults.modelScenario;
    return out;
}
function cloneConflicts(conflicts) {
    const out = {};
    if (conflicts.files)
        out.files = [...conflicts.files];
    if (conflicts.modules)
        out.modules = [...conflicts.modules];
    if (conflicts.capabilities)
        out.capabilities = [...conflicts.capabilities];
    return out;
}
function cloneModelRouting(config) {
    const scenarios = {};
    for (const [id, scenario] of Object.entries(config.scenarios)) {
        scenarios[id] = { ...scenario };
    }
    const out = { scenarios };
    if (config.controllerScenario)
        out.controllerScenario = config.controllerScenario;
    if (config.defaultSubagentScenario)
        out.defaultSubagentScenario = config.defaultSubagentScenario;
    if (config.rules)
        out.rules = config.rules.map((rule) => ({ ...rule }));
    return out;
}
const CANONICAL_MODEL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z][a-z0-9]*)*\/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
function assertCanonicalModelIds(draft) {
    const invalid = [];
    for (const [scenarioId, scenario] of Object.entries(draft.modelRouting?.scenarios ?? {})) {
        if (scenario.model.match(CANONICAL_MODEL_ID_PATTERN))
            continue;
        invalid.push({
            path: `modelRouting.scenarios.${scenarioId}.model`,
            value: scenario.model,
        });
    }
    if (invalid.length === 0)
        return;
    const messages = invalid.map(({ path, value }) => `  ${path}: ${JSON.stringify(value)} — expected canonical provider/model format (e.g. openai-codex/gpt-5.5), NOT provider.model`);
    throw new Error(`Invalid goal DAG spec: model IDs must use canonical provider/model format:\n` +
        messages.join("\n"));
}
function collectEvidence(spec, warnings) {
    const evidence = [];
    const byNode = new Map();
    const usedIds = new Set();
    let nextId = 1;
    for (const node of spec.nodes) {
        const nodeEvidenceIds = [];
        for (const item of node.evidence ?? []) {
            const normalized = normalizeEvidenceItem(item, node.id, () => `ev${nextId++}`);
            let id = normalized.id;
            if (usedIds.has(id)) {
                const original = id;
                id = `ev${nextId++}`;
                warnings.push(`Evidence id ${JSON.stringify(original)} is duplicated; reassigned to ${id}`);
            }
            usedIds.add(id);
            evidence.push({ ...normalized, id });
            nodeEvidenceIds.push(id);
        }
        if (nodeEvidenceIds.length > 0)
            byNode.set(node.id, nodeEvidenceIds);
    }
    return { evidence, byNode };
}
function normalizeEvidenceItem(item, nodeId, nextAutoId) {
    if (typeof item === "string") {
        return {
            id: nextAutoId(),
            nodeId,
            quote: item,
            supports: [`node:${nodeId}`],
        };
    }
    const quote = item.quote ?? item.note ?? item.source ?? `Evidence for ${nodeId}`;
    return {
        id: item.id?.trim() || nextAutoId(),
        nodeId,
        ...(item.source ? { source: item.source } : {}),
        quote,
        supports: item.supports ? [...item.supports] : [`node:${nodeId}`],
    };
}
function buildDependencyReviewRow(nodeId, nodesById, evidenceByNode, globalWarnings) {
    const node = nodesById.get(nodeId);
    const after = [...(node?.after ?? [])];
    const evidence = new Set(evidenceByNode.get(nodeId) ?? []);
    const rowWarnings = [];
    const reasons = [];
    if (!node) {
        const warning = `Trace could not find spec metadata for runtime node ${nodeId}`;
        globalWarnings.push(warning);
        return { nodeId, after, whyNotParallel: warning, evidence: [], warnings: [warning] };
    }
    if (after.length === 0) {
        const conflictSummary = formatConflictSummary(node.conflicts);
        return {
            nodeId,
            after,
            whyNotParallel: conflictSummary
                ? `No after dependencies declared; runnable in parallel with other ready nodes, subject to conflict hints (${conflictSummary}).`
                : "No after dependencies declared; runnable in parallel with other ready nodes.",
            evidence: [...evidence],
        };
    }
    for (const dependencyId of after) {
        const dependency = nodesById.get(dependencyId);
        for (const dependencyEvidenceId of evidenceByNode.get(dependencyId) ?? []) {
            evidence.add(dependencyEvidenceId);
        }
        if (!dependency) {
            rowWarnings.push(`Dependency ${dependencyId} is not present in the spec`);
            continue;
        }
        const consumedFromDependency = (node.consumes ?? []).filter((state) => (dependency.produces ?? []).includes(state));
        if (consumedFromDependency.length > 0) {
            reasons.push(`Depends on ${dependencyId} for produced state(s): ${consumedFromDependency.map((state) => JSON.stringify(state)).join(", ")}.`);
        }
        else {
            rowWarnings.push(`Dependency ${dependencyId} has no declared produced state consumed by ${nodeId}; confirm this edge is explicitly supported by source evidence.`);
        }
    }
    if (reasons.length === 0) {
        reasons.push("Dependencies are declared, but no consumes/produces state match was found in spec-only metadata.");
    }
    for (const warning of rowWarnings)
        globalWarnings.push(`${nodeId}: ${warning}`);
    return {
        nodeId,
        after,
        whyNotParallel: reasons.join(" "),
        evidence: [...evidence],
        ...(rowWarnings.length > 0 ? { warnings: rowWarnings } : {}),
    };
}
function formatConflictSummary(conflicts) {
    if (!conflicts)
        return "";
    const parts = [];
    if (conflicts.files?.length)
        parts.push(`files=${conflicts.files.join(",")}`);
    if (conflicts.modules?.length)
        parts.push(`modules=${conflicts.modules.join(",")}`);
    if (conflicts.capabilities?.length)
        parts.push(`capabilities=${conflicts.capabilities.join(",")}`);
    return parts.join("; ");
}
function buildModelAssignmentRow(nodeId, spec, node, globalWarnings) {
    const warnings = [];
    const scenario = node?.modelScenario ?? spec.defaults?.modelScenario ?? spec.modelRouting?.defaultSubagentScenario;
    if (!scenario) {
        const warning = "No explicit modelScenario, defaults.modelScenario, or defaultSubagentScenario; runtime may fall back to the current Pi session model.";
        warnings.push(warning);
        globalWarnings.push(`${nodeId}: ${warning}`);
        return {
            nodeId,
            reason: node?.modelRationale ?? "No model assignment declared.",
            warnings,
        };
    }
    const model = spec.modelRouting?.scenarios?.[scenario]?.model;
    const description = spec.modelRouting?.scenarios?.[scenario]?.description;
    if (!model) {
        const warning = `Scenario ${JSON.stringify(scenario)} is not declared in modelRouting.scenarios.`;
        warnings.push(warning);
        globalWarnings.push(`${nodeId}: ${warning}`);
    }
    return {
        nodeId,
        scenario,
        ...(model ? { model } : {}),
        reason: node?.modelRationale ?? description ?? `Uses scenario ${scenario}.`,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
function buildNodeQualityRow(nodeId, spec, node, globalWarnings) {
    const warnings = [];
    const acceptanceCriteria = [...(node?.acceptanceCriteria ?? [])];
    const hasNodeOpenQuestion = (spec.openQuestions ?? []).some((question) => question.trim().startsWith(`${nodeId}:`));
    const hasAcceptanceHandle = (node?.outputs && node.outputs.length > 0) ||
        (node?.validators && node.validators.length > 0) ||
        acceptanceCriteria.length > 0 ||
        hasNodeOpenQuestion;
    if (!hasAcceptanceHandle) {
        const warning = "No acceptance handle declared; confirm expected outputs, validators, or review criteria before execution.";
        warnings.push(warning);
        globalWarnings.push(`${nodeId}: ${warning}`);
    }
    return {
        nodeId,
        acceptanceCriteria,
        ...(node?.decompositionRationale ? { decompositionRationale: node.decompositionRationale } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
function validatePlanningMetadata(input, path) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(`Invalid goal DAG spec: ${path} must be an object`);
    }
    const record = input;
    validateOptionalStringArray(record.consumes, `${path}.consumes`);
    validateOptionalStringArray(record.produces, `${path}.produces`);
    validateEvidenceArray(record.evidence, `${path}.evidence`);
    validateOptionalStringArray(record.acceptanceCriteria, `${path}.acceptanceCriteria`);
    if (record.modelRationale !== undefined && typeof record.modelRationale !== "string") {
        throw new Error(`Invalid goal DAG spec: ${path}.modelRationale must be a string when present`);
    }
    if (record.decompositionRationale !== undefined && typeof record.decompositionRationale !== "string") {
        throw new Error(`Invalid goal DAG spec: ${path}.decompositionRationale must be a string when present`);
    }
}
function validateOptionalStringArray(input, path) {
    if (input === undefined)
        return;
    if (!Array.isArray(input))
        throw new Error(`Invalid goal DAG spec: ${path} must be an array of strings`);
    for (const [index, value] of input.entries()) {
        if (typeof value !== "string" || !value.trim()) {
            throw new Error(`Invalid goal DAG spec: ${path}[${index}] must be a non-empty string`);
        }
    }
}
function validateEvidenceArray(input, path) {
    if (input === undefined)
        return;
    if (!Array.isArray(input))
        throw new Error(`Invalid goal DAG spec: ${path} must be an array`);
    for (const [index, value] of input.entries()) {
        const itemPath = `${path}[${index}]`;
        if (typeof value === "string") {
            if (!value.trim())
                throw new Error(`Invalid goal DAG spec: ${itemPath} must be a non-empty string`);
            continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`Invalid goal DAG spec: ${itemPath} must be a string or object`);
        }
        const record = value;
        for (const key of ["id", "source", "quote", "note"]) {
            if (record[key] !== undefined && (typeof record[key] !== "string" || !record[key].trim())) {
                throw new Error(`Invalid goal DAG spec: ${itemPath}.${key} must be a non-empty string when present`);
            }
        }
        validateOptionalStringArray(record.supports, `${itemPath}.supports`);
    }
}
//# sourceMappingURL=builder.js.map