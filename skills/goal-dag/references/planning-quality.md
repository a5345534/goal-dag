# Planning quality reference

This reference adapts planning patterns from:

- `open-multi-agent/open-multi-agent`: goal-first coordinator, `planOnly` review/replay, consensus/judge verification, phase-aware model routing, specialized parallel reviewers, structured-output retries, and observability.
- `zsq259/Plan-over-Graph`: two-stage workflow of narrative extraction → abstract transition graph → parallel schedule; rule/source-target validation; critical-path/makespan optimization; cost/risk tie-breaks; retry on invalid plans.

The runtime DAG format remains unchanged. `GoalDagSpec` may carry spec-only planning metadata that `goal-dag` strips from the runtime DAG and preserves in a trace sidecar. Use this reference to improve the **agent-side extraction and review process** before writing `GoalDagSpec` JSON.

## Quality loop

Before writing the final spec, run this loop and encode the durable results in spec-only `consumes`, `produces`, `evidence`, `modelRationale`, `acceptanceCriteria`, `decompositionRationale`, and `openQuestions` fields. These fields are allowed in `GoalDagSpec`, stripped from the runtime DAG JSON, and emitted to the planning trace sidecar.

### 1. Evidence table

Extract only what the source document supports.

| item | kind | evidence | implied artifact / state | ambiguity |
| --- | --- | --- | --- | --- |
| requirement / milestone / constraint | deliverable / dependency / validator / risk / model hint | quote or section reference | file, module, capability, decision, or state produced/needed | question to ask, if any |

Rules:

- Quote or point to the source section for every dependency, validator, and output.
- If an item has no evidence, omit it or ask a clarifying question.
- Distinguish **ordering language** ("after", "depends on", "then") from simple list order.

### 2. Abstract transition graph

Convert the document into an intermediate graph similar to Plan-over-Graph rules:

```json
{
  "initialState": ["current repo state", "known inputs"],
  "targetState": "accepted final outcome",
  "rules": [
    {
      "id": "r1",
      "source": ["prerequisite artifact/state"],
      "target": ["produced artifact/state"],
      "work": "candidate node objective",
      "evidence": "quote/section",
      "effort": "small|medium|large|unknown",
      "risk": "low|medium|high",
      "cost": "cheap|normal|expensive|unknown"
    }
  ]
}
```

Use this graph to reason; encode selected rule sources/targets as node `consumes` and `produces` in the final `GoalDagSpec`.

### 3. Plan over the graph

Choose DAG nodes and `after` edges by these priorities:

1. **Soundness**: every node objective is backed by a rule/evidence item.
2. **Completeness**: the selected nodes cover the target state and required validators.
3. **Parallelism**: leave independent rules parallel; only add `after` when a produced state is required by a later node.
4. **Critical path**: minimize the longest dependency chain. Prefer a small fan-in validation/audit node over serializing independent implementation nodes.
5. **Risk/cost tie-breaks**: when two plans are equivalent, prefer lower risk/cost and fewer redundant nodes.
6. **No redundant shortcuts**: omit optional nodes that do not improve the target outcome, unless the source document explicitly requires them.

### 4. Dependency and critical-path review

Show a review table before writing the spec:

| node | consumes / needs | produces | `after` | why not parallel? | risk | validator / gate |
| --- | --- | --- | --- | --- | --- | --- |

Then check:

- Every dependency supplies a required consumed state.
- Every consumed state is either in `initialState` or produced by an upstream node.
- Nodes with no dependency reason have no `after` edge.
- The graph has no orphan required outputs and no unreachable final validation.
- The critical path is explicit; long chains are justified.
- High-risk fan-in or final-audit work uses a strong/reasoning model scenario.

### 5. Judge / consensus pass for non-trivial plans

For high-risk plans, plans with more than 6 nodes, or plans with ambiguous dependencies, run a skeptical review pass before building the DAG:

- Reviewer prompt: "Find missing dependencies, invented dependencies, redundant nodes, missing validators, weak model assignments, and critical-path bottlenecks. Accept only if every edge has source evidence."
- Revise once when the reviewer finds concrete issues.
- If disagreement remains, ask the user instead of guessing.

This mirrors Open Multi-Agent's consensus pattern, but can be done manually by the Pi agent or with a stronger model scenario.

## Recursive decomposition

Before writing the final `GoalDagSpec`, run one recursive decomposition pass over every candidate node. The goal is not to make the DAG deeper; the goal is to make each node independently executable and individually verifiable.

A shallow DAG is acceptable when nodes are independently executable and individually verifiable. The failure condition is an oversized or unverifiable node, not shallow depth itself.

Use the pass like this:

