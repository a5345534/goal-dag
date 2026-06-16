# Goal DAG file format

This is a quick reference for the Goal DAG file consumed by the Stage 3
**goal-runner** runtime via `/goal --dag <path>`. `goal-runner` exports the
parser and types that `goal-dag` round-trips through.

Full runtime references:

- Schema: <https://github.com/a5345534/goal-runner/blob/main/schemas/goal-dag.schema.json>
- User-facing format doc: <https://github.com/a5345534/goal-runner/blob/main/docs/goal-dag-format.md>

Producer-side schema reference:

- `schemas/goal-dag-spec.schema.json`

## Runtime DAG root fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `version` | yes | `1` | File format version. Only `1` is accepted. |
| `objective` | yes | non-empty string | The goal objective shown in status / monitor and used for the controller session. |
| `defaults` | no | object | Defaults copied to nodes that do not override them, including runtime fields such as `outputs`, `validators`, `workspaceStrategy`, `completionGates`, `conflicts`, `modelScenario`, and `thinkingLevel`. |
| `modelRouting` | no | object | Scenario-to-model routing table used by Pi for the controller session and DAG node subagents. |
| `nodes` | yes | non-empty array (≤ 20) | Explicit DAG nodes. |

## Runtime DAG node fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | kebab-case string | Stable node id and slug. Must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. |
| `objective` | yes | non-empty string | Work assigned to the subagent for this node. |
| `after` | no | array of node ids | Dependencies that must be `complete` before this node can run. |
| `outputs` | no | string array | Expected files/directories checked by controller validation. Must be relative to the subagent workspace root; never include `.worktrees/...`. |
| `validators` | no | string array | Shell validators for controller validation. |
| `conflicts` | no | object | File / module / capability conflict hints for scheduler serialization. |
| `scope` | no | string | Human-readable scope label. |
| `kind` | no | string | Runtime node kind, for example `implementation`, `validation`, `review`, or another kind supported by the active runner policy. |
| `validation` | no | object | Runtime validation contract, for example `profile`, `testSpecNodeId`, `approvedByNodeId`, `artifactLocks`, `requiredEvidence`, `diffBaseRef`, `auditReportPaths`, `allowedPaths`, and `forbiddenPaths`. |
| `workspaceStrategy` | no | string | Workspace allocation strategy. Defaults to native Git worktree in Pi. |
| `workspace` | no | object | Deterministic node worktree binding: `worktreeSlug`, optional `branch`, optional `baseRef`. For native-git nodes, `goal-dag` emits `worktreeSlug: <node id>` when omitted. |
| `risk` | no | `low` / `medium` / `high` | Risk label for scheduling / model-routing / review policy. |
| `completionGates` | no | string array | Completion gates. Defaults to `controller-validation`. Only use policy-specific gates that the active runtime/controller actually enforces; otherwise require manual user review outside the DAG. |
| `modelScenario` | no | scenario id | Explicit model-routing scenario for this node. |
| `thinkingLevel` | no | string | Pi thinking level for the node subagent session, when supported by the runner adapter. |

## Validation rules `goal-dag` must respect

- `version` must be `1`.
- `objective` is non-empty.
- `nodes` is non-empty and at most 20 entries.
- `id` is unique and kebab-case.
- `after` references existing node ids and never includes the node itself.
- The graph is acyclic.
- `kind` and `validation` are runtime fields and pass through from `GoalDagSpec` into the emitted DAG.
- `validation.testSpecNodeId`, `validation.approvedByNodeId`, and validation artifact-lock node ids must be kebab-case node ids when present.
- `validation.allowedPaths` / `validation.forbiddenPaths` are runtime scope-policy fields and must pass through into the emitted DAG. They are not spec-only metadata.
- `defaults.thinkingLevel` is a runtime default applied by goal-runner to nodes that do not set node-level `thinkingLevel`. It must pass through into the emitted DAG.
- `modelScenario` references an entry in `modelRouting.scenarios` (when
  `modelRouting` is declared) — or `modelRouting` must declare the scenario.
- **Model ID canonical format**: all `model` fields in `modelRouting.scenarios`
  MUST use `provider/model` (slash-separated, for example `openai-codex/gpt-5.5`).
  The `provider.model` (dot-separated) form IS REJECTED. Other agent adapters
  map from this canonical format to their native form.
- `outputs` are workspace-root-relative artifact paths. Put deterministic worktree/branch binding in `workspace`; do not put `.worktrees/<slug>/...` in outputs.

`goal-dag build-dag` rejects any spec that violates these rules.
The error message tells you which field; fix the spec and retry.

## Validation evidence tokens and field mapping

`goal-runner` uses `validation.requiredEvidence` to gate runtime completion.
`goal-dag` only passes this field through from the planning spec; it does not
interpret it.

### Supported `requiredEvidence` tokens

