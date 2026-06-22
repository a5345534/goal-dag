import test from "node:test";
import assert from "node:assert/strict";
import { parseModelCatalogDocument } from "../index.js";

const validCatalog = {
  modelRouting: {
    controllerScenario: "controller",
    defaultSubagentScenario: "implementation",
    rules: [
      {
        when: { role: "controller" },
        modelScenario: "controller",
        modelClass: "controller",
      },
      {
        when: { risk: ["low", "medium"], taskType: "implementation" },
        modelScenario: "implementation",
        modelClass: "implementation",
      },
      {
        when: { taskType: "review" },
        modelScenario: "review",
        modelClass: "strict-reviewer",
      },
    ],
  },
};

test("model routing catalog parser accepts modelClass rules", () => {
  const catalog = parseModelCatalogDocument(validCatalog);
  assert.equal(catalog.modelRouting.controllerScenario, "controller");
  assert.equal(catalog.modelRouting.defaultSubagentScenario, "implementation");
  assert.equal(catalog.modelRouting.rules.length, 3);

  const scenarios = new Set(catalog.modelRouting.rules.map((rule) => rule.modelScenario));
  assert.deepEqual([...scenarios].sort(), ["controller", "implementation", "review"]);
  assert.equal(catalog.modelRouting.rules[2].modelClass, "strict-reviewer");
});

test("model routing catalog parser rejects an unknown default scenario", () => {
  assert.throws(
    () =>
      parseModelCatalogDocument({
        modelRouting: {
          defaultSubagentScenario: "missing",
          rules: [
            {
              when: { taskType: ["docs"] },
              modelScenario: "docs",
              modelClass: "implementation",
            },
          ],
        },
      }),
    /defaultSubagentScenario must reference a modelScenario used by at least one rule/,
  );
});

test("model routing catalog parser rejects legacy concrete model fields", () => {
  assert.throws(
    () =>
      parseModelCatalogDocument({
        modelRouting: {
          rules: [
            {
              when: { taskType: ["docs"] },
              modelScenario: "docs",
              model: "provider/model",
            },
          ],
        },
      }),
    /model is unsupported; use modelClass/,
  );
});

test("model routing catalog parser rejects empty when blocks", () => {
  assert.throws(
    () =>
      parseModelCatalogDocument({
        modelRouting: {
          rules: [
            {
              when: {},
              modelScenario: "docs",
              modelClass: "implementation",
            },
          ],
        },
      }),
    /modelRouting\.rules\[0\]\.when must not be empty/,
  );
});

test("model routing catalog parser rejects unsupported rule fields", () => {
  assert.throws(
    () =>
      parseModelCatalogDocument({
        modelRouting: {
          rules: [
            {
              when: { taskType: ["docs"] },
              modelScenario: "docs",
              modelClass: "implementation",
              extra: true,
            },
          ],
        },
      }),
    /modelRouting\.rules\[0\]\.extra is not supported/,
  );
});
