import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelCatalogContent, parseModelCatalogDocument } from "../index.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(HERE, "..", "..", "catalogs", "pi-available-models.json");
test("default Pi model routing catalog parses", () => {
    const catalog = parseModelCatalogContent(readFileSync(CATALOG_PATH, "utf8"));
    assert.equal(catalog.modelRouting.controllerScenario, "controller");
    assert.equal(catalog.modelRouting.defaultSubagentScenario, "spark-implementation");
    assert.equal(catalog.modelRouting.rules.length, 14);
    const scenarios = new Set(catalog.modelRouting.rules.map((rule) => rule.modelScenario));
    assert.deepEqual([...scenarios].sort(), [
        "controller",
        "critical-decision",
        "final-authority",
        "implementation",
        "local-private",
        "long-context-docs",
        "long-context-reasoning",
        "long-context-scan",
        "review",
        "spark-docs",
        "spark-implementation",
    ]);
});
test("default Pi model routing catalog contains expected model ids", () => {
    const catalog = parseModelCatalogContent(readFileSync(CATALOG_PATH, "utf8"));
    const models = new Set(catalog.modelRouting.rules.map((rule) => rule.model));
    for (const id of [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-pro",
        "local-aeon/aeon",
        "openai-codex/gpt-5.3-codex-spark",
        "openai-codex/gpt-5.5",
    ]) {
        assert.ok(models.has(id), `missing ${id}`);
    }
});
test("model routing catalog parser rejects an unknown default scenario", () => {
    assert.throws(() => parseModelCatalogDocument({
        modelRouting: {
            defaultSubagentScenario: "missing",
            rules: [
                {
                    when: { taskType: ["docs"] },
                    modelScenario: "docs",
                    model: "p/m",
                },
            ],
        },
    }), /defaultSubagentScenario must reference a modelScenario used by at least one rule/);
});
test("model routing catalog parser rejects empty when blocks", () => {
    assert.throws(() => parseModelCatalogDocument({
        modelRouting: {
            rules: [
                {
                    when: {},
                    modelScenario: "docs",
                    model: "p/m",
                },
            ],
        },
    }), /modelRouting\.rules\[0\]\.when must not be empty/);
});
test("model routing catalog parser rejects unsupported rule fields", () => {
    assert.throws(() => parseModelCatalogDocument({
        modelRouting: {
            rules: [
                {
                    when: { taskType: ["docs"] },
                    modelScenario: "docs",
                    model: "p/m",
                    extra: true,
                },
            ],
        },
    }), /modelRouting\.rules\[0\]\.extra is not supported/);
});
//# sourceMappingURL=model-catalog.test.js.map