---
name: goal-dag
description: Stage 2 producer that reads a development document (PRD, OpenSpec change, design doc, ticket description) and produces a valid Goal DAG JSON file for handoff to the goal-runner stage via `/goal --dag`. Use when the user has a multi-step plan document and wants a validated DAG JSON instead of writing it by hand.
---

# Goal DAG

This skill teaches the agent to convert a free-form development document into a
[Goal DAG](references/dag-format.md) JSON file for the Stage 3 **goal-runner**
handoff command:

```text
/goal --dag <path>
```

`goal-runner` exports the parser/types used by `goal-dag` for round-trip
validation. `goal-dag` is Stage 2 only: it produces a validated DAG JSON plus
optional trace JSON, but it does not execute `/goal`.

The skill is intentionally **prompt + reference heavy, code-light**. The agent
performs the creative steps: extracting milestones from the document and
assigning models from the catalog. Deterministic code then turns the
`GoalDagSpec` into a DAG file and round-trips it through the runner parser for
validation.

## When to load this skill

- The user has a markdown / text document describing a multi-step plan and
  wants a validated DAG JSON for handoff to goal-runner.
- The user wants to refactor a goal that started as a single objective into
  a multi-node DAG.
- The user wants to add a known good set of validators, expected outputs, and
  model-routing scenarios to a planned goal.

## When **not** to load this skill

- The user only has a one-liner objective → use `/goal <objective>` directly.
- The user has already written a DAG JSON file → hand it to goal-runner with
  `/goal --dag <path>` directly.
- The user wants to inspect an existing goal → use `/goal status` /
  `/goal monitor`.

## Inputs

- `<doc>` — path to a development document or OpenSpec change directory.
  Supported today: markdown, plain text, `openspec/changes/<change-name>/`, or
  a JSON document that the agent can structure into a `GoalDagSpec`.
- (Optional) `<out>` — output path for the DAG file. Default: a sibling
  `.dag.json` next to the document (e.g. `prd.md` → `prd.dag.json`).
- (Optional) `<trace>` — output path for the planning trace sidecar. Default:
  a sibling `.trace.json` next to the DAG file when producing a non-trivial DAG.

## Stage 2 producer boundary

`goal-dag` produces:

```text
OpenSpec / PRD / design doc / ticket
→ GoalDagSpec
→ validated <name>.dag.json
→ optional <name>.trace.json
```

It must not:

- Execute `/goal --dag`.
- Manage subagents.
- Create worktrees.
- Execute validators.
- Decide goal completion or blocked state.
- Modify implementation files.
- Create or modify OpenSpec source packages.
- Preserve producer-only trace metadata in the runtime DAG JSON.

## OpenSpec Change Input Contract

When the input path is `openspec/changes/<change-name>/`:

1. Read `source-manifest.json` first.
2. Read every file listed in `sources[]`.
3. Treat these source kinds as authoritative:
   - `proposal`
   - `design`
   - `tasks`
   - `spec-delta`
4. Do not treat `change-explainer.html` as authoritative.
5. Do not read `.goal-spec/` workflow artifacts as source of truth.
6. If `source-manifest.json` is missing or stale, stop and ask for regeneration
   or run the appropriate manifest validation command when available.
7. Preserve OpenSpec assumptions and open questions into the planning trace.
8. Open questions that affect scope/API/data/security/validation must become:
   - a decision node, or
   - a `human-confirmation` completion gate when supported by the active runtime
     policy, or
   - a DAG generation blocker.

### OpenSpec → DAG planning mapping

- `proposal.md`
  - `Why` / `What Changes` / `Impact` → root objective and high-level node candidates.
- `design.md`
  - Decisions / Detailed Design / Module Boundaries / Migration → node boundaries,
    dependencies, conflicts, and risk.
- `tasks.md`
  - Unchecked non-backlog tasks → candidate nodes.
  - `[BACKLOG]` tasks → trace only; do not emit runtime DAG nodes unless the user
    explicitly includes them.
