# Model-class routing workflow

`goal-dag` chooses abstract `modelClass` values. It must not choose or emit
concrete provider/model ids. Concrete resolution belongs exclusively to
`goal-runner` harness bindings at runtime.

Authoritative shared catalogs live in `goal-contract`:

- Model classes: `goal-contract/catalogs/model-classes.json`
- Harness bindings: `goal-contract/catalogs/bindings/<harness>.json` (runtime only)
- Producer catalog schema: `schemas/model-catalog.schema.json`

Project-local `.goal/model-catalog.json` may provide advisory mapping rules, but
rules must point to `modelClass`, never `model`.

## Catalog shape

The catalog is advisory input for the skill, not the exact runtime
`modelRouting` block. Each rule maps task traits to a scenario and abstract
class:

```json
{
  "modelRouting": {
    "controllerScenario": "controller",
    "defaultSubagentScenario": "implementation",
    "rules": [
      {
        "when": { "role": "controller" },
        "modelScenario": "controller",
        "modelClass": "controller"
      },
      {
        "when": { "taskType": ["implementation", "small-bugfix"], "risk": ["low", "medium"] },
        "modelScenario": "implementation",
        "modelClass": "implementation"
      },
      {
        "when": { "taskType": "review" },
        "modelScenario": "review",
        "modelClass": "strict-reviewer"
      }
    ]
  }
}
```

Do **not** copy advisory rules into the final DAG. Use them to choose explicit
per-node `modelScenario` values, write `modelRationale`, and declare
runtime-compatible `modelRouting.scenarios` with `modelClass` values.

## Required agent behavior

Before writing the final `GoalDagSpec`, produce a model assignment table with a
`controller` row and one row per DAG node:

| target | risk/scope summary | chosen scenario | modelClass | reason |
| --- | --- | --- | --- | --- |

Rules:

1. Choose only model classes defined by the active class catalog unless the user explicitly supplies a new abstract class contract.
2. Never write concrete provider/model ids in a DAG, spec, trace, or producer catalog.
3. Prefer explicit per-node `modelScenario` over broad fuzzy runtime rules.
4. Declare every chosen scenario under final `modelRouting.scenarios` with `modelClass`.
5. Set `modelRouting.controllerScenario` to a scenario whose `modelClass` is `controller` unless source evidence justifies another controller class.
6. Set `modelRouting.defaultSubagentScenario` when a safe abstract default is clear; otherwise leave per-node scenarios explicit.
7. Write each row's reason into spec-only `modelRationale` so it appears in the planning trace.
8. If class choice is unclear, ask the user. Do not rely on runtime session fallback.

## Model-cost sanity review

Run this review after model assignment and before writing the final `GoalDagSpec`
when most leaf implementation nodes require high-scrutiny classes such as
`strict-reviewer` or `value-judge`.

Check whether:

- Scan, design, or review work is mixed into implementation nodes.
- High-risk decisions can be split from low-risk implementation into separate review/audit nodes.
- Docs or tests can be split into cheaper leaf nodes.
- The whole DAG is genuinely high risk.
- A node is assigned a high-scrutiny class only because its scope is too broad.

Show a cost-tier table:

| modelClass tier | nodes | reason | action |
| --- | --- | --- | --- |
| high-scrutiny | final-audit, schema-migration-plan | high-risk review / migration decision | keep |
| implementation | implement-service | bounded service work | keep |
| docs/test | update-docs, add-unit-tests | low-risk leaf work | keep |

Allowed actions:

- `keep` when the stronger class is justified by node-local risk.
- `split` when a broad node is mixing work types and causing an unnecessarily strong class choice.
- `reclassify` when a lighter class fits after review.
- `ask-user` when risk/cost tradeoffs are unclear.

## Example final runtime `modelRouting` block

```json
{
  "modelRouting": {
    "scenarios": {
      "controller": {
        "modelClass": "controller",
        "description": "Dedicated DAG controller orchestration and risk decisions"
      },
      "implementation": {
        "modelClass": "implementation",
        "description": "General bounded implementation work"
      },
      "review": {
        "modelClass": "strict-reviewer",
        "description": "Medium/high-risk review and audit"
      }
    },
    "controllerScenario": "controller",
    "defaultSubagentScenario": "implementation"
  },
  "nodes": [
    {
      "id": "fix-lint",
      "objective": "Fix lint errors",
      "risk": "low",
      "modelScenario": "implementation",
      "modelRationale": "Low-risk lint fix uses the implementation class"
    },
    {
      "id": "final-audit",
      "objective": "Review integration risks",
      "risk": "medium",
      "modelScenario": "review",
      "modelRationale": "Integration review benefits from strict-reviewer scrutiny"
    }
  ]
}
```