1. Review the candidate node against the node size budget below.
2. If it is too large, split it into smaller candidate boundaries supported by source evidence.
3. Re-run the dependency review after splitting.
4. Do **not** add `after` edges from decomposition alone. Edges still require `consumes` / `produces` / source evidence.
5. If the node cannot be safely split from the available evidence, keep it broad, mark it high risk, add a node-prefixed `openQuestions` entry, and require user review before offering `/goal --dag`.

Patterns may split an explicitly broad requirement into narrower execution boundaries only when those boundaries are directly stated or strongly implied by the source document. Do not create unsupported deliverables, validators, modules, or dependency edges from patterns alone.

## Node size budget

A DAG node should be small enough for one subagent session to execute without major re-planning.

A node should usually satisfy these conditions:

- One primary work type.
- One bounded capability, module, or artifact slice.
- Clear expected output, validator, acceptance criteria, or open question.
- No more than 1-3 major implementation steps.
- No hidden dependency on unresolved design decisions.
- Risk can be judged independently from the rest of the DAG.
- Model choice can be justified for this node alone.

A node is too large when:

- Its objective contains unrelated "and" work.
- It combines design, implementation, testing, and documentation.
- It touches several modules without a clear boundary.
- It would force the strictest model class only because the node scope is broad.
- It requires the subagent to discover the real sub-tasks after starting.
- It cannot be independently verified.

## Validator satisfiability requirement

Validators are executable contracts, not aspirations. Before adding a validator,
prove that the command can be satisfied by the node's allowed scope and by
artifacts that exist or are produced upstream.

Rules:

- Do not invent shell validators. Use a validator only when the source document
  names the command or when the repository already provides the command/artifact
  relationship.
- If a validator requires a file, directory, OpenSpec change, generated report,
  or other artifact that is absent, the DAG must include a source-backed producer
  node for that artifact, or the same node must be allowed to create it.
- If `validation.allowedPaths` is present, a node cannot be expected to create or
  repair artifacts outside those paths. Such requirements must be moved to a
  different node with a compatible path policy, converted to `acceptanceCriteria`,
  or raised as a node-prefixed `openQuestions` blocker.
- OpenSpec validators such as `openspec validate <change>` and
  `openspec-validate-source-manifest <change>` require
  `openspec/changes/<change>/` to exist before execution unless the DAG includes
  an explicit OpenSpec-authoring node whose allowed paths include that directory.
- A final validation node may run read-only checks across the repository, but it
  must not require creating missing artifacts that its allowed paths forbid.

Failure examples:

```json
{
  "id": "full-validation",
  "validators": ["openspec validate add-foo --strict"],
  "validation": {
    "allowedPaths": ["src/**", "tests/**"]
  }
}
```

This is invalid when `openspec/changes/add-foo/` does not already exist: the
validator requires an artifact the node is not allowed to create.

## Acceptance handle requirement

Every node should have at least one acceptance handle:

- `outputs`, when the source supports expected artifacts.
- `validators`, when the source provides deterministic shell checks that pass the validator satisfiability requirement above.
- `acceptanceCriteria`, when the source provides review criteria but no deterministic check.
- `openQuestions`, when acceptance is unresolved.

Do not invent shell validators or outputs. If the source does not provide a deterministic check, use spec-only `acceptanceCriteria` or a node-prefixed root `openQuestions` entry instead.

When `openQuestions` are used as a node acceptance handle, prefix each question with the node id:

```json
{
  "openQuestions": [
    "implement-service: confirm expected service-layer acceptance criteria",
    "add-integration-tests: confirm deterministic validator command"
  ]
}
```

A node without any acceptance handle must not be marked low risk. In the node quality review table, mark unresolved acceptance as `ask-user` or `mark-risk`.

## Node quality review table

Before writing the final `GoalDagSpec`, show a node quality review table:

| node | candidate boundary | acceptance handle | dependency evidence | risk | model implication | refinement action |
| --- | --- | --- | --- | --- | --- | --- |
| candidate node id | why this is a reasonable boundary | outputs / validators / acceptanceCriteria / node-prefixed openQuestions | none / consumes-produces / source quote | low / medium / high | cheap / normal / strong / strongest | keep / split / ask-user / mark-risk |

Rules:

- If a node is too large, run one refinement pass before writing the final spec.
- If refinement still leaves it too broad, do not silently execute it. Mark it high risk, add node-prefixed `openQuestions`, and require user review before offering `/goal --dag`.
- Record `decompositionRationale` for nodes whose boundary may otherwise look broad or debatable.
- Preserve independent work as parallel. Candidate boundaries do not create dependencies by themselves.