| Token | Meaning |
| --- | --- |
| `validators-ran` | All node `validators` (or a configured runtime subset) must run successfully. |
| `audit-report-present` | The runtime verifies required audit artifacts under `validation.auditReportPaths` are present. |

### Common source → field mappings

| Source intent | Planner fields | Required evidence / runtime interpretation |
| --- | --- | --- |
| Deterministic shell check in source text | `validators` | Pair with `validation.requiredEvidence: ["validators-ran"]` to require runtime execution status. |
| Audit artifact requirement in source text | `validation.auditReportPaths` | Pair with `validation.requiredEvidence: ["audit-report-present"]` to require path existence checks. |
| Source scope restrictions | `validation.allowedPaths`, `validation.forbiddenPaths` | No `requiredEvidence` token; the runtime enforces scope directly in validation phase. |
| Textual/prose acceptance requirement | `acceptanceCriteria` (node), `evidence` (node), optionally root `openQuestions` | Runtime reads spec artifacts; manual trace-based review happens in the planning trace. |

## Spec-only planning metadata

`GoalDagSpec` may include these producer-side fields. They are used to build the
planning trace sidecar and are stripped before runtime DAG validation:

| Field | Location | Type | Meaning |
| --- | --- | --- | --- |
| `openQuestions` | root | string array | Unresolved questions preserved in the trace sidecar. When used as a node acceptance handle, prefix the question with `<node-id>:`. |
| `consumes` | node | string array | States/artifacts the node requires before it can run. |
| `produces` | node | string array | States/artifacts the node creates for downstream nodes. |
| `evidence` | node | string or object array | Source quotes/references supporting the node or edge rationale. |
| `modelRationale` | node | string | Human-readable reason for the chosen `modelScenario`. |
| `acceptanceCriteria` | node | string array | Review-only criteria for accepting this node when deterministic validators or outputs are unavailable. |
| `decompositionRationale` | node | string | Explanation for why this node is sufficiently decomposed. |

Use `--trace <path>` to write the sidecar:

```bash
goal-dag build-dag --spec spec.json --out goal.dag.json --trace goal.trace.json
```

The runtime DAG JSON will not contain these fields. It may contain runtime fields
such as `kind`, `validation`, `thinkingLevel`, `workspace`, `completionGates`,
and `modelScenario`.

The planning trace sidecar includes a `nodeQuality` array with per-node review metadata:

```ts
interface GoalDagPlanningTraceNodeQuality {
  nodeId: string;
  acceptanceCriteria: string[];
  decompositionRationale?: string;
  warnings?: string[];
}
```

If a node has no `outputs`, `validators`, `acceptanceCriteria`, or node-prefixed `openQuestions`, the trace records this warning:

```text
No acceptance handle declared; confirm expected outputs, validators, or review criteria before execution.
```

## GoalDagSpec example with trace metadata

```json
{
  "version": 1,
  "objective": "Complete People Frappe backend remaining slices",
  "nodes": [
    {
      "id": "attendance-parity",
      "objective": "Add attendance parity fixtures",
      "workspace": { "worktreeSlug": "attendance-parity" },
      "outputs": ["tests/test_attendance_parity.py"],
      "validators": ["pytest tests/test_attendance_parity.py"],
      "validation": {
        "requiredEvidence": ["validators-ran"]
      }
    },
    {
      "id": "payroll-doctypes",
      "objective": "Add payroll DocTypes",
      "acceptanceCriteria": ["Payroll DocType changes are reviewable against the source requirement"],
      "evidence": [
        {
          "source": "prd.md#scope",
          "quote": "Payroll DocTypes should cover wage-grade and grading policy changes."
        }
      ],
      "decompositionRationale": "Single bounded DocType artifact slice"
    },
    {
      "id": "integration-validation",
      "objective": "Run integrated validation",
      "kind": "validation",
      "validation": {
        "profile": "code-change",
        "testSpecNodeId": "attendance-parity",
        "diffBaseRef": "main",
        "auditReportPaths": ["artifacts/people-frappe-audit.md"],
        "requiredEvidence": ["audit-report-present"],
        "allowedPaths": ["tests/**", "people_frappe/**"],
        "forbiddenPaths": ["package-lock.json", "infra/**"]
      },
      "after": ["attendance-parity", "payroll-doctypes"],
      "consumes": ["attendance fixtures complete", "payroll doctypes complete"],
      "produces": ["integrated validation complete"],
      "evidence": [
        {
          "source": "prd.md#validation",
          "quote": "Run integrated validation after both backend slices land."
        },
        {
          "source": "prd.md#audit",
          "quote": "Upload a short validation audit report in artifacts/."
        }
      ]
    }
  ]
}
```

## Why no inferred sequencing

The goal-runner runtime does not auto-wire `after` between nodes. If the
document lists items as bullets without ordering, leave them as parallel nodes.
Only wire `after` when the document explicitly says one step depends on another.
