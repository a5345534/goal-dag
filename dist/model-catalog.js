export function parseModelCatalogContent(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Invalid model catalog JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseModelCatalogDocument(parsed);
}
export function parseModelCatalogDocument(input) {
    if (!isRecord(input))
        throw new Error("Invalid model catalog: root must be an object");
    assertKnownKeys(input, ["modelRouting"], "root");
    return { modelRouting: parseModelRouting(input.modelRouting, "modelRouting") };
}
function parseModelRouting(input, path) {
    if (!isRecord(input))
        throw new Error(`Invalid model catalog: ${path} must be an object`);
    assertKnownKeys(input, ["controllerScenario", "defaultSubagentScenario", "rules"], path);
    if (!Array.isArray(input.rules) || input.rules.length === 0) {
        throw new Error(`Invalid model catalog: ${path}.rules must be a non-empty array`);
    }
    const rules = input.rules.map((rule, index) => parseModelRoutingRule(rule, `${path}.rules[${index}]`));
    const scenarioIds = new Set(rules.map((rule) => rule.modelScenario));
    const out = { rules };
    if (input.controllerScenario !== undefined) {
        out.controllerScenario = requireNonEmptyString(input.controllerScenario, `${path}.controllerScenario`);
        assertScenarioHasRule(scenarioIds, out.controllerScenario, `${path}.controllerScenario`);
    }
    if (input.defaultSubagentScenario !== undefined) {
        out.defaultSubagentScenario = requireNonEmptyString(input.defaultSubagentScenario, `${path}.defaultSubagentScenario`);
        assertScenarioHasRule(scenarioIds, out.defaultSubagentScenario, `${path}.defaultSubagentScenario`);
    }
    return out;
}
function parseModelRoutingRule(input, path) {
    if (!isRecord(input))
        throw new Error(`Invalid model catalog: ${path} must be an object`);
    assertKnownKeys(input, ["when", "modelScenario", "modelClass"], path);
    return {
        when: parseWhen(input.when, `${path}.when`),
        modelScenario: requireNonEmptyString(input.modelScenario, `${path}.modelScenario`),
        modelClass: requireModelClass(input.modelClass, `${path}.modelClass`),
    };
}
function parseWhen(input, path) {
    if (!isRecord(input))
        throw new Error(`Invalid model catalog: ${path} must be an object`);
    const entries = Object.entries(input);
    if (entries.length === 0)
        throw new Error(`Invalid model catalog: ${path} must not be empty`);
    const out = {};
    for (const [key, value] of entries) {
        if (!key.trim())
            throw new Error(`Invalid model catalog: ${path} keys must be non-empty`);
        out[key] = parseConditionValue(value, `${path}.${key}`);
    }
    return out;
}
function parseConditionValue(input, path) {
    if (Array.isArray(input)) {
        if (input.length === 0)
            throw new Error(`Invalid model catalog: ${path} must not be an empty array`);
        return input.map((item, index) => parseConditionScalar(item, `${path}[${index}]`));
    }
    return parseConditionScalar(input, path);
}
function parseConditionScalar(input, path) {
    if (typeof input === "string")
        return requireNonEmptyString(input, path);
    if (typeof input === "number" && Number.isFinite(input))
        return input;
    if (typeof input === "boolean")
        return input;
    throw new Error(`Invalid model catalog: ${path} must be a string, number, boolean, or array of those values`);
}
function assertScenarioHasRule(scenarioIds, scenario, path) {
    if (!scenarioIds.has(scenario)) {
        throw new Error(`Invalid model catalog: ${path} must reference a modelScenario used by at least one rule`);
    }
}
function assertKnownKeys(input, allowedKeys, path) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(input)) {
        if (key === "model") {
            throw new Error(`Invalid model catalog: ${path}.model is unsupported; use modelClass`);
        }
        if (!allowed.has(key))
            throw new Error(`Invalid model catalog: ${path}.${key} is not supported`);
    }
}
function requireModelClass(input, path) {
    const value = requireNonEmptyString(input, path);
    if (!/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(value)) {
        throw new Error(`Invalid model catalog: ${path} must be a modelClass id`);
    }
    return value;
}
function requireNonEmptyString(input, path) {
    if (typeof input !== "string" || !input.trim())
        throw new Error(`Invalid model catalog: ${path} must be a non-empty string`);
    return input.trim();
}
function isRecord(input) {
    return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
//# sourceMappingURL=model-catalog.js.map