- `specs/**/spec.md`
  - Requirements / Scenarios → `acceptanceCriteria`, `validators` when explicitly
    given, or `outputs` when source-grounded.
- Open Questions
  - Implementation-sensitive questions become a runtime blocker, gate, or decision node.
- Assumptions
  - Escalate risk or require a supported human-confirmation gate when assumptions
    are not retired.

When source input is an already-approved OpenSpec change, DAG nodes should
implement, verify, review, or archive that change. They must not say "Create an
OpenSpec change" unless the source document explicitly asks for execution-time
child specs. Use wording like:

```text
Implement the approved OpenSpec change <change-name> slice for fixtures
```

## Workflow

1. **Read the source document** with `read`. For OpenSpec change directories,
   follow the OpenSpec Change Input Contract above. Do not invent content; the document
   is the source of truth for the goal objective, requirements, constraints,
   and supported node boundaries.

2. **Read the model-class catalog guidance** before assigning model scenarios.
   Use abstract `modelClass` values only. The shared class catalog lives in
   `goal-contract/catalogs/model-classes.json`; project-local
   `.goal/model-catalog.json` files may provide advisory mapping rules, but
   they must map task traits to `modelScenario` + `modelClass`, never concrete
   provider/model ids. Concrete model resolution is runner/harness-only.

3. **Extract candidate tasks from source evidence.** Do not invent content.
   Use the document as the sole source of truth. For each candidate task, note
   what the document explicitly says or strongly implies about its scope,
   outputs, order, and risk.

4. **Build an evidence table.** Adapt the Plan-over-Graph pattern. For each
   candidate task extract: source quote/section, implied artifact/state, and
   ambiguity to resolve.

5. **Build an abstract transition graph.** Map narrative items into rules:
   `source` (prerequisites) → `target` (outcomes). Encode the reviewed states
   into each node's spec-only `consumes`, `produces`, and `evidence` fields.

