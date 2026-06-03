# Goal DAG file format

This is a quick reference for the agent-goal-runtime DAG file. The full spec
lives at:

- Schema: <https://github.com/a5345534/agent-goal-runtime/blob/main/schemas/goal-dag.schema.json>
- User-facing format doc: <https://github.com/a5345534/agent-goal-runtime/blob/main/docs/goal-dag-format.md>

## Root fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `version` | yes | `1` | File format version. Only `1` is accepted. |
| `objective` | yes | non-empty string | The goal objective shown in status / monitor and used for the controller session. |
| `defaults` | no | object | Defaults copied to nodes that do not override them. |
| `modelRouting` | no | object | Scenario-to-model routing table used by Pi for the controller session and DAG node subagents. |
| `nodes` | yes | non-empty array (≤ 20) | Explicit DAG nodes. |

## Node fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | kebab-case string | Stable node id and slug. Must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. |
| `objective` | yes | non-empty string | Work assigned to the subagent for this node. |
| `after` | no | array of node ids | Dependencies that must be `complete` before this node can run. |
| `outputs` | no | string array | Expected files/directories checked by controller validation. |
| `validators` | no | string array | Shell validators for controller validation. |
| `conflicts` | no | object | File / module / capability conflict hints for scheduler serialization. |
| `scope` | no | string | Human-readable scope label. |
| `workspaceStrategy` | no | string | Workspace allocation strategy. Defaults to native Git worktree in Pi. |
| `risk` | no | `low` / `medium` / `high` | Risk label for scheduling / model-routing / review policy. |
| `completionGates` | no | string array | Completion gates. Defaults to `controller-validation`. |
| `modelScenario` | no | scenario id | Explicit model-routing scenario for this node. |

## Validation rules the planner must respect

- `version` must be `1`.
- `objective` is non-empty.
- `nodes` is non-empty and at most 20 entries.
- `id` is unique and kebab-case.
- `after` references existing node ids and never includes the node itself.
- The graph is acyclic.
- `modelScenario` references an entry in `modelRouting.scenarios` (when
  `modelRouting` is declared) — or `modelRouting` must declare the scenario.

`agent-goal-planner build-dag` rejects any spec that violates these rules.
The error message tells you which field; fix the spec and retry.

## Minimal example

```json
{
  "version": 1,
  "objective": "Complete People Frappe backend remaining slices",
  "nodes": [
    { "id": "attendance-parity", "objective": "Add attendance parity fixtures" },
    { "id": "payroll-doctypes", "objective": "Add payroll DocTypes" },
    {
      "id": "integration-validation",
      "objective": "Run integrated validation",
      "after": ["attendance-parity", "payroll-doctypes"]
    }
  ]
}
```

## Why no inferred sequencing

The runtime does not auto-wire `after` between nodes. If the document lists
items as bullets without ordering, leave them as parallel nodes. Only wire
`after` when the document explicitly says one step depends on another.
