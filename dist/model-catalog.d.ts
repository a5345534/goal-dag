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
export declare function parseModelCatalogContent(content: string): ModelCatalog;
export declare function parseModelCatalogDocument(input: unknown): ModelCatalog;
