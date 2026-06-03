---
name: goal-planner
description: Read a development document (PRD, OpenSpec change, design doc, ticket description) and produce a valid Goal DAG JSON file consumable by `/goal --dag`. Use when the user has a multi-step plan document and wants to drive the `agent-goal-runtime` from it instead of writing DAG JSON by hand.
---

# Goal Planner

This skill teaches the agent to convert a free-form development document into a
[Goal DAG](../goal-dag-format.md) JSON file that `agent-goal-runtime` can execute
via `/goal --dag <path>`.

The skill is intentionally **prompt + reference heavy, code-light**: the only
deterministic step is "turn a `GoalDagSpec` into a valid DAG file" and that step
is delegated to the [`agent-goal-runtime` builder
API](https://github.com/a5345534/agent-goal-runtime). All of the "how do I
extract milestones from this PRD?" reasoning is the agent's job.

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

## Workflow

1. **Read the document** with `read`. Do not invent content; the document is
   the source of truth for the goal objective and node list.
2. **Extract a `GoalDagSpec`**. Use this exact shape:

   ```ts
   interface GoalDagSpec {
     version?: 1;
     objective: string;          // one-sentence summary of the overall goal
     defaults?: { ... };         // copied to every node unless overridden
     modelRouting?: { ... };     // see references/routing-scenarios.md
     nodes: Array<{
       id: string;               // kebab-case, ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
       objective: string;        // work assigned to the subagent
       after?: string[];         // node ids that must complete first
       outputs?: string[];       // expected files / dirs for validation
       validators?: string[];    // shell validators
       conflicts?: { files?: string[]; modules?: string[]; capabilities?: string[] };
       scope?: string;
       risk?: "low" | "medium" | "high";
       completionGates?: string[];
       modelScenario?: string;
     }>;
   }
   ```

   See [`references/dag-format.md`](references/dag-format.md) for the full
   field reference and [`references/routing-scenarios.md`](references/routing-scenarios.md)
   for model-routing examples.

3. **Ask clarifying questions** when the document is ambiguous:
   - Are nodes A and B parallel, or does B depend on A?
   - Which modules / files does each node touch? (drives `conflicts`)
   - Is there a verification command per node? (drives `validators`)
   - Should a node use a different model? (drives `modelScenario`)

4. **Write the spec to a temp JSON file** and run:

   ```bash
   npx --package=agent-goal-planner agent-goal-planner build-dag \
     --spec <spec.json> --out <out.dag.json>
   ```

   The CLI delegates to `agent-goal-runtime`'s
   `buildGoalDagDocumentFromSpec()` and refuses to write an invalid DAG.

5. **Show the user the resulting DAG** (objective + node ids + dependency
   graph) and the diff vs. the document's intent, then ask whether to start:

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
  when the document specifies the check. Otherwise omit the field.
- **Do not include model scenarios the runtime does not know.** Either
  declare `modelRouting.scenarios` first, or omit `modelScenario` on the
  node and let the runtime fall back to `defaultSubagentScenario` or the
  current session model.
- **Always round-trip through the runtime builder** so cycle / missing-dep /
  scenario-ref errors surface before the user sees the file.

## Failure modes

- The document is a one-line objective. Stop and tell the user to use
  `/goal <objective>` instead.
- The document is too long (>20 nodes). Tell the user the default cap and
  ask whether to chunk the work into multiple goals.
- The validator list is non-deterministic (e.g. reads from CI variables).
  Reject the spec and ask for a deterministic command.
