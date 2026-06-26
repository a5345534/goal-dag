import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoalDagFromSpec, buildGoalDagFromSpecFile, buildGoalDagPlanningTrace, parseGoalDagSpec, parseGoalDagSpecDocument, serializeGoalDagDocument, serializeGoalDagPlanningTrace, validateGoalDagJson, } from "../index.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_PATH = resolve(HERE, "..", "scripts", "build-dag.js");
const baseSpec = {
    objective: "Complete People Frappe backend remaining slices",
    defaults: {
        validators: ["npm test"],
        workspaceStrategy: "native-git-worktree",
        completionGates: ["controller-validation"],
        conflicts: { modules: ["people-frappe-module"] },
    },
    nodes: [
        {
            id: "attendance-parity",
            objective: "Add attendance parity fixtures",
            outputs: ["tests/test_attendance_parity.py"],
            conflicts: { files: ["attendance"] },
        },
        {
            id: "payroll-doctypes",
            objective: "Add payroll DocTypes",
            after: ["attendance-parity"],
            validators: ["pytest"],
            risk: "medium",
        },
    ],
};
test("parseGoalDagSpec accepts a minimal spec", () => {
    const spec = parseGoalDagSpec(JSON.stringify({
        objective: "Ship three independent slices",
        nodes: [
            { id: "alpha", objective: "alpha" },
            { id: "beta", objective: "beta" },
        ],
    }));
    assert.equal(spec.objective, "Ship three independent slices");
    assert.equal(spec.nodes.length, 2);
});
test("parseGoalDagSpec rejects malformed JSON", () => {
    assert.throws(() => parseGoalDagSpec("not-json"), /Invalid goal DAG spec JSON/);
});
test("parseGoalDagSpecDocument rejects non-object roots", () => {
    assert.throws(() => parseGoalDagSpecDocument(null), /root must be an object/);
    assert.throws(() => parseGoalDagSpecDocument([]), /root must be an object/);
    assert.throws(() => parseGoalDagSpecDocument(42), /root must be an object/);
});
test("parseGoalDagSpecDocument rejects empty objective or nodes", () => {
    assert.throws(() => parseGoalDagSpecDocument({ objective: "", nodes: [{ id: "a", objective: "a" }] }), /objective/);
    assert.throws(() => parseGoalDagSpecDocument({ objective: "x", nodes: [] }), /nodes must be a non-empty array/);
});
test("parseGoalDagSpecDocument rejects version != 1", () => {
    assert.throws(() => parseGoalDagSpecDocument({
        version: 2,
        objective: "x",
        nodes: [{ id: "a", objective: "a" }],
    }), /version must be 1/);
});
test("buildGoalDagFromSpec produces a runtime-valid document", () => {
    const document = buildGoalDagFromSpec(baseSpec);
    assert.equal(document.version, 1);
    assert.equal(document.nodes.length, 2);
    // Round-trip through validateGoalDagJson as a smoke test.
    const json = serializeGoalDagDocument(document);
    const reparsed = validateGoalDagJson(json);
    assert.equal(reparsed.objective, document.objective);
});
test("buildGoalDagFromSpec passes through node kind and validation contract", () => {
    const validation = {
        profile: "code-change",
        testSpecNodeId: "write-feature-tests",
        approvedByNodeId: "review-feature-tests",
        artifactLocks: [
            {
                path: "src/feature.ts",
                sha256: "a".repeat(64),
                sourceNodeId: "write-feature-tests",
            },
        ],
        requiredEvidence: ["validators-ran"],
        diffBaseRef: "main",
        allowedPaths: ["src/**", "tests/**"],
        forbiddenPaths: ["package-lock.json", "infra/**"],
    };
    const spec = {
        objective: "x",
        nodes: [
            { id: "write-feature-tests", objective: "Write feature tests" },
            { id: "review-feature-tests", objective: "Review feature tests" },
            {
                id: "implement-feature",
                objective: "Implement feature",
                kind: "implementation",
                validation,
            },
        ],
    };
    const document = buildGoalDagFromSpec(spec);
    const node = document.nodes.find((item) => item.id === "implement-feature");
    assert.equal(node?.kind, "implementation");
    assert.deepEqual(node?.validation, validation);
    validation.requiredEvidence?.push("audit-report-present");
    if (validation.artifactLocks?.[0])
        validation.artifactLocks[0].path = "mutated.ts";
    assert.deepEqual(node?.validation?.requiredEvidence, ["validators-ran"]);
    assert.deepEqual(node?.validation?.allowedPaths, ["src/**", "tests/**"]);
    assert.deepEqual(node?.validation?.forbiddenPaths, ["package-lock.json", "infra/**"]);
    assert.equal(node?.validation?.artifactLocks?.[0]?.path, "src/feature.ts");
});
test("serializeGoalDagDocument includes kind implementation and validation contract", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            {
                id: "implement-feature",
                objective: "Implement feature",
                kind: "implementation",
                validation: {
                    profile: "code-change",
                    requiredEvidence: ["audit-report-present"],
                    diffBaseRef: "main",
                    allowedPaths: ["src/**"],
                    forbiddenPaths: ["secrets/**"],
                },
            },
        ],
    });
    const json = serializeGoalDagDocument(document);
    assert.match(json, /"kind": "implementation"/);
    assert.match(json, /"validation"/);
    const reparsed = validateGoalDagJson(json);
    assert.equal(reparsed.nodes[0]?.validation?.profile, "code-change");
    assert.deepEqual(reparsed.nodes[0]?.validation?.allowedPaths, ["src/**"]);
    assert.deepEqual(reparsed.nodes[0]?.validation?.forbiddenPaths, ["secrets/**"]);
});
test("buildGoalDagFromSpec forwards parser errors from the runtime", () => {
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        nodes: [{ id: "Bad_Id", objective: "x" }],
    }), /kebab-case/);
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            { id: "a", objective: "a", after: ["b"] },
            { id: "b", objective: "b", after: ["a"] },
        ],
    }), /cycle/);
});
test("buildGoalDagFromSpec rejects unsupported requiredEvidence tokens", () => {
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            {
                id: "implement-feature",
                objective: "Implement feature",
                validation: {
                    requiredEvidence: ["manualEvidence"],
                },
            },
        ],
    }), /unsupported value "manualEvidence"/);
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            {
                id: "implement-feature",
                objective: "Implement feature",
                validation: {
                    requiredEvidence: ["validators-ran", "custom-check"],
                },
            },
        ],
    }), /unsupported value "custom-check"/);
    // Actionable error directs author to alternatives.
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            {
                id: "implement-feature",
                objective: "Implement feature",
                validation: {
                    requiredEvidence: ["manualEvidence"],
                },
            },
        ],
    }), /validators.*auditReportPaths.*acceptanceCriteria/);
});
test("buildGoalDagFromSpec passes through all supported requiredEvidence tokens", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            {
                id: "implement-feature",
                objective: "Implement feature",
                validation: {
                    requiredEvidence: [
                        "validators-ran",
                        "locked-artifacts-unchanged",
                        "implementation-diff-present",
                        "non-test-diff-present",
                        "post-merge-validation-ran",
                        "audit-report-present",
                    ],
                },
            },
        ],
    });
    const node = document.nodes.find((n) => n.id === "implement-feature");
    assert.deepEqual(node?.validation?.requiredEvidence, [
        "validators-ran",
        "locked-artifacts-unchanged",
        "implementation-diff-present",
        "non-test-diff-present",
        "post-merge-validation-ran",
        "audit-report-present",
    ]);
});
test("buildGoalDagFromSpecFile writes a parser-valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        writeFileSync(specPath, JSON.stringify(baseSpec), "utf8");
        const document = buildGoalDagFromSpecFile(specPath, outPath);
        const onDisk = readFileSync(outPath, "utf8");
        assert.match(onDisk, /"objective": "Complete People Frappe backend remaining slices"/);
        // Independently validate the file the builder wrote.
        const reparsed = validateGoalDagJson(onDisk);
        assert.deepEqual(reparsed.nodes.map((n) => n.id), document.nodes.map((n) => n.id));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildGoalDagFromSpecFile refuses to write an invalid spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        writeFileSync(specPath, JSON.stringify({ objective: "x", nodes: [{ id: "Bad_Id", objective: "x" }] }), "utf8");
        assert.throws(() => buildGoalDagFromSpecFile(specPath, outPath), /kebab-case/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildGoalDagFromSpec flattens defaults.risk onto every node that omits risk", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: { risk: "high" },
        nodes: [
            { id: "a", objective: "a" },
            { id: "b", objective: "b" },
            { id: "c", objective: "c" },
        ],
    });
    // The runtime's GoalDagFileDefaults type does not include `risk`, so the
    // spec-only `risk` is guaranteed to be absent at the type level. The
    // test below also runtime-checks the value to defend against future
    // type drift.
    assert.equal(document.defaults?.risk, undefined, "spec-only risk must be stripped from defaults");
    for (const node of document.nodes) {
        assert.equal(node.risk, "high", `${node.id} should inherit risk=high from defaults`);
    }
});
test("buildGoalDagFromSpec lets a per-node risk override defaults.risk", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: { risk: "high" },
        nodes: [
            { id: "a", objective: "a" },
            { id: "b", objective: "b", risk: "low" },
            { id: "c", objective: "c" },
        ],
    });
    assert.equal(document.nodes[0]?.risk, "high");
    assert.equal(document.nodes[1]?.risk, "low");
    assert.equal(document.nodes[2]?.risk, "high");
});
test("buildGoalDagFromSpec omits risk on every node when neither default nor node sets it", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        nodes: [
            { id: "a", objective: "a" },
            { id: "b", objective: "b" },
        ],
    });
    for (const node of document.nodes) {
        assert.equal(node.risk, undefined);
    }
});
test("buildGoalDagFromSpec emits node workspace bindings for native-git nodes", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: { workspaceStrategy: "native-git-worktree" },
        nodes: [
            { id: "auto-bound", objective: "a" },
            {
                id: "custom-bound",
                objective: "b",
                workspace: { worktreeSlug: "custom-slug", branch: "goal/custom-bound", baseRef: "master" },
            },
        ],
    });
    assert.deepEqual(document.nodes[0]?.workspace, { worktreeSlug: "auto-bound" });
    assert.deepEqual(document.nodes[1]?.workspace, {
        worktreeSlug: "custom-slug",
        branch: "goal/custom-bound",
        baseRef: "master",
    });
});
test("buildGoalDagFromSpec emits workspace-root-relative outputs", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: { workspaceStrategy: "native-git-worktree" },
        nodes: [
            {
                id: "impl-node",
                objective: "a",
                outputs: [".worktrees/impl-node/projects/AOS/src/index.ts", "README.md"],
            },
        ],
    });
    assert.deepEqual(document.nodes[0]?.outputs, ["projects/AOS/src/index.ts", "README.md"]);
});
test("buildGoalDagFromSpec rejects expected outputs bound to another worktree", () => {
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        defaults: { workspaceStrategy: "native-git-worktree" },
        nodes: [
            {
                id: "impl-node",
                objective: "a",
                outputs: [".worktrees/other-node/projects/AOS/src/index.ts"],
            },
        ],
    }), /workspace-root-relative/);
});
test("buildGoalDagFromSpec keeps non-risk defaults fields intact when flattening risk", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: {
            risk: "high",
            completionGates: ["controller-validation", "human-confirmation"],
            validators: ["npm test"],
        },
        nodes: [{ id: "a", objective: "a" }],
    });
    assert.deepEqual(document.defaults?.completionGates, [
        "controller-validation",
        "human-confirmation",
    ]);
    assert.deepEqual(document.defaults?.validators, ["npm test"]);
    assert.equal(document.defaults?.risk, undefined, "spec-only risk must be stripped");
    assert.equal(document.nodes[0]?.risk, "high");
});
test("buildGoalDagFromSpec preserves defaults.thinkingLevel in runtime DAG", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: { thinkingLevel: "high" },
        nodes: [{ id: "a", objective: "a" }],
    });
    assert.equal(document.defaults?.thinkingLevel, "high");
    assert.equal(validateGoalDagJson(serializeGoalDagDocument(document)).defaults?.thinkingLevel, "high");
});
test("buildGoalDagFromSpec keeps node thinkingLevel overrides alongside defaults", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        defaults: { thinkingLevel: "medium" },
        nodes: [
            { id: "a", objective: "a" },
            { id: "b", objective: "b", thinkingLevel: "xhigh" },
        ],
    });
    assert.equal(document.defaults?.thinkingLevel, "medium");
    assert.equal(document.nodes[0]?.thinkingLevel, undefined);
    assert.equal(document.nodes[1]?.thinkingLevel, "xhigh");
    const json = serializeGoalDagDocument(document);
    assert.match(json, /"thinkingLevel": "medium"/);
    assert.match(json, /"thinkingLevel": "xhigh"/);
});
test("buildGoalDagFromSpec preserves defaults and node qualityProfiles in runtime DAG", () => {
    const document = buildGoalDagFromSpec({
        objective: "quality profile contract",
        defaults: { qualityProfiles: ["incremental-implementation", "test-driven-change"] },
        nodes: [
            { id: "a", objective: "a" },
            { id: "b", objective: "b", qualityProfiles: ["code-review-required"] },
        ],
    });
    assert.deepEqual(document.defaults?.qualityProfiles, ["incremental-implementation", "test-driven-change"]);
    assert.equal(document.nodes[0]?.qualityProfiles, undefined);
    assert.deepEqual(document.nodes[1]?.qualityProfiles, ["code-review-required"]);
    const parsed = validateGoalDagJson(serializeGoalDagDocument(document));
    assert.deepEqual(parsed.defaults?.qualityProfiles, ["incremental-implementation", "test-driven-change"]);
    assert.deepEqual(parsed.nodes[1]?.qualityProfiles, ["code-review-required"]);
});
test("buildGoalDagFromSpec rejects unsupported qualityProfiles through the runtime parser", () => {
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        defaults: { qualityProfiles: ["unsupported-profile"] },
        nodes: [{ id: "a", objective: "a" }],
    }), /quality profile/);
});
test("buildGoalDagFromSpec preserves the user's actual common-module audit use case", () => {
    // Mirrors the real follow-up-plan.spec.json: defaults.risk=high, 11
    // nodes inherit, 1 node overrides with risk=low.
    const document = buildGoalDagFromSpec({
        objective: "common-module boundaries",
        defaults: {
            risk: "high",
            completionGates: ["controller-validation", "human-confirmation"],
        },
        nodes: [
            { id: "move-a", objective: "a" },
            { id: "move-b", objective: "b" },
            { id: "move-c", objective: "c" },
            { id: "move-d", objective: "d" },
            { id: "move-e", objective: "e" },
            { id: "move-f", objective: "f" },
            { id: "move-g", objective: "g" },
            { id: "move-h", objective: "h" },
            { id: "spec-a", objective: "a" },
            { id: "spec-b", objective: "b" },
            { id: "lint-hook", objective: "a" },
            {
                id: "final-audit",
                objective: "audit",
                after: ["move-a", "move-b", "move-c", "move-d", "move-e", "move-f", "move-g", "move-h"],
                risk: "low",
            },
        ],
    });
    assert.equal(document.defaults?.risk, undefined);
    for (const node of document.nodes) {
        if (node.id === "final-audit") {
            assert.equal(node.risk, "low");
        }
        else {
            assert.equal(node.risk, "high", `${node.id} should inherit risk=high`);
        }
    }
});
test("parseGoalDagSpecDocument rejects invalid defaults.risk values", () => {
    assert.throws(() => parseGoalDagSpecDocument({
        objective: "x",
        defaults: { risk: "huge" },
        nodes: [{ id: "a", objective: "a" }],
    }), /defaults.risk must be one of low, medium, high/);
});
test("parseGoalDagSpecDocument accepts valid defaults.risk values", () => {
    for (const risk of ["low", "medium", "high"]) {
        const spec = parseGoalDagSpecDocument({
            objective: "x",
            defaults: { risk },
            nodes: [{ id: "a", objective: "a" }],
        });
        assert.equal(spec.defaults?.risk, risk);
    }
});
test("buildGoalDagFromSpec strips spec-only planning metadata from runtime DAG output", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        openQuestions: ["a: Confirm expected acceptance criteria"],
        modelRouting: {
            scenarios: {
                implementation: { modelClass: "implementation" },
            },
            defaultSubagentScenario: "implementation",
        },
        nodes: [
            {
                id: "a",
                objective: "a",
                consumes: ["input reviewed"],
                produces: ["implementation complete"],
                evidence: [{ id: "ev-a", source: "prd.md#A", quote: "Do A first" }],
                modelScenario: "implementation",
                modelRationale: "Low-risk implementation under 128K context",
                acceptanceCriteria: ["implementation complete"],
                decompositionRationale: "Single bounded implementation node",
            },
        ],
    });
    const json = serializeGoalDagDocument(document);
    assert.doesNotMatch(json, /openQuestions|consumes|produces|evidence|modelRationale|acceptanceCriteria|decompositionRationale|ev-a/);
    assert.equal(validateGoalDagJson(json).nodes[0]?.id, "a");
});
test("buildGoalDagPlanningTrace records evidence transitions dependencies and model classes", () => {
    const spec = {
        objective: "Ship traceable DAG",
        openQuestions: ["Confirm final validator command"],
        modelRouting: {
            scenarios: {
                docs: { modelClass: "implementation", description: "Fast docs/spec work" },
                review: { modelClass: "strict-reviewer", description: "Review work" },
            },
            defaultSubagentScenario: "docs",
        },
        nodes: [
            {
                id: "write-spec",
                objective: "Write spec",
                produces: ["spec drafted"],
                evidence: ["PRD requests a spec"],
                modelScenario: "docs",
                modelRationale: "Docs-only low-risk node",
            },
            {
                id: "review-spec",
                objective: "Review spec",
                after: ["write-spec"],
                consumes: ["spec drafted"],
                produces: ["spec reviewed"],
                evidence: [{ id: "review-evidence", source: "design.md#review", quote: "Review after draft" }],
                modelScenario: "review",
            },
        ],
    };
    const trace = buildGoalDagPlanningTrace(spec);
    assert.equal(trace.version, 1);
    assert.equal(trace.evidence.length, 2);
    assert.deepEqual(trace.transitions[1], {
        nodeId: "review-spec",
        consumes: ["spec drafted"],
        produces: ["spec reviewed"],
        evidence: ["review-evidence"],
    });
    assert.match(trace.dependencyReview[1]?.whyNotParallel ?? "", /Depends on write-spec/);
    assert.equal(trace.modelAssignments[0]?.modelClass, "implementation");
    assert.equal(trace.modelAssignments[1]?.modelClass, "strict-reviewer");
    assert.deepEqual(trace.openQuestions, ["Confirm final validator command"]);
    assert.doesNotThrow(() => JSON.parse(serializeGoalDagPlanningTrace(trace)));
});
test("buildGoalDagPlanningTrace records node quality with acceptance handles", () => {
    const spec = {
        objective: "x",
        nodes: [
            {
                id: "a",
                objective: "a",
                outputs: ["file.ts"],
                decompositionRationale: "Single bounded module, independently testable",
            },
            {
                id: "b",
                objective: "b",
                acceptanceCriteria: ["Should produce a valid config file", "Should pass lint"],
            },
            {
                id: "c",
                objective: "c",
                validators: ["npm test"],
            },
        ],
    };
    const trace = buildGoalDagPlanningTrace(spec);
    assert.deepEqual(trace.nodeQuality[0], {
        nodeId: "a",
        acceptanceCriteria: [],
        decompositionRationale: "Single bounded module, independently testable",
    });
    assert.deepEqual(trace.nodeQuality[1], {
        nodeId: "b",
        acceptanceCriteria: ["Should produce a valid config file", "Should pass lint"],
    });
    assert.deepEqual(trace.nodeQuality[2], {
        nodeId: "c",
        acceptanceCriteria: [],
    });
});
test("buildGoalDagPlanningTrace warns on missing acceptance handle", () => {
    const spec = {
        objective: "x",
        nodes: [{ id: "a", objective: "a" }],
    };
    const trace = buildGoalDagPlanningTrace(spec);
    const acceptanceWarning = trace.warnings.find((w) => w.includes("No acceptance handle"));
    assert.ok(acceptanceWarning, "expected acceptance handle warning");
    assert.equal(trace.nodeQuality[0]?.warnings?.length, 1);
});
test("buildGoalDagPlanningTrace treats only node-prefixed openQuestions as acceptance handles", () => {
    const unprefixedTrace = buildGoalDagPlanningTrace({
        objective: "x",
        openQuestions: ["Confirm expected acceptance criteria"],
        nodes: [{ id: "a", objective: "a" }],
    });
    assert.ok(unprefixedTrace.nodeQuality[0]?.warnings?.some((warning) => warning.includes("No acceptance handle")), "unprefixed root openQuestions should not satisfy node acceptance");
    const prefixedTrace = buildGoalDagPlanningTrace({
        objective: "x",
        openQuestions: ["a: Confirm expected acceptance criteria"],
        nodes: [{ id: "a", objective: "a" }],
    });
    assert.equal(prefixedTrace.nodeQuality[0]?.warnings, undefined);
});
test("buildGoalDagFromSpec strips acceptance criteria from runtime DAG output", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
            scenarios: {
                implementation: { modelClass: "implementation" },
            },
            defaultSubagentScenario: "implementation",
        },
        nodes: [
            {
                id: "a",
                objective: "a",
                modelScenario: "implementation",
                acceptanceCriteria: ["Should compile", "Should pass tests"],
                decompositionRationale: "Bounded module work",
            },
        ],
    });
    const json = serializeGoalDagDocument(document);
    assert.doesNotMatch(json, /acceptanceCriteria|decompositionRationale/);
    assert.equal(validateGoalDagJson(json).nodes[0]?.id, "a");
});
test("build-dag CLI writes nodeQuality in planning trace with --trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        const tracePath = join(dir, "out.trace.json");
        writeFileSync(specPath, JSON.stringify({
            objective: "x",
            nodes: [
                {
                    id: "a",
                    objective: "a",
                    acceptanceCriteria: ["Should work"],
                },
            ],
        }), "utf8");
        const result = spawnSync(process.execPath, [CLI_PATH, "build-dag", "--spec", specPath, "--out", outPath, "--trace", tracePath], { encoding: "utf8" });
        assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
        const trace = JSON.parse(readFileSync(tracePath, "utf8"));
        assert.equal(trace.nodeQuality[0].nodeId, "a");
        assert.deepEqual(trace.nodeQuality[0].acceptanceCriteria, ["Should work"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("parseGoalDagSpecDocument rejects invalid planning metadata", () => {
    assert.throws(() => parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", consumes: [""] }],
    }), /nodes\[0\]\.consumes\[0\] must be a non-empty string/);
    assert.throws(() => parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", evidence: [42] }],
    }), /nodes\[0\]\.evidence\[0\] must be a string or object/);
    assert.throws(() => parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", acceptanceCriteria: [""] }],
    }), /nodes\[0\]\.acceptanceCriteria\[0\] must be a non-empty string/);
    assert.throws(() => parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", decompositionRationale: 42 }],
    }), /nodes\[0\]\.decompositionRationale must be a string when present/);
});
test("buildGoalDagFromSpecFile writes a planning trace when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        const tracePath = join(dir, "out.trace.json");
        writeFileSync(specPath, JSON.stringify({
            objective: "x",
            nodes: [
                {
                    id: "a",
                    objective: "a",
                    produces: ["a done"],
                    evidence: ["source says a"],
                },
            ],
        }), "utf8");
        buildGoalDagFromSpecFile(specPath, outPath, { tracePath });
        const trace = JSON.parse(readFileSync(tracePath, "utf8"));
        assert.equal(trace.transitions[0].nodeId, "a");
        assert.equal(trace.evidence[0].quote, "source says a");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildGoalDagFromSpec rejects invalid modelScenario through the runtime parser", () => {
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
            scenarios: {
                impl: { modelClass: "implementation" },
            },
        },
        nodes: [{ id: "a", objective: "a", modelScenario: "missing" }],
    }), /modelScenario.*missing|unknown model scenario|must reference/i);
});
test("buildGoalDagFromSpec rejects legacy concrete model fields", () => {
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
            scenarios: {
                impl: { model: "provider/model" },
            },
            defaultSubagentScenario: "impl",
        },
        nodes: [{ id: "a", objective: "a", modelScenario: "impl" }],
    }), /model is unsupported; use modelClass/);
});
test("buildGoalDagFromSpec accepts modelClass routing", () => {
    const document = buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
            scenarios: {
                controller: { modelClass: "controller" },
                spark: { modelClass: "implementation" },
            },
            controllerScenario: "controller",
            defaultSubagentScenario: "spark",
        },
        nodes: [
            { id: "a", objective: "a", modelScenario: "spark" },
            { id: "b", objective: "b", modelScenario: "spark" },
        ],
    });
    assert.equal(document.modelRouting?.scenarios?.controller?.modelClass, "controller");
    assert.equal(document.modelRouting?.scenarios?.spark?.modelClass, "implementation");
});
test("build-dag CLI accepts the build-dag subcommand", () => {
    // Spawn the compiled CLI the way a shell or Pi would invoke it, and
    // confirm the subcommand is consumed before flag parsing runs.
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        writeFileSync(specPath, JSON.stringify({
            objective: "x",
            nodes: [{ id: "a", objective: "a" }],
        }), "utf8");
        const result = spawnSync(process.execPath, [CLI_PATH, "build-dag", "--spec", specPath, "--out", outPath], { encoding: "utf8" });
        assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
        assert.match(result.stdout, /Wrote Goal DAG file/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("build-dag CLI writes planning trace with --trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        const tracePath = join(dir, "out.trace.json");
        writeFileSync(specPath, JSON.stringify({
            objective: "x",
            nodes: [{ id: "a", objective: "a", produces: ["a done"] }],
        }), "utf8");
        const result = spawnSync(process.execPath, [CLI_PATH, "build-dag", "--spec", specPath, "--out", outPath, "--trace", tracePath], { encoding: "utf8" });
        assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
        assert.match(result.stdout, /Wrote planning trace/);
        assert.equal(JSON.parse(readFileSync(tracePath, "utf8")).transitions[0].nodeId, "a");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("GoalDagSpec schema documents kind validation defaults thinking and spec-only metadata", () => {
    const schema = JSON.parse(readFileSync(resolve(REPO_ROOT, "schemas", "goal-dag-spec.schema.json"), "utf8"));
    const nodeProperties = schema.$defs.node.properties;
    const validationProperties = schema.$defs.validation.properties;
    const defaultProperties = schema.$defs.defaults.properties;
    assert.ok(nodeProperties.kind, "schema should document runtime node kind");
    assert.ok(nodeProperties.validation, "schema should document runtime validation contract");
    assert.ok(validationProperties.allowedPaths, "schema should document validation.allowedPaths");
    assert.ok(validationProperties.forbiddenPaths, "schema should document validation.forbiddenPaths");
    assert.ok(defaultProperties.thinkingLevel, "schema should document defaults.thinkingLevel");
    assert.ok(defaultProperties.qualityProfiles, "schema should document defaults.qualityProfiles");
    assert.ok(nodeProperties.qualityProfiles, "schema should document node qualityProfiles");
    assert.ok(nodeProperties.acceptanceCriteria, "schema should document spec-only acceptanceCriteria");
    assert.ok(nodeProperties.decompositionRationale, "schema should document spec-only decompositionRationale");
});
test("goal-dag skill documents OpenSpec change directory input contract", () => {
    const skill = readFileSync(resolve(REPO_ROOT, "skills", "goal-dag", "SKILL.md"), "utf8");
    assert.match(skill, /## OpenSpec Change Input Contract/);
    assert.match(skill, /Read `source-manifest\.json` first/);
    assert.match(skill, /Do not treat `change-explainer\.html` as authoritative/);
    assert.match(skill, /Do not read `\.goal-spec\/` workflow artifacts as source of truth/);
    assert.match(skill, /must not say "Create an\s+OpenSpec change"/);
});
test("valid requiredEvidence token build round-trip through serialize and re-validate", () => {
    const tokens = [
        "validators-ran",
        "locked-artifacts-unchanged",
        "implementation-diff-present",
        "non-test-diff-present",
        "post-merge-validation-ran",
        "audit-report-present",
    ];
    const spec = {
        objective: "Token round-trip",
        nodes: [
            {
                id: "token-impl",
                objective: "Implement with all evidence tokens",
                validation: { requiredEvidence: tokens },
            },
        ],
    };
    // Build validates and carves out the node
    const document = buildGoalDagFromSpec(spec);
    assert.deepEqual(document.nodes[0]?.validation?.requiredEvidence, tokens, "all supported tokens must survive the builder");
    // Serialize → re-validate round-trip
    const json = serializeGoalDagDocument(document);
    const reparsed = validateGoalDagJson(json);
    assert.deepEqual(reparsed.nodes[0]?.validation?.requiredEvidence, tokens, "round-trip through JSON must preserve every token");
    // Confirm none of the tokens are in the unsupported set
    for (const token of tokens) {
        assert.match(json, new RegExp(token.replace(/[-]/g, "\\-")), `token ${token} must appear in serialized DAG`);
    }
});
test("invalid prose evidence fails during buildGoalDagFromSpecFile before any DAG file is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
    try {
        const specPath = join(dir, "spec.json");
        const outPath = join(dir, "out.dag.json");
        writeFileSync(specPath, JSON.stringify({
            objective: "x",
            nodes: [
                {
                    id: "impl",
                    objective: "Implement",
                    validation: {
                        requiredEvidence: [
                            "Code review by senior engineer completed on 2025-06-01 with sign-off in PRD section 4.2",
                        ],
                    },
                },
            ],
        }), "utf8");
        assert.throws(() => buildGoalDagFromSpecFile(specPath, outPath), /unsupported value/, "must reject prose evidence before writing DAG");
        // Verify no DAG file was created on disk
        let fileWritten = true;
        try {
            readFileSync(outPath);
        }
        catch {
            fileWritten = false;
        }
        assert.equal(fileWritten, false, "DAG file must not be written when evidence validation fails");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("producer schema requiredEvidence enum is consistent with builder supported tokens", () => {
    const schema = JSON.parse(readFileSync(resolve(REPO_ROOT, "schemas", "goal-dag-spec.schema.json"), "utf8"));
    const enumValues = schema.$defs?.requiredEvidence?.items?.enum;
    assert.ok(Array.isArray(enumValues), "schema must define requiredEvidence enum");
    const expected = [
        "validators-ran",
        "locked-artifacts-unchanged",
        "implementation-diff-present",
        "non-test-diff-present",
        "post-merge-validation-ran",
        "audit-report-present",
    ];
    assert.deepEqual([...enumValues].sort(), [...expected].sort(), "producer schema enum must match the builder's supported evidence tokens");
    // Every supported token must be usable in a real build
    for (const token of expected) {
        const document = buildGoalDagFromSpec({
            objective: "x",
            nodes: [
                {
                    id: "impl",
                    objective: "Implement",
                    validation: { requiredEvidence: [token] },
                },
            ],
        });
        assert.deepEqual(document.nodes[0]?.validation?.requiredEvidence, [token], `token ${token} must be accepted by the builder`);
    }
    // Every schema enum value must also be accepted by the builder
    for (const token of enumValues) {
        const document = buildGoalDagFromSpec({
            objective: "x",
            nodes: [
                {
                    id: "impl",
                    objective: "Implement",
                    validation: { requiredEvidence: [token] },
                },
            ],
        });
        assert.deepEqual(document.nodes[0]?.validation?.requiredEvidence, [token], `schema enum token ${token} must be accepted by the builder`);
    }
});
test("buildGoalDagPlanningTrace preserves acceptanceCriteria and evidence exactly", () => {
    const spec = {
        objective: "Preservation test",
        nodes: [
            {
                id: "alpha",
                objective: "Alpha objective",
                acceptanceCriteria: [
                    "Must compile without errors",
                    "Must pass type-check",
                ],
                evidence: [
                    {
                        id: "ev-proof",
                        source: "design.md#L10",
                        quote: "Alpha is required for the pipeline",
                        supports: ["node:alpha"],
                    },
                ],
                decompositionRationale: "Single bounded implementation",
            },
            {
                id: "beta",
                objective: "Beta objective",
                after: ["alpha"],
                acceptanceCriteria: ["Must integrate with alpha"],
                evidence: ["Beta follows alpha per the architecture decision record"],
                produces: ["beta-artifact"],
            },
        ],
    };
    const trace = buildGoalDagPlanningTrace(spec);
    // acceptanceCriteria exactly preserved per node
    assert.deepEqual(trace.nodeQuality.find((n) => n.nodeId === "alpha")?.acceptanceCriteria, ["Must compile without errors", "Must pass type-check"]);
    assert.deepEqual(trace.nodeQuality.find((n) => n.nodeId === "beta")?.acceptanceCriteria, ["Must integrate with alpha"]);
    // decompositionRationale preserved
    assert.equal(trace.nodeQuality.find((n) => n.nodeId === "alpha")?.decompositionRationale, "Single bounded implementation");
    // Structured evidence preserved
    assert.equal(trace.evidence.length, 2, "should collect 2 evidence items");
    const evProof = trace.evidence.find((e) => e.id === "ev-proof");
    assert.ok(evProof, "ev-proof should be preserved in trace");
    assert.equal(evProof?.source, "design.md#L10");
    assert.equal(evProof?.quote, "Alpha is required for the pipeline");
    assert.deepEqual(evProof?.supports, ["node:alpha"]);
    assert.equal(evProof?.nodeId, "alpha");
    // String evidence auto-assigned an id and preserved
    const autoEv = trace.evidence.find((e) => e.quote === "Beta follows alpha per the architecture decision record");
    assert.ok(autoEv, "string evidence should be auto-assigned and preserved");
    assert.equal(autoEv?.nodeId, "beta");
    assert.match(autoEv?.id ?? "", /^ev\d+$/);
    // Evidence mapped into transitions
    assert.ok((trace.transitions.find((t) => t.nodeId === "alpha")?.evidence ?? []).includes("ev-proof"));
    assert.ok((trace.transitions.find((t) => t.nodeId === "beta")?.evidence ?? []).includes(autoEv?.id ?? ""));
    // Trace is serializable
    assert.doesNotThrow(() => JSON.parse(serializeGoalDagPlanningTrace(trace)));
});
test("runtime DAG output individually strips each trace-only field while trace preserves them", () => {
    const spec = {
        objective: "Individual strip verification",
        openQuestions: ["Q1: Confirm acceptance criteria"],
        modelRouting: {
            scenarios: {
                impl: { modelClass: "implementation" },
            },
            defaultSubagentScenario: "impl",
        },
        nodes: [
            {
                id: "impl",
                objective: "Implement",
                modelScenario: "impl",
                consumes: ["approved-spec"],
                produces: ["implementation-done"],
                evidence: [
                    { id: "ev-x", source: "spec.md#impl", quote: "Implement as specified" },
                ],
                modelRationale: "Low-risk implementation work",
                acceptanceCriteria: ["Must pass all tests", "Must pass lint"],
                decompositionRationale: "Single-node implementation scope",
            },
        ],
    };
    const document = buildGoalDagFromSpec(spec);
    const json = serializeGoalDagDocument(document);
    // Each trace-only field/key must be absent from the runtime DAG JSON
    assert.doesNotMatch(json, /"openQuestions"/);
    assert.doesNotMatch(json, /"consumes"/);
    assert.doesNotMatch(json, /"produces"/);
    assert.doesNotMatch(json, /"evidence"/);
    assert.doesNotMatch(json, /"modelRationale"/);
    assert.doesNotMatch(json, /"acceptanceCriteria"/);
    assert.doesNotMatch(json, /"decompositionRationale"/);
    // Trace-only field values must also be absent
    assert.doesNotMatch(json, /approved-spec/);
    assert.doesNotMatch(json, /implementation-done/);
    assert.doesNotMatch(json, /ev-x/);
    assert.doesNotMatch(json, /Low-risk implementation work/);
    assert.doesNotMatch(json, /Must pass all tests/);
    assert.doesNotMatch(json, /Single-node implementation scope/);
    // But runtime-required fields must be present
    assert.match(json, /"objective": "Implement"/);
    assert.match(json, /"modelScenario": "impl"/);
    // Re-validate the stripped DAG is valid
    const reparsed = validateGoalDagJson(json);
    assert.equal(reparsed.nodes[0]?.id, "impl");
    // Build trace and verify it preserves what the runtime DAG stripped
    const trace = buildGoalDagPlanningTrace(spec, document);
    assert.equal(trace.transitions[0]?.consumes[0], "approved-spec");
    assert.equal(trace.transitions[0]?.produces[0], "implementation-done");
    assert.equal(trace.evidence[0]?.id, "ev-x");
    assert.equal(trace.evidence[0]?.quote, "Implement as specified");
    assert.equal(trace.modelAssignments[0]?.reason, "Low-risk implementation work");
    assert.deepEqual(trace.nodeQuality[0]?.acceptanceCriteria, [
        "Must pass all tests",
        "Must pass lint",
    ]);
    assert.equal(trace.nodeQuality[0]?.decompositionRationale, "Single-node implementation scope");
    assert.deepEqual(trace.openQuestions, ["Q1: Confirm acceptance criteria"]);
});
test("final-verification fixture maps validators evidence and trace correctly", () => {
    const spec = {
        objective: "Ship feature X end-to-end",
        defaults: {
            validators: ["npm test"],
            workspaceStrategy: "native-git-worktree",
        },
        modelRouting: {
            scenarios: {
                implementation: {
                    modelClass: "implementation",
                },
                review: { modelClass: "strict-reviewer" },
            },
            defaultSubagentScenario: "implementation",
        },
        nodes: [
            {
                id: "write-spec",
                objective: "Write specification for feature X",
                produces: ["spec-drafted"],
                evidence: [
                    {
                        id: "spec-ev",
                        source: "prd.md#requirements",
                        quote: "Feature X requires a specification document",
                    },
                ],
                modelScenario: "implementation",
                modelRationale: "Docs-only work fits spark model",
                acceptanceCriteria: [
                    "Spec covers all PRD requirements",
                    "Spec passes markdown lint",
                ],
            },
            {
                id: "implement-x",
                objective: "Implement feature X",
                after: ["write-spec"],
                consumes: ["spec-drafted"],
                produces: ["implementation-done"],
                validators: ["npm test", "npm run lint"],
                risk: "medium",
                evidence: [
                    "PRD section 3 describes feature X requirements",
                    {
                        id: "impl-ev",
                        source: "spec.md#implementation",
                        quote: "Implement according to the specification",
                    },
                ],
                modelScenario: "implementation",
                acceptanceCriteria: [
                    "All tests pass",
                    "Code review approved",
                ],
            },
            {
                id: "review-x",
                objective: "Review feature X implementation",
                after: ["implement-x"],
                consumes: ["implementation-done"],
                produces: ["review-complete"],
                validators: ["npm run audit"],
                kind: "review",
                validation: {
                    profile: "code-change",
                    requiredEvidence: ["validators-ran", "audit-report-present"],
                    diffBaseRef: "main",
                    allowedPaths: ["src/feature-x/**"],
                    forbiddenPaths: ["infra/**", "secrets/**"],
                },
                modelScenario: "review",
                modelRationale: "Review benefits from a strict-reviewer model class",
                acceptanceCriteria: [
                    "No regressions detected",
                    "Coverage >= 80%",
                ],
                decompositionRationale: "Single review gate for feature X",
            },
        ],
    };
    // Build the runtime DAG
    const document = buildGoalDagFromSpec(spec);
    assert.equal(document.nodes.length, 3, "all three nodes must be present");
    // Validators mapped correctly to runtime DAG
    assert.deepEqual(document.defaults?.validators, ["npm test"], "default validators must survive in runtime DAG");
    assert.deepEqual(document.nodes[0]?.validators, undefined, "write-spec inherits no validators");
    assert.deepEqual(document.nodes[1]?.validators, ["npm test", "npm run lint"], "implement-x must carry its own validators");
    assert.deepEqual(document.nodes[2]?.validators, ["npm run audit"], "review-x must carry its own validators");
    // Kind and validation contract in runtime DAG
    assert.equal(document.nodes[2]?.kind, "review");
    assert.equal(document.nodes[2]?.validation?.profile, "code-change");
    assert.deepEqual(document.nodes[2]?.validation?.requiredEvidence, ["validators-ran", "audit-report-present"]);
    assert.deepEqual(document.nodes[2]?.validation?.allowedPaths, ["src/feature-x/**"]);
    assert.deepEqual(document.nodes[2]?.validation?.forbiddenPaths, ["infra/**", "secrets/**"]);
    // Evidence must be stripped from runtime DAG
    const dagJson = serializeGoalDagDocument(document);
    assert.doesNotMatch(dagJson, /"evidence"/);
    assert.doesNotMatch(dagJson, /spec-ev/);
    assert.doesNotMatch(dagJson, /PRD section 3/);
    assert.doesNotMatch(dagJson, /spec-drafted/);
    assert.doesNotMatch(dagJson, /implementation-done/);
    assert.doesNotMatch(dagJson, /review-complete/);
    // Build the trace
    const trace = buildGoalDagPlanningTrace(spec, document);
    // Evidence in trace
    assert.equal(trace.evidence.length, 3, "trace must collect 3 evidence items");
    const specEv = trace.evidence.find((e) => e.id === "spec-ev");
    assert.ok(specEv, "spec-ev must be in trace");
    assert.equal(specEv?.source, "prd.md#requirements");
    assert.equal(specEv?.nodeId, "write-spec");
    // Transitions map consumes/produces/evidence
    assert.deepEqual(trace.transitions[0]?.consumes, []);
    assert.deepEqual(trace.transitions[0]?.produces, ["spec-drafted"]);
    assert.deepEqual(trace.transitions[1]?.consumes, ["spec-drafted"]);
    assert.deepEqual(trace.transitions[1]?.produces, ["implementation-done"]);
    assert.deepEqual(trace.transitions[2]?.consumes, ["implementation-done"]);
    assert.deepEqual(trace.transitions[2]?.produces, ["review-complete"]);
    // Dependency review
    assert.match(trace.dependencyReview[1]?.whyNotParallel ?? "", /Depends on write-spec/);
    assert.match(trace.dependencyReview[2]?.whyNotParallel ?? "", /Depends on implement-x/);
    // Model assignments
    assert.equal(trace.modelAssignments[0]?.modelClass, "implementation");
    assert.equal(trace.modelAssignments[1]?.modelClass, "implementation");
    assert.equal(trace.modelAssignments[2]?.modelClass, "strict-reviewer");
    // Node quality with acceptanceCriteria
    assert.deepEqual(trace.nodeQuality[0]?.acceptanceCriteria, [
        "Spec covers all PRD requirements",
        "Spec passes markdown lint",
    ]);
    assert.deepEqual(trace.nodeQuality[1]?.acceptanceCriteria, [
        "All tests pass",
        "Code review approved",
    ]);
    assert.deepEqual(trace.nodeQuality[2]?.acceptanceCriteria, [
        "No regressions detected",
        "Coverage >= 80%",
    ]);
    assert.equal(trace.nodeQuality[2]?.decompositionRationale, "Single review gate for feature X");
    // No warnings expected for a well-formed fixture
    const fixtureWarnings = trace.warnings.filter((w) => !w.includes("No acceptance handle"));
    assert.equal(fixtureWarnings.length, 0, `unexpected trace warnings: ${fixtureWarnings.join("; ")}`);
    // Trace is serializable
    const traceJson = serializeGoalDagPlanningTrace(trace);
    assert.doesNotThrow(() => JSON.parse(traceJson));
    // Full round-trip: re-validate the runtime DAG
    const reparsed = validateGoalDagJson(dagJson);
    assert.equal(reparsed.objective, "Ship feature X end-to-end");
    assert.equal(reparsed.nodes.length, 3);
});
// ── DAG boundary purity tests ──
test("DAG JSON boundary purity: contains no concrete provider/model IDs", () => {
    // Build a rich DAG with modelClass routing, multiple node kinds,
    // validation contracts, and conflict hints.
    const spec = {
        objective: "Boundary purity fixture",
        modelRouting: {
            scenarios: {
                controller: { modelClass: "controller" },
                implementation: { modelClass: "implementation", description: "General implementation" },
                review: { modelClass: "strict-reviewer", description: "Review and audit" },
                collector: { modelClass: "evidence-collector", description: "Source collection" },
            },
            controllerScenario: "controller",
            defaultSubagentScenario: "implementation",
        },
        nodes: [
            {
                id: "collect-sources",
                objective: "Collect all source files under src/",
                modelScenario: "collector",
                modelRationale: "Source collection benefits from evidence-collector class",
                outputs: ["src/index.ts", "src/builder.ts"],
                validators: ["npm test"],
                conflicts: { files: ["src/collector.ts"] },
                risk: "low",
            },
            {
                id: "implement-feature",
                objective: "Implement feature with lint and coverage checks",
                after: ["collect-sources"],
                modelScenario: "implementation",
                kind: "implementation",
                validation: {
                    profile: "code-change",
                    requiredEvidence: ["validators-ran", "implementation-diff-present"],
                    diffBaseRef: "main",
                    allowedPaths: ["src/feature/**"],
                    forbiddenPaths: ["infra/**", "secrets/**"],
                },
                validators: ["npm run lint", "npm run coverage"],
                risk: "medium",
                thinkingLevel: "high",
            },
            {
                id: "review-feature",
                objective: "Review implemented feature for regressions",
                after: ["implement-feature"],
                modelScenario: "review",
                kind: "review",
                validation: {
                    profile: "code-change",
                    requiredEvidence: ["validators-ran", "audit-report-present"],
                    diffBaseRef: "main",
                },
                validators: ["npm run audit"],
                risk: "high",
                thinkingLevel: "xhigh",
            },
        ],
    };
    const document = buildGoalDagFromSpec(spec);
    const json = serializeGoalDagDocument(document);
    // Re-validate round-trip
    assert.doesNotThrow(() => validateGoalDagJson(json));
    // Assert: no concrete provider/model IDs appear anywhere in the JSON.
    // Concrete model IDs commonly follow the "provider/model" or
    // "provider/model:version" pattern (e.g. "openai/gpt-4o",
    // "anthropic/claude-3-opus", "google/gemini-2.5-pro").
    const concreteModelPattern = /\b(openai|anthropic|google|meta-llama|cohere|mistral|deepseek|qwen)\//;
    assert.doesNotMatch(json, concreteModelPattern, "serialized DAG JSON must not contain concrete provider/model IDs");
    // Assert: no raw "model" key in modelRouting scenarios or node-level.
    // The field must always be "modelClass", never "model".
    assert.doesNotMatch(json, /"model": "[^"]+\/[^"]+"/);
    // Assert: modelClass routing uses known abstract class ids only.
    const foundModelClasses = [...json.matchAll(/"modelClass": "([^"]+)"/g)]
        .map((m) => m[1]);
    for (const mc of foundModelClasses) {
        assert.match(mc, /^(controller|implementation|strict-reviewer|evidence-collector|value-judge|spec-writer)/, `modelClass "${mc}" must be an abstract class from the catalog, not a concrete provider/model id`);
    }
});
test("DAG JSON boundary purity: modelScenario routes to modelClass only", () => {
    // Build a spec where every node declares an explicit modelScenario
    // that maps to an abstract modelClass in modelRouting.scenarios.
    const spec = {
        objective: "modelScenario → modelClass purity",
        modelRouting: {
            scenarios: {
                spark: { modelClass: "implementation" },
                audit: { modelClass: "strict-reviewer" },
            },
            defaultSubagentScenario: "spark",
        },
        nodes: [
            {
                id: "docs-only",
                objective: "Update docs with no code changes",
                modelScenario: "spark",
                modelRationale: "Docs-only work fits lightweight implementation class",
            },
            {
                id: "high-scrutiny-review",
                objective: "Review security-sensitive schema migration",
                modelScenario: "audit",
                modelRationale: "Security review requires strict-reviewer scrutiny",
            },
            {
                id: "default-scenario-node",
                objective: "Use default subagent scenario",
                // no explicit modelScenario — inherits defaultSubagentScenario
            },
        ],
    };
    const document = buildGoalDagFromSpec(spec);
    const json = serializeGoalDagDocument(document);
    // Re-validate round-trip
    assert.doesNotThrow(() => validateGoalDagJson(json));
    // The DAG JSON must reference declared scenarios.
    assert.match(json, /"modelScenario": "spark"/);
    assert.match(json, /"modelScenario": "audit"/);
    // modelRouting.scenarios must contain only modelClass (never model).
    assert.match(json, /"modelClass": "implementation"/);
    assert.match(json, /"modelClass": "strict-reviewer"/);
    assert.doesNotMatch(json, /"scenarios":\s*\{[^}]*"model":\s*"/s, "modelRouting.scenarios must use modelClass, not concrete model");
    // Verify the document object carries modelScenario → modelClass mapping.
    for (const node of document.nodes) {
        if (node.modelScenario) {
            const scenario = spec.modelRouting.scenarios[node.modelScenario];
            assert.ok(scenario, `node ${node.id} modelScenario "${node.modelScenario}" must exist in scenarios`);
            assert.ok(scenario.modelClass, `scenario ${node.modelScenario} must have an abstract modelClass`);
        }
    }
});
test("DAG JSON boundary purity: rejects concrete model fields at every level", () => {
    // Scenario-level: model instead of modelClass.
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
            scenarios: {
                impl: { model: "openai/gpt-4o" },
            },
            defaultSubagentScenario: "impl",
        },
        nodes: [{ id: "a", objective: "a", modelScenario: "impl" }],
    }), /model is unsupported; use modelClass/, "must reject scenario-level concrete model");
    // Scenario-level: mixed model + modelClass
    assert.throws(() => buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
            scenarios: {
                impl: { modelClass: "implementation", model: "anthropic/claude-3" },
            },
            defaultSubagentScenario: "impl",
        },
        nodes: [{ id: "a", objective: "a", modelScenario: "impl" }],
    }), /model is unsupported; use modelClass/, "must reject mixed model + modelClass in scenario");
    // Catalog-level: concrete model in model-catalog rule (tested in model-catalog.test.ts)
    // DAG-level: model field on node is structurally impossible because
    // GoalDagSpecNode only accepts modelScenario, not model. This is enforced
    // by the TypeScript type and the builder's cloneNode().
    // Verify a clean DAG built with modelClass-only routing produces
    // no concrete model keys anywhere.
    const document = buildGoalDagFromSpec({
        objective: "clean",
        modelRouting: {
            scenarios: {
                impl: { modelClass: "implementation" },
            },
            defaultSubagentScenario: "impl",
        },
        nodes: [
            { id: "a", objective: "a", modelScenario: "impl" },
            { id: "b", objective: "b", modelScenario: "impl", risk: "high" },
        ],
    });
    const json = serializeGoalDagDocument(document);
    // Scan the entire serialized JSON for the string pattern "model":
    // followed by a provider/model path. This is a final safety net.
    // The only "model" keys should be in modelScenario and modelClass —
    // never a bare "model" pointing to a concrete id.
    const bareModelKeys = [...json.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(bareModelKeys.length, 0, `serialized DAG must contain zero bare "model" keys; found: ${bareModelKeys.join(", ")}`);
    // Confirm the expected routing keys are present.
    assert.match(json, /"modelClass": "implementation"/);
    assert.match(json, /"modelScenario": "impl"/);
});
//# sourceMappingURL=builder.test.js.map