export type ModelRoutingConditionScalar = string | number | boolean;
export type ModelRoutingConditionValue = ModelRoutingConditionScalar | ModelRoutingConditionScalar[];

export interface ModelRoutingCatalogRule {
  when: Record<string, ModelRoutingConditionValue>;
  modelScenario: string;
  /** Abstract model class id. Concrete provider/model ids are runner binding data. */
  modelClass: string;
}

export interface ModelRoutingCatalogConfig {
  controllerScenario?: string;
  defaultSubagentScenario?: string;
  rules: ModelRoutingCatalogRule[];
}

export interface ModelCatalog {
  modelRouting: ModelRoutingCatalogConfig;
}

export function parseModelCatalogContent(content: string): ModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid model catalog JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseModelCatalogDocument(parsed);
}

export function parseModelCatalogDocument(input: unknown): ModelCatalog {
  if (!isRecord(input)) throw new Error("Invalid model catalog: root must be an object");
  assertKnownKeys(input, ["modelRouting"], "root");
  return { modelRouting: parseModelRouting(input.modelRouting, "modelRouting") };
}

function parseModelRouting(input: unknown, path: string): ModelRoutingCatalogConfig {
  if (!isRecord(input)) throw new Error(`Invalid model catalog: ${path} must be an object`);
  assertKnownKeys(input, ["controllerScenario", "defaultSubagentScenario", "rules"], path);

  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    throw new Error(`Invalid model catalog: ${path}.rules must be a non-empty array`);
  }

  const rules = input.rules.map((rule, index) => parseModelRoutingRule(rule, `${path}.rules[${index}]`));
  const scenarioIds = new Set(rules.map((rule) => rule.modelScenario));
  const out: ModelRoutingCatalogConfig = { rules };

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

function parseModelRoutingRule(input: unknown, path: string): ModelRoutingCatalogRule {
  if (!isRecord(input)) throw new Error(`Invalid model catalog: ${path} must be an object`);
  assertKnownKeys(input, ["when", "modelScenario", "modelClass"], path);
  return {
    when: parseWhen(input.when, `${path}.when`),
    modelScenario: requireNonEmptyString(input.modelScenario, `${path}.modelScenario`),
    modelClass: requireModelClass(input.modelClass, `${path}.modelClass`),
  };
}

function parseWhen(input: unknown, path: string): Record<string, ModelRoutingConditionValue> {
  if (!isRecord(input)) throw new Error(`Invalid model catalog: ${path} must be an object`);
  const entries = Object.entries(input);
  if (entries.length === 0) throw new Error(`Invalid model catalog: ${path} must not be empty`);
  const out: Record<string, ModelRoutingConditionValue> = {};
  for (const [key, value] of entries) {
    if (!key.trim()) throw new Error(`Invalid model catalog: ${path} keys must be non-empty`);
    out[key] = parseConditionValue(value, `${path}.${key}`);
  }
  return out;
}

function parseConditionValue(input: unknown, path: string): ModelRoutingConditionValue {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new Error(`Invalid model catalog: ${path} must not be an empty array`);
    return input.map((item, index) => parseConditionScalar(item, `${path}[${index}]`));
  }
  return parseConditionScalar(input, path);
}

function parseConditionScalar(input: unknown, path: string): ModelRoutingConditionScalar {
  if (typeof input === "string") return requireNonEmptyString(input, path);
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "boolean") return input;
  throw new Error(`Invalid model catalog: ${path} must be a string, number, boolean, or array of those values`);
}

function assertScenarioHasRule(scenarioIds: Set<string>, scenario: string, path: string): void {
  if (!scenarioIds.has(scenario)) {
    throw new Error(`Invalid model catalog: ${path} must reference a modelScenario used by at least one rule`);
  }
}

function assertKnownKeys(input: Record<string, unknown>, allowedKeys: string[], path: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (key === "model") {
      throw new Error(`Invalid model catalog: ${path}.model is unsupported; use modelClass`);
    }
    if (!allowed.has(key)) throw new Error(`Invalid model catalog: ${path}.${key} is not supported`);
  }
}

function requireModelClass(input: unknown, path: string): string {
  const value = requireNonEmptyString(input, path);
  if (!/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid model catalog: ${path} must be a modelClass id`);
  }
  return value;
}

function requireNonEmptyString(input: unknown, path: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`Invalid model catalog: ${path} must be a non-empty string`);
  return input.trim();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
