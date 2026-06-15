# Model catalog workflow

`goal-dag` uses a model-routing catalog so the LLM can choose models with
judgment instead of relying on hard-coded heuristics.

Default catalog:

- Package: `catalogs/pi-available-models.json`
- Project override: `.goal/model-catalog.json` (prefer this when present)
- Schema: `schemas/model-catalog.schema.json`

## Catalog shape

The catalog is advisory input for the skill, not the exact runtime
`modelRouting` block. Each rule maps task traits to a recommended scenario and
Pi model id:

```json
{
  "modelRouting": {
    "controllerScenario": "controller",
    "defaultSubagentScenario": "spark-implementation",
    "rules": [
      {
        "when": { "role": "controller" },
        "modelScenario": "controller",
        "model": "openai-codex/gpt-5.5"
      },
      {
        "when": {
          "taskType": ["isolated-patch", "small-bugfix"],
          "risk": ["low", "medium"],
          "contextTokensEstimated": "<=128000"
        },
        "modelScenario": "spark-implementation",
        "model": "openai-codex/gpt-5.3-codex-spark"
      }
    ]
  }
}
```

`when` keys are intentionally agent/LLM-facing traits. They may be richer than
the runtime's current rule matcher, so do **not** blindly copy these catalog
rules into the final DAG. Instead, use them to choose explicit per-node
`modelScenario` values, write a per-node `modelRationale`, and declare
runtime-compatible `modelRouting.scenarios`.

## Required agent behavior

Before writing the final `GoalDagSpec`, read the active model catalog and produce
a model assignment table. Include a `controller` row for the DAG controller and
one row per DAG node:

| target | risk/scope summary | chosen scenario | model | reason |
| --- | --- | --- | --- | --- |

Rules:

1. Use only models from the catalog unless the user explicitly supplies another model.
2. Evaluate rules in order and prefer the first clear match.
3. Prefer explicit per-node `modelScenario` over broad fuzzy runtime rules.
4. Declare every chosen scenario under the final DAG's `modelRouting.scenarios`.
5. Set `modelRouting.controllerScenario` to `controller` and choose the controller model by evaluating the DAG's overall risk:

   | DAG risk | controller model | when to use |
   | --- | --- | --- |
   | critical | `openai-codex/gpt-5.5` | Security-sensitive, production-migration, protected-branch, or multi-repo DAGs |
   | high | `openai-codex/gpt-5.5` | Cross-module refactors, broad audit, or high-risk implementation DAGs |
   | medium | `deepseek/deepseek-v4-pro` | Medium-risk implementation, integration, or review DAGs |
   | low | `deepseek/deepseek-v4-pro` | Docs, specs, lint-only, or narrow-scope low-risk DAGs |

6. Write the table's reason into each node's spec-only `modelRationale` so it appears in the planning trace.
7. Set `modelRouting.defaultSubagentScenario` when a safe default is clear.
8. Warn the user if a node would otherwise fall back to the current Pi session model.
9. For long-context scans, prefer the catalog's long-context scan/reasoning scenarios.
10. For critical or final-authority decisions, prefer the strongest catalog scenario.
11. For local/private work, only choose local models when risk is acceptable or user requests it.

## Model-cost sanity review

Run this review after model assignment and before writing the final `GoalDagSpec` when most leaf implementation nodes require the strongest catalog model. This is a review trigger, not a hard failure.

Check whether:

- Scan, design, or review work is mixed into implementation nodes.
- High-risk decisions can be split from low-risk implementation into separate review/audit nodes.
- Docs or tests can be split into cheaper leaf nodes.
- The whole DAG is genuinely high risk.
- A node is assigned the strongest model only because its scope is too broad.

Show a cost-tier table:

| model tier | nodes | reason | action |
| --- | --- | --- | --- |
| strongest | final-audit, schema-migration-plan | high-risk review / migration decision | keep |
| normal implementation | implement-service | bounded service work | keep |
| cheap docs/test | update-docs, add-unit-tests | low-risk leaf work | keep |

Allowed actions:

- `keep` when the stronger model is justified by node-local risk.
- `split` when a broad node is mixing work types and causing an unnecessarily expensive model choice.
- `downgrade` when a cheaper catalog model fits the node after review.
- `ask-user` when risk/cost tradeoffs are unclear.

If strong models remain justified, record the reason in `modelRationale` and in the final summary. Do not use a fixed percentage threshold as a hard gate.

## Example final runtime `modelRouting` block

After using the catalog to assign scenarios, write runtime-compatible routing in
the `GoalDagSpec`:

```json
{
  "modelRouting": {
    "scenarios": {
      "controller": {
        "model": "openai-codex/gpt-5.5",
        "description": "Dedicated DAG controller orchestration and risk decisions"
      },
      "spark-implementation": {
        "model": "openai-codex/gpt-5.3-codex-spark",
        "description": "Fast low/medium-risk implementation under 128K context"
      },
      "review": {
        "model": "deepseek/deepseek-v4-pro",
        "description": "Medium/high-risk review and audit"
      }
    },
    "controllerScenario": "controller",
    "defaultSubagentScenario": "spark-implementation"
  },
  "nodes": [
    {
      "id": "fix-lint",
      "objective": "Fix lint errors",
      "risk": "low",
      "modelScenario": "spark-implementation",
      "modelRationale": "Low-risk lint fix under 128K context"
    },
    {
      "id": "final-audit",
      "objective": "Review integration risks",
      "risk": "medium",
      "modelScenario": "review",
      "modelRationale": "Medium-risk integration review benefits from long-context reasoning"
    }
  ]
}
```
