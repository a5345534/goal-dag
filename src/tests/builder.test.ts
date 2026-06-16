import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGoalDagFromSpec,
  buildGoalDagFromSpecFile,
  buildGoalDagPlanningTrace,
  parseGoalDagSpec,
  parseGoalDagSpecDocument,
  serializeGoalDagDocument,
  serializeGoalDagPlanningTrace,
  validateGoalDagJson,
  type GoalDagSpec,
} from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_PATH = resolve(HERE, "..", "scripts", "build-dag.js");

const baseSpec: GoalDagSpec = {
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
  const spec = parseGoalDagSpec(
    JSON.stringify({
      objective: "Ship three independent slices",
      nodes: [
        { id: "alpha", objective: "alpha" },
        { id: "beta", objective: "beta" },
      ],
    }),
  );
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
  assert.throws(
    () => parseGoalDagSpecDocument({ objective: "", nodes: [{ id: "a", objective: "a" }] }),
    /objective/,
  );
  assert.throws(
    () => parseGoalDagSpecDocument({ objective: "x", nodes: [] }),
    /nodes must be a non-empty array/,
  );
});

test("parseGoalDagSpecDocument rejects version != 1", () => {
  assert.throws(
    () =>
      parseGoalDagSpecDocument({
        version: 2,
        objective: "x",
        nodes: [{ id: "a", objective: "a" }],
      }),
    /version must be 1/,
  );
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
  const validation: NonNullable<GoalDagSpec["nodes"][number]["validation"]> = {
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
  const spec: GoalDagSpec = {
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

  validation.requiredEvidence?.push("mutated after build");
  if (validation.artifactLocks?.[0]) validation.artifactLocks[0].path = "mutated.ts";
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
  assert.throws(
    () =>
      buildGoalDagFromSpec({
        objective: "x",
        nodes: [{ id: "Bad_Id", objective: "x" }],
      }),
    /kebab-case/,
  );

  assert.throws(
    () =>
      buildGoalDagFromSpec({
        objective: "x",
        nodes: [
          { id: "a", objective: "a", after: ["b"] },
          { id: "b", objective: "b", after: ["a"] },
        ],
      }),
    /cycle/,
  );
});

test("buildGoalDagFromSpec rejects unsupported requiredEvidence tokens", () => {
  assert.throws(
    () =>
      buildGoalDagFromSpec({
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
      }),
    /unsupported value "manualEvidence"/,
  );
  assert.throws(
    () =>
      buildGoalDagFromSpec({
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
      }),
    /unsupported value "custom-check"/,
  );
  // Actionable error directs author to alternatives.
  assert.throws(
    () =>
      buildGoalDagFromSpec({
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
      }),
    /validators.*auditReportPaths.*acceptanceCriteria/,
  );
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
    assert.deepEqual(
      reparsed.nodes.map((n) => n.id),
      document.nodes.map((n) => n.id),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGoalDagFromSpecFile refuses to write an invalid spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
  try {
    const specPath = join(dir, "spec.json");
    const outPath = join(dir, "out.dag.json");
    writeFileSync(
      specPath,
      JSON.stringify({ objective: "x", nodes: [{ id: "Bad_Id", objective: "x" }] }),
      "utf8",
    );
    assert.throws(() => buildGoalDagFromSpecFile(specPath, outPath), /kebab-case/);
  } finally {
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
  assert.equal(
    (document.defaults as Record<string, unknown> | undefined)?.risk,
    undefined,
    "spec-only risk must be stripped from defaults",
  );
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
  assert.throws(
    () =>
      buildGoalDagFromSpec({
        objective: "x",
        defaults: { workspaceStrategy: "native-git-worktree" },
        nodes: [
          {
            id: "impl-node",
            objective: "a",
            outputs: [".worktrees/other-node/projects/AOS/src/index.ts"],
          },
        ],
      }),
    /workspace-root-relative/,
  );
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
  assert.equal(
    (document.defaults as Record<string, unknown>)?.risk,
    undefined,
    "spec-only risk must be stripped",
  );
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
  assert.equal(
    (document.defaults as Record<string, unknown> | undefined)?.risk,
    undefined,
  );
  for (const node of document.nodes) {
    if (node.id === "final-audit") {
      assert.equal(node.risk, "low");
    } else {
      assert.equal(node.risk, "high", `${node.id} should inherit risk=high`);
    }
  }
});

test("parseGoalDagSpecDocument rejects invalid defaults.risk values", () => {
  assert.throws(
    () =>
      parseGoalDagSpecDocument({
        objective: "x",
        defaults: { risk: "huge" },
        nodes: [{ id: "a", objective: "a" }],
      }),
    /defaults.risk must be one of low, medium, high/,
  );
});

test("parseGoalDagSpecDocument accepts valid defaults.risk values", () => {
  for (const risk of ["low", "medium", "high"] as const) {
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
        implementation: { model: "openai-codex/gpt-5.3-codex-spark" },
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
  assert.doesNotMatch(
    json,
    /openQuestions|consumes|produces|evidence|modelRationale|acceptanceCriteria|decompositionRationale|ev-a/,
  );
  assert.equal(validateGoalDagJson(json).nodes[0]?.id, "a");
});

test("buildGoalDagPlanningTrace records evidence transitions dependencies and models", () => {
  const spec: GoalDagSpec = {
    objective: "Ship traceable DAG",
    openQuestions: ["Confirm final validator command"],
    modelRouting: {
      scenarios: {
        docs: { model: "openai-codex/gpt-5.3-codex-spark", description: "Fast docs/spec work" },
        review: { model: "deepseek/deepseek-v4-pro", description: "Review work" },
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
  assert.equal(trace.modelAssignments[0]?.model, "openai-codex/gpt-5.3-codex-spark");
  assert.equal(trace.modelAssignments[1]?.model, "deepseek/deepseek-v4-pro");
  assert.deepEqual(trace.openQuestions, ["Confirm final validator command"]);
  assert.doesNotThrow(() => JSON.parse(serializeGoalDagPlanningTrace(trace)));
});

test("buildGoalDagPlanningTrace records node quality with acceptance handles", () => {
  const spec: GoalDagSpec = {
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
  const spec: GoalDagSpec = {
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
  assert.ok(
    unprefixedTrace.nodeQuality[0]?.warnings?.some((warning) => warning.includes("No acceptance handle")),
    "unprefixed root openQuestions should not satisfy node acceptance",
  );

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
        implementation: { model: "openai-codex/gpt-5.3-codex-spark" },
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
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: "x",
        nodes: [
          {
            id: "a",
            objective: "a",
            acceptanceCriteria: ["Should work"],
          },
        ],
      }),
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build-dag", "--spec", specPath, "--out", outPath, "--trace", tracePath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(trace.nodeQuality[0].nodeId, "a");
    assert.deepEqual(trace.nodeQuality[0].acceptanceCriteria, ["Should work"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseGoalDagSpecDocument rejects invalid planning metadata", () => {
  assert.throws(
    () =>
      parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", consumes: [""] }],
      }),
    /nodes\[0\]\.consumes\[0\] must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", evidence: [42] }],
      }),
    /nodes\[0\]\.evidence\[0\] must be a string or object/,
  );
  assert.throws(
    () =>
      parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", acceptanceCriteria: [""] }],
      }),
    /nodes\[0\]\.acceptanceCriteria\[0\] must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseGoalDagSpecDocument({
        objective: "x",
        nodes: [{ id: "a", objective: "a", decompositionRationale: 42 }],
      }),
    /nodes\[0\]\.decompositionRationale must be a string when present/,
  );
});

test("buildGoalDagFromSpecFile writes a planning trace when requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
  try {
    const specPath = join(dir, "spec.json");
    const outPath = join(dir, "out.dag.json");
    const tracePath = join(dir, "out.trace.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: "x",
        nodes: [
          {
            id: "a",
            objective: "a",
            produces: ["a done"],
            evidence: ["source says a"],
          },
        ],
      }),
      "utf8",
    );
    buildGoalDagFromSpecFile(specPath, outPath, { tracePath });
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(trace.transitions[0].nodeId, "a");
    assert.equal(trace.evidence[0].quote, "source says a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGoalDagFromSpec rejects invalid modelScenario through the runtime parser", () => {
  assert.throws(
    () =>
      buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
          scenarios: {
            impl: { model: "openai-codex/gpt-5.3-codex-spark" },
          },
        },
        nodes: [{ id: "a", objective: "a", modelScenario: "missing" }],
      }),
    /modelScenario.*missing|unknown model scenario|must reference/i,
  );
});

test("buildGoalDagFromSpec rejects dot-separated model IDs", () => {
  assert.throws(
    () =>
      buildGoalDagFromSpec({
        objective: "x",
        modelRouting: {
          scenarios: {
            impl: { model: "openai-codex.gpt-5.5" },
          },
          defaultSubagentScenario: "impl",
        },
        nodes: [{ id: "a", objective: "a", modelScenario: "impl" }],
      }),
    /canonical provider\/model format/,
  );
});

test("buildGoalDagFromSpec accepts slash-separated model IDs", () => {
  const document = buildGoalDagFromSpec({
    objective: "x",
    modelRouting: {
      scenarios: {
        controller: { model: "openai-codex/gpt-5.5" },
        spark: { model: "openai-codex/gpt-5.3-codex-spark" },
      },
      controllerScenario: "controller",
      defaultSubagentScenario: "spark",
    },
    nodes: [
      { id: "a", objective: "a", modelScenario: "spark" },
      { id: "b", objective: "b", modelScenario: "spark" },
    ],
  });
  assert.equal(document.modelRouting?.scenarios?.controller?.model, "openai-codex/gpt-5.5");
  assert.equal(document.modelRouting?.scenarios?.spark?.model, "openai-codex/gpt-5.3-codex-spark");
});

test("build-dag CLI accepts the build-dag subcommand", () => {
  // Spawn the compiled CLI the way a shell or Pi would invoke it, and
  // confirm the subcommand is consumed before flag parsing runs.
  const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
  try {
    const specPath = join(dir, "spec.json");
    const outPath = join(dir, "out.dag.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: "x",
        nodes: [{ id: "a", objective: "a" }],
      }),
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build-dag", "--spec", specPath, "--out", outPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    assert.match(result.stdout, /Wrote Goal DAG file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build-dag CLI writes planning trace with --trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-dag-"));
  try {
    const specPath = join(dir, "spec.json");
    const outPath = join(dir, "out.dag.json");
    const tracePath = join(dir, "out.trace.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: "x",
        nodes: [{ id: "a", objective: "a", produces: ["a done"] }],
      }),
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build-dag", "--spec", specPath, "--out", outPath, "--trace", tracePath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    assert.match(result.stdout, /Wrote planning trace/);
    assert.equal(JSON.parse(readFileSync(tracePath, "utf8")).transitions[0].nodeId, "a");
  } finally {
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
