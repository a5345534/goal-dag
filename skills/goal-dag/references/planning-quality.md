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

## Acceptance handle requirement

Every node should have at least one acceptance handle:

- `outputs`, when the source supports expected artifacts.
- `validators`, when the source provides deterministic shell checks.
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
