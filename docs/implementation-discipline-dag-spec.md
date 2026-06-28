# Implementation Discipline DAG Spec

Status: draft  
Owner: `goal-dag`  
Applies to: Stage 2 DAG production from PRDs, OpenSpec changes, design docs, and ticket descriptions

## Purpose

Translate Karpathy-inspired implementation discipline into concrete DAG authoring behavior. The DAG producer should reduce ambiguity before execution and give each executor node a verifiable, bounded goal.

## Decisions

1. `goal-dag` should treat `implementation-discipline` as a quality profile for implementation nodes.
2. The producer should not copy or depend on the `andrej-karpathy-skills` repository. It should emit goal-runner-compatible profile metadata and node contracts.
3. Ambiguity should be handled before DAG emission when it materially affects architecture, product behavior, compatibility, or validation.
4. Minor ambiguity should become an explicit bounded assumption in the node objective/scope, not a silent guess.
5. Every implementation node should have an execution kernel: objective, non-goals or scope boundaries, expected outputs, verification evidence, and allowed/forbidden change scope where available.

## DAG Authoring Rules

### 1. Think Before Coding

Before emitting nodes, the producer should detect material ambiguity:

- multiple incompatible interpretations of the requested behavior;
- missing product/API decisions;
- unclear ownership between repositories or packages;
- validation requirements that cannot verify the requested outcome;
- scope that would force broad unrelated refactors.

If the ambiguity is material, the producer should request clarification or mark the handoff as not ready. If the ambiguity is minor, the DAG should record the recommended safe assumption.

### 2. Simplicity First

The DAG should prefer small, directly verifiable nodes. Avoid nodes whose objective implies speculative frameworks, broad abstractions, or optional features not requested by the source document.

### 3. Surgical Changes

Each node should constrain scope with the strongest available mechanism:

- `scope` prose for human-readable boundaries;
- `expectedOutputs` for concrete files/artifacts;
- validation `allowedPaths` and `forbiddenPaths` when path boundaries are known;
- dependencies that prevent unrelated work from being bundled into one node.

### 4. Goal-Driven Verification

Each node should include verification expectations. Bugfix nodes should prefer a reproduction test or equivalent failure evidence before the fix. Implementation nodes should include validators or required evidence whenever feasible.

## Recommended Node Shape

For nodes using `implementation-discipline`, the producer should encode:

- objective: concise task outcome;
- scope: include non-goals and boundaries;
- expected outputs: files, docs, migrations, or reports;
- validation: commands, evidence, and path policy;
- quality profiles: include `implementation-discipline` when supported;
- risk: set high/medium when ambiguity or broad blast radius remains.

## Clarification Handoff

Subagent questions are a runtime concern, but the DAG can reduce them by preserving context. When a node proceeds with a bounded assumption, include it in `scope` or validation notes so the controller can answer later subagent questions from DAG context.

## Acceptance Criteria

- Generated DAGs make material assumptions visible before execution.
- Implementation nodes are small enough for surgical changes and concrete verification.
- High-risk nodes include validation contracts or explicit rationale for why validation cannot be automated.
- The runner can apply `implementation-discipline` without requiring the DAG producer to embed harness-specific prompt text.
