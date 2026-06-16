# Architecture decision: why `goal-dag` is a separate repository

> Status: accepted 2026-06-04
> Applies to: `a5345534/goal-dag` and the Stage 3 goal-runner runtime API surface it depends on

## Context

The Stage 3 **goal-runner** runtime defines a strict JSON DAG file format that
`/goal --dag <path>` consumes, and it exports the parser/types used by this
repository (see [`docs/goal-dag-format.md`](https://github.com/a5345534/goal-runner/blob/main/docs/goal-dag-format.md)).
Writing that JSON by hand is error-prone — kebab-case ids, acyclic dependencies,
model-scenario referential integrity, expected outputs, validation contracts,
validators, conflict hints — and users who want to drive `/goal` from a
free-form development document (PRD, design doc, OpenSpec change) should not
have to learn the schema just to get started.

We considered two designs for closing that gap:

1. **A Goal DAG producer built into the goal-runner runtime package.** The
   runtime would expose a `buildGoalDagDocumentFromSpec()` API; user / agent
   code could compose a `GoalDagSpec` and hand it to the runtime to produce a
   validated DAG file.
2. **A Goal DAG producer as a separate package.** The runner would stay a
   consumer of DAG files (parser, validator, scheduler). The producer package
   would own the write side: parsing a spec, composing a draft document,
   round-tripping it through the runner parser for validation, and writing the
   file.

## Decision

We chose (2). `goal-dag` lives in a separate repository
(`a5345534/goal-dag`), depends on `goal-runner` pinned by git ref, and owns the
Stage 2 producer side end-to-end. The goal-runner runtime owns the consumer side
and exposes only:

- `parseGoalDagFileDocument` — parser + validator (id pattern,
  dependency existence, self-dependency, cycle, model-scenario
  referential integrity, runtime `kind` / `validation` field shape, etc.)
- The `GoalDagFileDocument` / `GoalDagFileNode` / `GoalDagFileDefaults`
  / `GoalDagConflictHints` / `GoalDagNode` / `GoalModelRoutingConfig`
  types.

A small Pi skill (`/skill:goal-dag`) ships in the `goal-dag`
package; it teaches an agent to read a development document, extract
a `GoalDagSpec`, and call the `goal-dag` CLI to produce a DAG file
ready for handoff to the goal-runner stage via `/goal --dag <path>` plus an
optional planning trace sidecar for review. The skill shows the handoff command
but does not execute it.

## Consequences

### Runtime stays lean

- The goal-runner runtime API surface remains "I can read and execute this DAG
  file." It does not know about specs, producer packages, or document formats.
- `node:fs` is no longer pulled into the core module path
  (an earlier draft had a `writeGoalDagFileFromSpec` in the runtime;
  moving the producer side out removed that dep).
- Spec shape evolution belongs to the producer layer, not the
  runtime. A new document-to-DAG workflow (Linear → DAG, Jira → DAG,
  OpenSpec change → DAG) can ship without touching the runtime.

### The parser remains the single source of truth

- `goal-dag`'s `buildGoalDagFromSpec()` composes a draft
  `GoalDagFileDocument` from the spec and round-trips it through
  `parseGoalDagFileDocument`. All structural / graph /
  referential-integrity rules live in one place.
- Spec-only planning metadata (`consumes`, `produces`, `evidence`,
  `modelRationale`, `acceptanceCriteria`, `decompositionRationale`, and
  root-level `openQuestions`) is stripped before runtime validation and may be
  emitted separately by `buildGoalDagPlanningTrace()`.
- The runner parser's checks are the same checks `goal-dag` surfaces to the
  user before the file is written.

### The dependency surface is small and explicit

```json
{
  "dependencies": {
    "goal-runner": "github:a5345534/goal-runner#8a0f9a00ab9c51142e17eba856a1f757daad1d07"
  }
}
```

Pinned to a tag or commit, not a range, so `goal-dag` releases are reproducible
and the runner runtime's release cadence does not silently pull breaking
changes into `goal-dag`. The pinned commit is the version-sync proof for the
Stage 3 parser/schema surface; it includes `validation.allowedPaths`,
`validation.forbiddenPaths`, and `defaults.thinkingLevel`.

### The skill is prompt + reference heavy, code-light

- The skill's `SKILL.md` teaches the agent how to extract a
  `GoalDagSpec` from a document (creative work, the LLM's job).
- The skill reads a model catalog and asks the LLM to assign models
  based on task objective, scope, risk, validators, context size, and
  required modalities. This is intentionally LLM judgment, not a hard-coded
  heuristic.
- The CLI (`goal-dag build-dag --spec ... --out ... [--trace ...]`) is a
  thin shell over the spec parser, the runner parser round-trip, and optional
  trace sidecar generation (mechanical work, deterministic code). It does not
  run `/goal`, validators, subagents, worktree creation, implementation edits,
  or OpenSpec source package changes.
- The `references/` directory has DAG format, model-routing, and
  model-catalog examples for the agent to load on demand.

This split keeps the creative and mechanical parts on opposite sides
of a stable API boundary.

### Model assignment is LLM-driven through a catalog

The `goal-dag` package ships `catalogs/pi-available-models.json`. The catalog
contains ordered model-routing rules that map agent/LLM-facing task traits
(task type, risk, privacy, and estimated context) to recommended Pi model ids.

The deterministic part validates the catalog shape. The creative part remains
with the LLM: the skill must show a model assignment table, translate chosen
catalog scenarios into runtime-compatible `modelRouting.scenarios`, and then
write explicit per-node `modelScenario` values plus `modelRationale` into the
`GoalDagSpec`.

Project-specific catalogs can override the package default through
`.goal/model-catalog.json`.

### The build artifact is committed

`dist/` is **committed to the repo**, not gitignored. The reason is concrete:
`pi install` runs `npm install --omit=dev`, so `tsc` is not on PATH during
install. Any `prepare` hook that tries to build will fail with
`sh: 1: tsc: not found` and the package will install without a working CLI.
Shipping a pre-built `dist/` makes the package install-anywhere with no
install-time build.

The dev workflow compensates: any change to `src/` must be rebuilt and the new
`dist/` must be committed alongside the source change. The `prepack` hook still
rebuilds on `npm pack` / `npm publish` to catch stale build output at release
time.

## Data flow

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   ┌────────────┐    spec      ┌─────────────────┐    file      │
│   │  LLM /     │  extraction  │  goal-dag CLI   │ DAG + trace  │
│   │  agent     ├─────────────►│  build-dag      ├──────────────►│
│   │  (skill)   │              │  --trace        │              │
│   └────────────┘              └────────┬────────┘              │
│        ▲                              │                        │
│        │ reads                        │ round-trips            │
│        │                              ▼                        │
│   ┌────────────┐              ┌─────────────────┐              │
│   │  Dev doc   │              │  goal-runner    │              │
│   │  (PRD,     │              │  parser         │              │
│   │  OpenSpec, │              │                 │              │
│   │  etc.)     │              │                 │              │
│   └────────────┘              └─────────────────┘              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

                                       │
                                       │ /goal --dag <file>
                                       ▼

                                ┌─────────────────┐
                                │  goal-runner    │
                                │  controller +   │
                                │  subagent       │
                                │  orchestration  │
                                └─────────────────┘
```

## Reversibility

If a future producer workflow needs the runtime to ship its own builder helper
(for example, to give the Pi adapter a one-call "spec → orchestrable
DAG" path that bypasses the file system), the right move is to:

1. Promote `buildGoalDagDocumentFromSpec` to a stable runner/runtime export
   behind a `GoalDagSpec` type that the runtime also owns.
2. Bump the runner/runtime major version and `goal-dag`'s dep range.
3. Have the `goal-dag` CLI keep its current behavior as a thin
   wrapper, so existing skill workflows do not change.

The decision recorded here is therefore not a one-way door, but the
default until something concrete forces the change.
