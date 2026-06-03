# Model routing scenarios

When different nodes in a DAG deserve different models (for example, a
"review" node benefits from a stronger reviewer model, while a "docs" node
just needs a cheap model), declare `modelRouting` in the spec.

## Shape

```json
{
  "modelRouting": {
    "scenarios": {
      "implementation": { "model": "openai-codex/gpt-5.5" },
      "docs":           { "model": "openai/gpt-5-mini" },
      "review":         { "model": "anthropic/claude-opus" }
    },
    "controllerScenario": "implementation",
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
5. The current Pi session model (fallback).

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
  archive) — declare scenarios so each node can pick the right model.
- Some nodes touch high-risk areas and deserve a stronger reviewer model.
- The user has pinned a specific model for the controller and wants
  subagents to use a different default.

## When **not** to use one

- The whole DAG uses one model — let the runtime fall back to the session
  model and skip `modelRouting` entirely.
- You're unsure which model to use for which node — start without
  `modelRouting`, finish the goal, then add a routing table on the next
  iteration.
