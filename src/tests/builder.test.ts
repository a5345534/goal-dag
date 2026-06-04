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
  parseGoalDagSpec,
  parseGoalDagSpecDocument,
  serializeGoalDagDocument,
  validateGoalDagJson,
  type GoalDagSpec,
} from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
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

test("buildGoalDagFromSpecFile writes a parser-valid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-goal-planner-"));
  try {
    const specPath = join(dir, "spec.json");
    const outPath = join(dir, "out.dag.json");
    writeFileSync(specPath, JSON.stringify(baseSpec), "utf8");
    const document = buildGoalDagFromSpecFile(specPath, outPath);
    const onDisk = readFileSync(outPath, "utf8");
    assert.match(onDisk, /"objective": "Complete People Frappe backend remaining slices"/);
    // Independently validate the file the planner wrote.
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
  const dir = mkdtempSync(join(tmpdir(), "agent-goal-planner-"));
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
  // planner-only `risk` is guaranteed to be absent at the type level. The
  // test below also runtime-checks the value to defend against future
  // type drift.
  assert.equal(
    (document.defaults as Record<string, unknown> | undefined)?.risk,
    undefined,
    "planner-only risk must be stripped from defaults",
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
    "planner-only risk must be stripped",
  );
  assert.equal(document.nodes[0]?.risk, "high");
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

test("build-dag CLI accepts the build-dag subcommand", () => {
  // Spawn the compiled CLI the way a shell or Pi would invoke it, and
  // confirm the subcommand is consumed before flag parsing runs.
  const dir = mkdtempSync(join(tmpdir(), "agent-goal-planner-"));
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
