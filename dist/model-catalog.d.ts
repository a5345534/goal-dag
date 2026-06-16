export type ModelRoutingConditionScalar = string | number | boolean;
export type ModelRoutingConditionValue = ModelRoutingConditionScalar | ModelRoutingConditionScalar[];
export interface ModelRoutingCatalogRule {
    when: Record<string, ModelRoutingConditionValue>;
    modelScenario: string;
    /** Canonical Pi model argument, for example "openai-codex/gpt-5.5". */
    model: string;
}
export interface ModelRoutingCatalogConfig {
    controllerScenario?: string;
    defaultSubagentScenario?: string;
    rules: ModelRoutingCatalogRule[];
}
export interface ModelCatalog {
    modelRouting: ModelRoutingCatalogConfig;
}
export declare function parseModelCatalogContent(content: string): ModelCatalog;
export declare function parseModelCatalogDocument(input: unknown): ModelCatalog;
