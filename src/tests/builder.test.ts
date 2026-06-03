import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGoalDagFromSpec,
  buildGoalDagFromSpecFile,
  parseGoalDagSpec,
  parseGoalDagSpecDocument,
  serializeGoalDagDocument,
  validateGoalDagJson,
  type GoalDagSpec,
} from "../index.js";

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
