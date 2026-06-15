---
name: goal-dag
description: Read a development document (PRD, OpenSpec change, design doc, ticket description) and produce a valid Goal DAG JSON file consumable by `/goal --dag`. Use when the user has a multi-step plan document and wants to drive the `agent-goal-runtime` from it instead of writing DAG JSON by hand.
---

# Goal DAG

This skill teaches the agent to convert a free-form development document into a
[Goal DAG](references/dag-format.md) JSON file that `agent-goal-runtime` can execute
via `/goal --dag <path>`.

The skill is intentionally **prompt + reference heavy, code-light**. The agent
performs the creative steps: extracting milestones from the document and assigning
models from the catalog. Deterministic code then turns the `GoalDagSpec` into a
DAG file and round-trips it through `agent-goal-runtime`'s parser for validation.

## When to load this skill

- The user has a markdown / text document describing a multi-step plan and
  wants `/goal` to execute it.
- The user wants to refactor a goal that started as a single objective into
  a multi-node DAG.
- The user wants to add a known good set of validators, expected outputs, and
  model-routing scenarios to a planned goal.

## When **not** to load this skill

- The user only has a one-liner objective → use `/goal <objective>` directly.
- The user has already written a DAG JSON file → run `/goal --dag <path>`
  directly.
- The user wants to inspect an existing goal → use `/goal status` /
  `/goal monitor`.

## Inputs

- `<doc>` — path to a development document. Supported today: markdown, plain
  text, or a JSON document that the agent can structure into a `GoalDagSpec`.
- (Optional) `<out>` — output path for the DAG file. Default: a sibling
  `.dag.json` next to the document (e.g. `prd.md` → `prd.dag.json`).
- (Optional) `<trace>` — output path for the planning trace sidecar. Default:
  a sibling `.trace.json` next to the DAG file when producing a non-trivial DAG.

## Workflow

1. **Read the source document** with `read`. Do not invent content; the document
   is the source of truth for the goal objective and node list.

2. **Read the model catalog** before assigning models. Prefer a project-local
   `.goal/model-catalog.json` when present; otherwise use this package's
   [`../../catalogs/pi-available-models.json`](../../catalogs/pi-available-models.json).
   The catalog lists ordered model-routing rules for Shawn's machine. Each rule
   maps task traits (for example `taskType`, `risk`, `privacy`, and estimated
   context) to a recommended `modelScenario` and Pi model id. Use only models
   from this catalog unless the user explicitly supplies another model.

