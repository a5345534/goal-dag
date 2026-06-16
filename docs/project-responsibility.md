# Project Responsibility

Status: authoritative project-boundary document for this repository.

This document defines what this repository owns, what it must not own, and which artifact contracts it must honor. The repository should not need to know which concrete repository implements an upstream or downstream stage.

## Pipeline contract

```text
Stage 1: Specification Authoring   user intent -> governed specification package
Stage 2: Execution Planning        specification/development document -> runtime DAG JSON + optional planning trace
Stage 3: Runtime Execution         runtime DAG JSON or single objective -> durable execution state
```

This repository implements **Stage 2: Execution Planning**.

It must know the Stage 1 input artifact contract and the Stage 3 runtime DAG artifact contract. It must not depend on, call into, or name a concrete specification-authoring or runtime-execution repository.

## Owns

This repository owns:

- reading development documents for execution planning;
- reading governed specification packages through `source-manifest.json`;
- extracting source-grounded candidate execution nodes;
- dependency evidence review;
- recursive node decomposition review;
- node quality review;
- model assignment from the active model catalog;
- producer-side planning spec parsing;
- runtime DAG JSON composition;
- optional planning trace sidecar generation;
- round-trip validation through the runtime DAG parser contract.

## Does not own

This repository must not own or perform:

- user-goal value challenge;
- governed specification authoring;
- specification package creation or modification;
- runtime execution command invocation;
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

- governed specification package directories;
- PRDs;
- design docs;
- ticket descriptions;
- other source documents that can be mapped into a producer-side planning spec.

When input is a governed specification package directory, this repository must:

1. read `source-manifest.json` first;
2. read every source listed in `sources[]`;
3. treat proposal, design, tasks, and spec-delta entries as authoritative;
4. not treat human-readable explainers as authoritative;
5. not read upstream local workflow artifacts as source of truth;
6. stop or require manifest regeneration if the manifest is missing or stale;
7. preserve assumptions and open questions in the planning trace;
8. convert implementation-sensitive open questions into a decision node, a supported human-confirmation gate, or a DAG generation blocker.

## Outputs

Primary runtime handoff output:

```text
<name>.dag.json
```

Optional review output:

```text
<name>.trace.json
```

`<name>.dag.json` is the only Stage 3 runtime handoff artifact. `<name>.trace.json` is for humans and producer review only.

## Runtime DAG contract

The runtime DAG JSON may contain fields supported by the runtime contract, including:

- root `version`, `objective`, `defaults`, `modelRouting`, and `nodes`;
- node `id`, `objective`, `after`, `outputs`, `validators`, `conflicts`, `scope`, `kind`, `validation`, `workspaceStrategy`, `workspace`, `risk`, `completionGates`, `modelScenario`, and `thinkingLevel`;
- defaults such as `validators`, `workspaceStrategy`, `completionGates`, `conflicts`, `modelScenario`, and `thinkingLevel`;
- validation contract fields such as `profile`, `testSpecNodeId`, `approvedByNodeId`, `artifactLocks`, `requiredEvidence`, `diffBaseRef`, `auditReportPaths`, `allowedPaths`, and `forbiddenPaths`.

This repository must round-trip emitted DAG JSON through the runtime DAG parser contract before presenting it as ready for runtime execution. It validates the producer output is structurally acceptable to the runtime but does not enforce controller checks; evidence and validator satisfaction are runtime concerns handled by `goal-runner`.

Producer-side validation may reject runtime contract values that are known to be unsupported by the pinned runner parser/policy, such as unsupported `requiredEvidence` tokens. This is handoff preflight, not runtime evidence satisfaction or controller validation enforcement.

## Producer-only metadata

The following fields are producer-only and must never appear in runtime DAG JSON:

- root `openQuestions`;
- node `consumes`;
- node `produces`;
- node `evidence`;
- node `modelRationale`;
- node `acceptanceCriteria`;
- node `decompositionRationale`.

These fields may appear in producer-side planning specs and in the planning trace sidecar.

## Handoff contract

This repository hands off exactly one runtime input to any runtime-execution implementation:

```text
runtime DAG JSON file: <name>.dag.json
```

This repository may show a runtime execution command to the user, but it must not execute it.

This repository may also produce `<name>.trace.json`, but runtime execution must not consume the trace sidecar as runtime input. `goal-runner` owns runtime evidence satisfaction (`validators`, `requiredEvidence`, audit/path checks, etc.).

## Drift prevention rules

A change to this repository is suspicious and requires boundary review if it:

- creates or modifies governed specification source packages;
- invokes runtime execution commands;
- creates worktrees or subagent sessions;
- executes validators;
- implements runtime scheduler behavior;
- implements controller validation enforcement (including evidence/validator checks);
- writes lifecycle ledger data;
- emits producer-only metadata into `.dag.json`;
- depends on non-authoritative explainer content as source of truth;
- treats upstream local workflow artifacts as source of truth;
- requires a concrete upstream or downstream repository name to function.

## Reviewer checklist

Before merging a change to this repository, verify:

- governed specification input still goes through `source-manifest.json` and authoritative sources;
- no specification-authoring responsibility was introduced;
- no runtime execution command invocation was introduced;
- the runtime DAG is validated by the runtime parser contract by `goal-dag`; evidence/runtime validation is delegated to `goal-runner`;
- producer-only metadata is stripped from `.dag.json`;
- runtime fields supported by the runtime DAG contract are preserved when supplied;
- evidence-related runtime behavior (`requiredEvidence`, validator execution, audit/path-policy checks) is not implemented in this stage.
- `.trace.json` remains optional and non-runtime;
- docs and schema match the actual planning-spec builder behavior;
- the repository does not need to know the concrete repository names of adjacent stages.