## Candidate decomposition patterns

These patterns suggest node boundaries, not dependency chains. Do not add `after` edges unless supported by `consumes` / `produces` / source evidence.

Feature implementation pattern:

```text
scan-current-state
design-api-contract
implement-domain-types
implement-repository
implement-service
implement-controller
add-unit-tests
add-integration-tests
update-docs
final-review
```

Refactor pattern:

```text
scan-current-boundaries
define-target-boundary
move-module-a
move-module-b
update-imports
add-regression-tests
final-compatibility-audit
```

Docs / spec pattern:

```text
extract-current-behavior
draft-spec
review-spec-against-source
finalize-spec
```

OpenSpec change pattern:

```text
read-change
extract-requirements
map-affected-capabilities
draft-implementation-dag
validate-acceptance-criteria
final-user-review
```

Only use a pattern boundary when the source directly states or strongly implies that work. For example, do not create `implement-repository` unless the source mentions persistence, repository behavior, storage, database access, or an equivalent artifact.

## Model-routing implications

- Use a strong/long-context model for the extraction + planning review when the document is long or ambiguous.
- Use lighter model classes for low-risk leaf nodes with narrow scope.
- Use stronger models for final synthesis, audits, migrations, security-sensitive work, and high fan-in integration nodes.
- Prefer explicit per-node `modelScenario` values so the reviewed plan is replayable and diffable.

## Runtime encoding

Encode only supported runtime fields:

- Dependency reasoning → `after` edges in the runtime DAG, with `consumes` / `produces` preserved only in the trace.
- Artifacts → `outputs`.
- Deterministic checks → `validators`.
- Parallelism / serialization hints → minimal `after` plus `conflicts`.
- Risk/model choice → `risk`, `modelRouting`, and per-node `modelScenario`, with `modelRationale` preserved only in the trace.
- Evidence and unresolved ambiguity → `evidence` and `openQuestions` preserved only in the trace. When an open question is a node acceptance handle, prefix it with `<node-id>:`.
- Acceptance review → `acceptanceCriteria` and `decompositionRationale` preserved only in the trace.
- Human review requirements → `completionGates` only when supported by the active runtime policy; otherwise warn the user and require manual review before offering `/goal --dag`.

Always build with `--trace <out.trace.json>` for non-trivial DAGs and show trace warnings/open questions before handing the DAG to the goal-runner stage. `goal-dag` itself must not execute `/goal --dag`.

## Quality profiles

`goal-dag` supports the full closed set of quality profiles defined by
goal-contract. Each profile is a token the producer includes in
`defaults.qualityProfiles` or per-node `qualityProfiles`.

### Supported profiles

| Profile | Meaning |
| --- | --- |
| `incremental-implementation` | Smallest independently verifiable slice; no unrelated cleanup or broad refactors |
| `test-driven-change` | Tests/validators as first-class evidence; run or explain declared validators before completion |
| `code-review-required` | Prepare a reviewable diff with verification notes, risks, and reviewer-relevant context |
| `independent-audit` | Requires an audit gate separate from implementation |
| `security-sensitive-review` | Security-focused review of changes |
| `api-contract-change` | Changes affecting API contracts must be reviewed for backward compatibility |
| `database-migration` | Database schema changes require migration-safe review |
| `docs-required` | Update or identify required documentation/ADR/operator notes |
| `observability-required` | Changes must include observability (metrics, logging, tracing) |
| `ship-preflight` | Pre-release validation gate before deployment |
| `implementation-discipline` | Karpathy-style disciplined implementation: reduce ambiguity, preserve assumptions/non-goals/success criteria, encode bounded node shape with objective, non-goals, expected outputs, verification, and quality profiles. See [`docs/implementation-discipline-dag-spec.md`](../../docs/implementation-discipline-dag-spec.md) for the full spec. |

### Using quality profiles

- Set broadly applicable profiles on `defaults.qualityProfiles` so all nodes
  inherit them.
- Set node-specific profiles on individual nodes to add discipline for
  particular work types.
- The runtime de-duplicates profiles before enforcement (first-seen wins).
- Profiles are closed vocabulary — unsupported tokens are rejected by the
  runtime parser during round-trip validation.

### Decomposition and review with quality profiles

When a node carries `implementation-discipline`:

- Review whether assumptions and non-goals are explicitly recorded in `scope`.
- Confirm success criteria are encoded in `acceptanceCriteria`, `validators`,
  or `outputs`.
- Check that verification expectations (Think Before Coding, Simplicity First,
  Surgical Changes, Goal-Driven Verification) are satisfied before marking the
  node as ready.
- The node size budget and acceptance handle requirements still apply.