3. **Extract candidate tasks from source evidence.** Do not invent content.
   Use the document as the sole source of truth. For each candidate task, note
   what the document explicitly says about its scope, outputs, order, and risk.

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
   - It requires the strongest model only because scope is too broad.
   - It cannot be independently verified.

   When a node is too large, split it using **candidate decomposition
   patterns** (see [`references/planning-quality.md`](references/planning-quality.md#candidate-decomposition-patterns)).
   These patterns suggest node boundaries, not dependency chains. Do not add
   `after` edges based on patterns alone — dependencies still require
   `consumes` / `produces` / `evidence`.

   If a broad node cannot be safely split from source evidence:
   - Mark it high risk.
   - Add `openQuestions` explaining the ambiguity.
   - Add `human-confirmation` to `completionGates`.
   - Do not silently execute it.

7. **Run a node quality review.** Before writing the final spec, show this
   table (see [`references/planning-quality.md`](references/planning-quality.md#node-quality-review-table)):

   | node | candidate boundary | acceptance handle | dependency evidence | risk | model implication | refinement action |
   | --- | --- | --- | --- | --- | --- | --- |

   **Acceptance handle** — every node must have at least one of:
   - `outputs`
   - `validators`
   - spec-only `acceptanceCriteria` (extracted from source evidence)
   - `openQuestions` explaining why acceptance is unresolved

   Do not invent shell validators or outputs. When the source document does
   not provide deterministic checks, use `acceptanceCriteria` or
   `openQuestions`. A node without any acceptance handle must not be marked
   low risk.

8. **Run dependency / critical-path review.** Show a dependency review table
   with each node's consumed state, produced state, `after` edges, and why it
   cannot run in parallel. For high-risk plans, ambiguous dependency graphs,
   or >6 nodes, run a skeptical judge/consensus pass inspired by
   Open Multi-Agent: find missing dependencies, invented dependencies,
   redundant nodes, missing validators, weak model assignments, and
   critical-path bottlenecks. Revise once, then ask the user when evidence
   is still unclear.

9. **Run model assignment.** Produce and show a table before writing the
   final spec. Include a `controller` row for the DAG controller and one row
   per DAG node:

   | target | risk/scope summary | chosen scenario | model | reason |
   | --- | --- | --- | --- | --- |

   Then write `modelRouting.scenarios`, a dedicated
   `modelRouting.controllerScenario`, explicit per-node `modelScenario`
   values, and per-node `modelRationale` into the spec.

10. **Run a model-cost sanity review.** If most leaf implementation nodes
    require the strongest model, inspect whether:
    - Are scan/design/review work types mixed into implementation nodes?
    - Can high-risk decisions be split into a separate review node?
    - Can docs/tests be split and assigned cheaper models?
    - Is the whole DAG genuinely high risk?

    Show a cost-tier table (see
    [`references/model-catalog.md`](references/model-catalog.md#model-cost-sanity-review)).
    If strong models remain justified, record the reason in the trace.

11. **Ask clarifying questions** when the document is ambiguous:
    - Are nodes A and B parallel, or does B depend on A?
    - Which modules / files does each node touch? (drives `conflicts`)
    - Is there a verification command per node? (drives `validators`)
    - What state/artifact does each dependency consume and produce?
    - Is a shortcut/optional node required, or should it be omitted as redundant?
    - Should a node use a different model? (drives `modelScenario`)
    - Is a cheaper/faster model acceptable for low-risk docs/spec-only nodes?
    - Does a high-risk or final-audit node require a stronger/long-context model?

12. **Write the spec to a temp JSON file** and run:

    ```bash
    npx --package=goal-dag goal-dag build-dag \
      --spec <spec.json> --out <out.dag.json> --trace <out.trace.json>
    ```

    The CLI round-trips the spec through `agent-goal-runtime`'s
    `parseGoalDagFileDocument()` and refuses to write an invalid DAG. Spec-only
    fields (`consumes`, `produces`, `evidence`, `modelRationale`,
    `acceptanceCriteria`, `decompositionRationale`) are stripped from the
    runtime DAG and preserved in the trace sidecar.

13. **Show the user the resulting DAG and trace** (objective + node ids +
    dependency graph + node quality review + dependency review + model
    assignment table + cost-tier table + trace warnings / open questions)
    and the diff vs. the document's intent, then ask whether to start:

    ```text
    /goal --dag <out.dag.json>
    ```

## Hard rules

- **Do not invent sequential dependencies.** Nodes with no `after` array are
  runnable in parallel. If the document explicitly says "step 1, then step 2,
  then step 3", wire those as `after`; if it just lists items, leave them
  independent.
- **Do not invent `validators` or `outputs` the document does not support.**
  The runtime will run validators as plain shell commands; only include them
  when the document specifies the check. Use spec-only `acceptanceCriteria` or
  `openQuestions` when the source document does not provide deterministic
  checks.
- **Do not use models outside the active model catalog.** Declare every chosen
  model in `modelRouting.scenarios`, then assign each node with `modelScenario`.
  Omit `modelScenario` only after warning the user that runtime fallback will
  use `defaultSubagentScenario` or the current Pi session model.
- **Every `after` edge needs evidence.** Before writing the spec, be able to
  explain what upstream state/artifact the dependent node consumes. Encode that
  state in `consumes` / `produces` and cite the source in `evidence`. If the edge
  is only based on list order or habit, remove it or ask the user.
- **Always round-trip through the runtime parser** so cycle / missing-dep /
  scenario-ref errors surface before the user sees the file.

- **A shallow DAG is acceptable** when nodes are independently executable and
  individually verifiable. Do not increase depth just to make the DAG look
  more detailed. The failure condition is oversized or unverifiable nodes,
  not shallow depth itself.
- **Candidate decomposition patterns suggest node boundaries, not
  dependency edges.** Only add `after` when consumes / produces / evidence
  supports the dependency.
- **Every node should have an acceptance handle:** `outputs`, `validators`,
  `acceptanceCriteria`, or `openQuestions` explaining unresolved acceptance.
  Nodes without any acceptance handle must not be marked low risk.
- **If a node requires major internal planning by the subagent**, run one
  refinement pass before writing the final spec.
- **If a broad node cannot be safely split from source evidence**, mark it
  high risk, add `openQuestions`, require `human-confirmation` gate, and
  explain why it could not be split.
- **If most implementation nodes require the strongest model**, run a
  model-cost sanity review before finalizing model assignments. If strong
  models remain justified, record the reason in the trace.

## Failure modes

- The document is a one-line objective. Stop and tell the user to use
  `/goal <objective>` instead.
- The document is too long (>20 nodes). Tell the user the default cap and
  ask whether to chunk the work into multiple goals.
- The validator list is non-deterministic (e.g. reads from CI variables).
  Reject the spec and ask for a deterministic command.
