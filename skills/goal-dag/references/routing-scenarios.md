# Model routing scenarios

DAGs route to abstract `modelClass` values. Concrete provider/model ids are not
valid in `modelRouting`; goal-runner resolves classes through harness bindings
and records evidence at runtime.

## Shape

```json
{
  "modelRouting": {
    "scenarios": {
      "controller":     { "modelClass": "controller" },
      "implementation": { "modelClass": "implementation" },
      "docs":           { "modelClass": "implementation" },
      "review":         { "modelClass": "strict-reviewer" }
    },
    "controllerScenario": "controller",
    "defaultSubagentScenario": "implementation",
    "rules": [
      { "scenario": "docs",   "when": { "scopes": ["docs"],   "risks": ["low"] } },
      { "scenario": "review", "when": { "objectiveIncludes": ["validate", "review", "archive"] } }
    ]
  }
}
```

## Selection order

For each node, the runtime picks a scenario in this order:

1. The node's own `modelScenario` (highest priority).
2. `defaults.modelScenario` from the spec.
3. The first matching `modelRouting.rules[]` entry.
4. `modelRouting.defaultSubagentScenario`.

If no scenario resolves, runtime must block rather than silently fall back to a
current session model.

Rule `when` supports:

- `nodeIds`
- `scopes`
- `risks` (`"low" | "medium" | "high"`)
- `modules`
- `capabilities`
- `files`
- `objectiveIncludes`
- `hasValidators`
- `hasOutputs`

## When to use a routing table

- More than three nodes with distinct work shapes (impl / docs / review /
  archive) — declare scenarios so each node can pick the right class.
- Some nodes touch high-risk areas and deserve a strict reviewer class.
- The controller should use a dedicated orchestration class while subagents use
  a different default.

## When **not** to use one

- Every node can safely use a single declared default scenario.
- The source lacks enough information to choose classes — ask the user instead
  of emitting ambiguous routing.
