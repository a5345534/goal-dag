# Project Responsibility

Status: authoritative project-boundary document for `goal-dag`.

This document defines what this repository owns, what it must not own, and how it receives and hands off work in the three-stage goal execution pipeline.

## Pipeline position

```text
Stage 1: goal-spec   user goal -> OpenSpec change package
Stage 2: goal-dag    OpenSpec/PRD/design/ticket -> validated Goal DAG JSON + optional trace
Stage 3: goal-runner Goal DAG JSON -> runtime execution
```

`goal-dag` is Stage 2 only. Its job is to turn an already-authored planning document into a validated runtime DAG JSON file that `goal-runner` can execute.

## Owns

`goal-dag` owns:

- reading development documents for execution planning;
- reading OpenSpec change packages through `source-manifest.json`;
- extracting source-grounded candidate nodes;
- dependency evidence review;
- recursive node decomposition review;
- node quality review;
- model assignment from the active model catalog;
- producer-side `GoalDagSpec` parsing;
- runtime DAG JSON composition;
- optional planning trace sidecar generation;
- round-trip validation through the `goal-runner` parser.

## Does not own

`goal-dag` must not own or perform:

- user-goal value challenge or OpenSpec authoring;
- OpenSpec change package creation or modification;
- `/goal` execution;
- subagent session management;
- worktree allocation;
- validator execution;
- branch integration;
- runtime scheduling;
- completion or blocked-state decisions;
- lifecycle ledger behavior;
- controller validation enforcement.

## Inputs

Valid Stage 2 inputs include:

- `openspec/changes/<change-name>/` directories produced by `goal-spec`;
- PRDs;
- design docs;
- ticket descriptions;
- other source documents that can be mapped into a `GoalDagSpec`.

When input is an OpenSpec change directory, `goal-dag` must:

1. read `source-manifest.json` first;
2. read every source listed in `sources[]`;
3. treat `proposal`, `design`, `tasks`, and `spec-delta` entries as authoritative;
4. not treat `change-explainer.html` as authoritative;
5. not read `.goal-spec/` workflow artifacts as source of truth;
6. stop or require manifest regeneration if the manifest is missing or stale;
7. preserve assumptions and open questions in the planning trace;
8. convert implementation-sensitive open questions into a decision node, a supported human-confirmation gate, or a DAG generation blocker.

## Outputs

Primary output:

```text
<name>.dag.json
```

Optional review output:

```text
<name>.trace.json
```

`<name>.dag.json` is the only Stage 3 runtime handoff artifact. `<name>.trace.json` is for humans and producer review only.

## Runtime DAG contract

The runtime DAG JSON may contain fields supported by `goal-runner`, including:

- root `version`, `objective`, `defaults`, `modelRouting`, and `nodes`;
- node `id`, `objective`, `after`, `outputs`, `validators`, `conflicts`, `scope`, `kind`, `validation`, `workspaceStrategy`, `workspace`, `risk`, `completionGates`, `modelScenario`, and `thinkingLevel`;
- defaults such as `validators`, `workspaceStrategy`, `completionGates`, `conflicts`, `modelScenario`, and `thinkingLevel`;
- validation contract fields such as `profile`, `testSpecNodeId`, `approvedByNodeId`, `artifactLocks`, `requiredEvidence`, `diffBaseRef`, `auditReportPaths`, `allowedPaths`, and `forbiddenPaths`.

`goal-dag` must round-trip the emitted DAG through the `goal-runner` parser before presenting it as ready for `/goal --dag`.

## Producer-only metadata

The following fields are producer-only and must never appear in runtime DAG JSON:

- root `openQuestions`;
- node `consumes`;
- node `produces`;
- node `evidence`;
- node `modelRationale`;
- node `acceptanceCriteria`;
- node `decompositionRationale`.

These fields may appear in `GoalDagSpec` and in the planning trace sidecar.

## Handoff to `goal-runner`

`goal-dag` hands off exactly one runtime input to `goal-runner`:

```text
/goal --dag <name>.dag.json
```

The command may be shown to the user, but `goal-dag` must not execute it.

`goal-dag` may also produce `<name>.trace.json`, but `goal-runner` must not consume the trace sidecar as runtime input.

## Drift prevention rules

A change to this repository is suspicious and requires boundary review if it:

- creates or modifies OpenSpec source packages;
- invokes `/goal`;
- creates worktrees or subagent sessions;
- executes validators;
- implements runtime scheduler behavior;
- implements controller validation enforcement;
- writes lifecycle ledger data;
- emits producer-only metadata into `.dag.json`;
- depends on non-authoritative `change-explainer.html` content as source of truth;
- treats `.goal-spec/` workflow artifacts as source of truth.

## Reviewer checklist

Before merging a change to `goal-dag`, verify:

- OpenSpec input still goes through `source-manifest.json` and authoritative sources;
- no OpenSpec authoring responsibility was introduced;
- no `/goal` execution was introduced;
- the runtime DAG is validated by `goal-runner` parser;
- producer-only metadata is stripped from `.dag.json`;
- runtime fields supported by `goal-runner` are preserved when supplied;
- `.trace.json` remains optional and non-runtime;
- docs and schema match the actual `GoalDagSpec` builder behavior.
