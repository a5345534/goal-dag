# Architecture decision: why `goal-dag` is a separate repository

> Status: accepted 2026-06-04
> Applies to: `a5345534/goal-dag` and the `agent-goal-runtime` API surface it depends on

## Context

`agent-goal-runtime` defines a strict JSON DAG file format that
`/goal --dag <path>` consumes (see
[`docs/goal-dag-format.md`](https://github.com/a5345534/agent-goal-runtime/blob/main/docs/goal-dag-format.md)).
Writing that JSON by hand is error-prone — kebab-case ids, acyclic
dependencies, model-scenario referential integrity, expected outputs,
validators, conflict hints — and users who want to drive `/goal` from
a free-form development document (PRD, design doc, OpenSpec change)
should not have to learn the schema just to get started.

We considered two designs for closing that gap:

1. **A Goal DAG producer built into `agent-goal-runtime`.** The runtime
   would expose a `buildGoalDagDocumentFromSpec()` API; user / agent code
   could compose a `GoalDagSpec` and hand it to the runtime to produce
   a validated DAG file.
2. **A Goal DAG producer as a separate package.** The runtime would stay a
   consumer of DAG files (parser, validator, scheduler). The producer
   package would own the write side: parsing a spec, composing a draft
   document, round-tripping it through the runtime's parser for
   validation, and writing the file.

## Decision

We chose (2). `goal-dag` lives in a separate repository
(`a5345534/goal-dag`), depends on
`agent-goal-runtime@^0.1.1`, and owns the producer side end-to-end.
The runtime owns the consumer side and exposes only:

- `parseGoalDagFileDocument` — parser + validator (id pattern,
  dependency existence, self-dependency, cycle, model-scenario
  referential integrity, etc.)
- The `GoalDagFileDocument` / `GoalDagFileNode` / `GoalDagFileDefaults`
  / `GoalDagConflictHints` / `GoalDagNode` / `GoalModelRoutingConfig`
  types.

A small Pi skill (`/skill:goal-dag`) ships in the `goal-dag`
package; it teaches an agent to read a development document, extract
a `GoalDagSpec`, and call the `goal-dag` CLI to produce a DAG file
ready for `/goal --dag <path>` plus an optional planning trace sidecar for
review.

## Consequences

### Runtime stays lean

- The runtime's API surface remains "I can read this DAG file." It
  does not know about specs, producer packages, or document formats.
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
- The cycle detection added in `agent-goal-runtime@0.1.1` is the
  same check `goal-dag` surfaces to the user before the file is
  written.

### The dependency surface is small and explicit

```json
{
  "dependencies": {
    "agent-goal-runtime": "github:a5345534/agent-goal-runtime#v0.1.1"
  }
}
```

Pinned to a tag, not a range, so `goal-dag` releases are reproducible
and the runtime's release cadence does not silently pull breaking
changes into `goal-dag`.

### The skill is prompt + reference heavy, code-light

- The skill's `SKILL.md` teaches the agent how to extract a
  `GoalDagSpec` from a document (creative work, the LLM's job).
- The skill reads a model catalog and asks the LLM to assign models
  based on task objective, scope, risk, validators, context size, and
  required modalities. This is intentionally LLM judgment, not a hard-coded
  heuristic.
- The CLI (`goal-dag build-dag --spec ... --out ... [--trace ...]`) is a
  thin shell over the spec parser, the runtime round-trip, and optional trace
  sidecar generation (mechanical work, deterministic code).
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

`dist/` is **committed to the repo**, not gitignored. The runtime
package uses the same policy. The reason is concrete:

`pi install` runs `npm install --omit=dev`, so `tsc` is not on PATH
during install. Any `prepare` hook that tries to build will fail
with `sh: 1: tsc: not found` and the package will install without a
working CLI. Shipping a pre-built `dist/` makes the package
install-anywhere with no install-time build.

The dev workflow compensates: any change to `src/` must be
rebuilt and the new `dist/` must be committed alongside the source
change. The `prepack` hook still rebuilds on `npm pack` /
`npm publish` to catch stale build output at release time.

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
│   │  Dev doc   │              │  agent-goal-    │              │
│   │  (PRD,     │              │  runtime        │              │
│   │  OpenSpec, │              │  parseGoalDag   │              │
│   │  etc.)     │              │  FileDocument   │              │
│   └────────────┘              └─────────────────┘              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

                                       │
                                       │ /goal --dag <file>
                                       ▼

                                ┌─────────────────┐
                                │  /goal          │
                                │  controller +   │
                                │  subagent       │
                                │  orchestration  │
                                └─────────────────┘
```

## Reversibility

If a future producer workflow needs the runtime to ship its own builder helper
(for example, to give the Pi adapter a one-call "spec → orchestrable
DAG" path that bypasses the file system), the right move is to:

1. Promote `buildGoalDagDocumentFromSpec` to a stable runtime export
   behind a `GoalDagSpec` type that the runtime also owns.
2. Bump the runtime's major version and `goal-dag`'s dep range.
3. Have the `goal-dag` CLI keep its current behavior as a thin
   wrapper, so existing skill workflows do not change.

The decision recorded here is therefore not a one-way door, but the
default until something concrete forces the change.