6. **Run a recursive decomposition pass.** Before writing the final spec,
   evaluate each candidate node against the **node size budget** (see
   [`references/planning-quality.md`](references/planning-quality.md#node-size-budget)).
   A node is too large when:
   - Its objective combines multiple unrelated work types.
   - It combines design + implementation + tests + docs in one node.
   - It crosses multiple modules without a clear boundary.
   - A subagent would need a major internal plan before executing.
   - It requires the strictest model class only because scope is too broad.
   - It cannot be independently verified.

   When a node is too large, split it using **candidate decomposition
   patterns** (see [`references/planning-quality.md`](references/planning-quality.md#candidate-decomposition-patterns)).
   These patterns suggest node boundaries, not dependency chains. Patterns may
   split an explicitly broad requirement into narrower execution boundaries
   only when those boundaries are directly stated or strongly implied by the
   source document. Do not create unsupported deliverables, validators, modules,
   or `after` edges from patterns alone — dependencies still require
   `consumes` / `produces` / `evidence`.

   If a broad node cannot be safely split from source evidence:
   - Mark it high risk.
   - Add node-prefixed `openQuestions` explaining the ambiguity.
   - Add `human-confirmation` to `completionGates` only when supported by the
     active runtime policy; otherwise require manual user review before
     offering `/goal --dag`.
   - Do not silently execute it.

7. **Run a validator satisfiability review.** A validator is not acceptable just
   because it is a plausible command. Before writing the final spec, prove every
   validator can execute under the node contract:

   - Do not add validators for artifacts that do not exist unless an upstream
     node creates them or this node is allowed to create them.
   - If `validation.allowedPaths` is present, any missing artifact a validator
     requires must be inside those allowed paths.
   - OpenSpec validators such as `openspec validate <change>` or
     `openspec-validate-source-manifest <change>` require
     `openspec/changes/<change>/` to already exist, or a source-backed node that
     is allowed to create that directory. Otherwise use `acceptanceCriteria` or
     a node-prefixed `openQuestions` entry instead of emitting an unexecutable
     validator.
   - Never pair a validator that requires `openspec/**` with allowed paths that
     only permit implementation files unless the OpenSpec change already exists.

8. **Run a node quality review.** Before writing the final spec, show this
   table (see [`references/planning-quality.md`](references/planning-quality.md#node-quality-review-table)):

   | node | candidate boundary | acceptance handle | dependency evidence | risk | model implication | refinement action |
   | --- | --- | --- | --- | --- | --- | --- |

   **Acceptance handle** — every node must have at least one of:
   - `outputs`
   - `validators`
   - spec-only `acceptanceCriteria` (extracted from source evidence)
   - node-prefixed root `openQuestions` explaining why acceptance is unresolved

   Do not invent shell validators or outputs. When the source document does
   not provide deterministic checks, use `acceptanceCriteria` or
   node-prefixed `openQuestions` (`<node-id>: question`). A node without any
   acceptance handle must not be marked low risk.

9. **Run dependency / critical-path review.** Show a dependency review table
   with each node's consumed state, produced state, `after` edges, and why it
   cannot run in parallel. For high-risk plans, ambiguous dependency graphs,
   or >6 nodes, run a skeptical judge/consensus pass inspired by
   Open Multi-Agent: find missing dependencies, invented dependencies,
   redundant nodes, missing validators, weak model assignments, and
   critical-path bottlenecks. Revise once, then ask the user when evidence
   is still unclear.

10. **Run model assignment.** Produce and show a table before writing the
   final spec. Include a `controller` row for the DAG controller and one row
   per DAG node:

   | target | risk/scope summary | chosen scenario | modelClass | reason |
   | --- | --- | --- | --- | --- |

   Then write `modelRouting.scenarios`, a dedicated
   `modelRouting.controllerScenario`, explicit per-node `modelScenario`
   values, and per-node `modelRationale` into the spec.

11. **Run a model-cost sanity review.** If most leaf implementation nodes
    require the strictest model class, inspect whether:
    - Are scan/design/review work types mixed into implementation nodes?
    - Can high-risk decisions be split into a separate review node?
    - Can docs/tests be split and assigned lighter classes?
    - Is the whole DAG genuinely high risk?

    Show a cost-tier table (see
    [`references/model-catalog.md`](references/model-catalog.md#model-cost-sanity-review)).
    If strict classes remain justified, record the reason in the trace.

12. **Ask clarifying questions** when the document is ambiguous:
    - Are nodes A and B parallel, or does B depend on A?
    - Which modules / files does each node touch? (drives `conflicts`)
    - Is there a verification command per node? (drives `validators`)
    - What state/artifact does each dependency consume and produce?
    - Is a shortcut/optional node required, or should it be omitted as redundant?
    - Should a node use a different model? (drives `modelScenario`)
    - Is a lighter model class acceptable for low-risk docs/spec-only nodes?
    - Does a high-risk or final-audit node require a stricter/long-context model class?

13. **Write the spec to a temp JSON file** and run:

    ```bash
    npx --package=goal-dag goal-dag build-dag \
      --spec <spec.json> --out <out.dag.json> --trace <out.trace.json>
    ```

    The CLI round-trips the spec through the goal-runner parser exported as
    `parseGoalDagFileDocument()` and refuses to write an invalid DAG. Runtime
    fields such as `kind`, `validation`, `workspace`, `risk`,
    `completionGates`, `modelScenario`, and `thinkingLevel` are preserved in the
    emitted DAG. Spec-only fields (`openQuestions`,
    `consumes`, `produces`, `evidence`, `modelRationale`,
    `acceptanceCriteria`, `decompositionRationale`) are stripped from the
    runtime DAG and preserved in the trace sidecar.

14. **Show the user the resulting DAG and trace** (objective + node ids +
    dependency graph + node quality review + dependency review + model
    assignment table + cost-tier table + trace warnings / open questions)
    and the diff vs. the document's intent. Then show the exact Stage 3 handoff
    command, but do **not** execute it:

    ```text
    /goal --dag <out.dag.json>
    ```

## Implementation-discipline guidance

When the source document represents a change that carries implementation-discipline
context (assumptions, non-goals, success criteria, or explicit scope boundaries),
the producer should apply these rules alongside the general workflow above.

The full implementation-discipline DAG spec is at
[`docs/implementation-discipline-dag-spec.md`](../../docs/implementation-discipline-dag-spec.md).

### Recommended Node Shape

For nodes that need implementation-discipline context, encode the following
into each node:

| Aspect | Runtime field | Producer guidance |
| --- | --- | --- |
| Concise task outcome | `objective` | State what the node achieves |
| Non-goals and boundaries | `scope` | Include what the node explicitly should NOT do |
| Expected artifacts | `outputs` | Files, docs, migrations, or reports |
| Verification evidence | `validators`, `validation`, `acceptanceCriteria` | Commands, evidence, and path policy |
| Quality profile | `qualityProfiles` | Include `"implementation-discipline"` when the profile is supported |
| Risk | `risk` | Set `high` / `medium` when ambiguity or broad blast radius remains |

Add the quality profile `implementation-discipline` to the node or defaults:

```json
{
  "defaults": {
    "qualityProfiles": ["implementation-discipline"]
  }
}
```

### DAG Authoring Rules

#### 1. Think Before Coding

Before emitting nodes, detect material ambiguity:

- Multiple incompatible interpretations of the requested behavior.
- Missing product/API decisions.
- Unclear ownership between repositories or packages.
- Validation requirements that cannot verify the requested outcome.
- Scope that would force broad unrelated refactors.

If the ambiguity is material, request clarification or mark the handoff as
not ready. If the ambiguity is minor, record the recommended safe assumption
in `scope` or validation notes.

#### 2. Simplicity First

Prefer small, directly verifiable nodes. Avoid nodes whose objective implies
speculative frameworks, broad abstractions, or optional features not requested
by the source document.

#### 3. Surgical Changes

Constrain scope with the strongest available mechanism:

- `scope` prose for human-readable boundaries — include non-goals and boundaries.
- `expectedOutputs` for concrete files/artifacts.
- Validation `allowedPaths` and `forbiddenPaths` when path boundaries are known.
- Dependencies that prevent unrelated work from being bundled into one node.

#### 4. Goal-Driven Verification

Include verification expectations in each node:

- Bugfix nodes: prefer a reproduction test or equivalent failure evidence
  before the fix.
- Implementation nodes: include validators or required evidence whenever
  feasible.

### Preserving assumptions, non-goals, and success criteria

When the source document contains:

- **Assumptions** — preserve them in the node's `scope` or as spec-only
  `evidence` so the executor can validate against the same baseline.
- **Non-goals** — encode explicitly in `scope` so the executor knows what
  is deliberately excluded.
- **Success criteria** — encode as `acceptanceCriteria`, `validators`, or
  `outputs` depending on determinism.

When a node proceeds with a bounded assumption, include it in `scope` or
validation notes so the controller can answer later subagent questions from
DAG context.

### Clarification Handoff

When a node proceeds with a bounded assumption rather than requesting
clarification, document that assumption in the node's `scope` or validation
notes. This lets the runtime controller answer subagent questions from DAG
context without re-asking the user.

### Supported quality profiles

`goal-dag` supports all quality profiles defined by `goal-contract`:

```
incremental-implementation, test-driven-change, code-review-required,
independent-audit, security-sensitive-review, api-contract-change,
database-migration, docs-required, observability-required,
ship-preflight, implementation-discipline
```

Each profile is a closed vocabulary token. The producer emits them in
`qualityProfiles` and the runtime enforces the corresponding discipline.

## Hard rules

- **Do not invent sequential dependencies.** Nodes with no `after` array are
  runnable in parallel. If the document explicitly says "step 1, then step 2,
  then step 3", wire those as `after`; if it just lists items, leave them
  independent.
- **Do not invent `validators` or `outputs` the document does not support.**
  The runtime will run validators as plain shell commands; only include them
  when the document specifies the check. Use spec-only `acceptanceCriteria` or
  `openQuestions` when the source document does not provide deterministic
  checks. When `openQuestions` are used as a node acceptance handle, prefix
  each question with the node id (for example,
  `implement-service: confirm expected service-layer acceptance criteria`).
- **Map validation evidence to runtime-supported fields and `requiredEvidence` tokens.**
  For deterministic shell checks in source text:
  - Add the command in `validators`.
  - Add `validation.requiredEvidence` with `"validators-ran"` so the runtime
    requires successful command execution.
  For audit requirements in source text:
  - Add audit artifact paths to `validation.auditReportPaths`.
  - Add `validation.requiredEvidence` with `"audit-report-present"` so the
    runtime requires those paths to exist.
  For path or scope restrictions in source text:
  - Add `validation.allowedPaths` and/or `validation.forbiddenPaths`.
    These are enforced directly by runtime validation and do not need
    `requiredEvidence` tokens.
  For textual acceptance-only requirements: use `acceptanceCriteria` and
  source-grounded `evidence`; unresolved items become node-prefixed
  `openQuestions` and are tracked in the trace.
  Do not use `requiredEvidence` to replace missing deterministic checks.
- **Do not write concrete provider/model ids.** Declare every chosen abstract
  `modelClass` in `modelRouting.scenarios`, then assign each node with
  `modelScenario`. Concrete resolution belongs exclusively to goal-runner
  harness bindings. If the abstract class is unclear, ask the user instead of
  relying on fallback.
- **Every `after` edge needs evidence.** Before writing the spec, be able to
  explain what upstream state/artifact the dependent node consumes. Encode that
  state in `consumes` / `produces` and cite the source in `evidence`. If the edge
  is only based on list order or habit, remove it or ask the user.
- **Always round-trip through the goal-runner parser** so cycle / missing-dep /
  scenario-ref / `kind` / `validation` errors surface before the user sees the
  file.
- **Never execute Stage 3 behavior.** Do not run `/goal --dag`, execute
  validators, create worktrees, manage subagents, decide completion/blocked, or
  modify implementation files.
- **Do not create or modify OpenSpec source packages.** When source input is an
  already-approved OpenSpec change, DAG nodes should implement, verify, review,
  or archive that change. They must not say "Create an OpenSpec change" unless
  the source document explicitly asks for execution-time child specs.
- **Never put trace-only metadata in runtime DAG JSON.** `openQuestions`,
  `consumes`, `produces`, `evidence`, `modelRationale`, `acceptanceCriteria`,
  and `decompositionRationale` belong only in the spec/trace sidecar.

- **A shallow DAG is acceptable** when nodes are independently executable and
  individually verifiable. Do not increase depth just to make the DAG look
  more detailed. The failure condition is oversized or unverifiable nodes,
  not shallow depth itself.
- **Candidate decomposition patterns suggest node boundaries, not
  dependency edges.** Patterns may split an explicitly broad requirement into
  narrower execution boundaries only when directly stated or strongly implied
  by the source. Do not create unsupported deliverables, validators, modules,
  or `after` edges from patterns alone. Only add `after` when consumes /
  produces / evidence supports the dependency.
- **Every node should have an acceptance handle:** `outputs`, `validators`,
  `acceptanceCriteria`, or node-prefixed root `openQuestions` explaining
  unresolved acceptance. Nodes without any acceptance handle must not be
  marked low risk.
- **If a node requires major internal planning by the subagent**, run one
  refinement pass before writing the final spec.
- **If a broad node cannot be safely split from source evidence**, mark it
  high risk, add node-prefixed `openQuestions`, add `human-confirmation` only
  when supported by the active runtime policy, and otherwise require manual
  user review before offering `/goal --dag`. Explain why it could not be split.
- **If most implementation nodes require the strictest model class**, run a
  model-cost sanity review before finalizing model assignments. If strict
  models remain justified, record the reason in the trace.

## Failure modes

- The document is a one-line objective. Stop and tell the user to use
  `/goal <objective>` instead.
- The document is too long (>20 nodes). Tell the user the default cap and
  ask whether to chunk the work into multiple goals.
- The validator list is non-deterministic (e.g. reads from CI variables).
  Reject the spec and ask for a deterministic command.
