# Architecture decision: why `agent-goal-planner` is a separate repository

> Status: accepted 2026-06-04
> Applies to: `a5345534/agent-goal-planner` and the `agent-goal-runtime` API surface it depends on

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

1. **A planner built into `agent-goal-runtime`.** The runtime would
   expose a `buildGoalDagDocumentFromSpec()` API; user / agent code
   could compose a `GoalDagSpec` and hand it to the runtime to produce
   a validated DAG file.
2. **A planner as a separate package.** The runtime would stay a
   consumer of DAG files (parser, validator, scheduler). The planner
   would own the producer side: parsing a spec, composing a draft
   document, round-tripping it through the runtime's parser for
   validation, and writing the file.

## Decision

We chose (2). The planner lives in a separate repository
(`a5345534/agent-goal-planner`), depends on
`agent-goal-runtime@^0.1.1`, and owns the producer side end-to-end.
The runtime owns the consumer side and exposes only:

- `parseGoalDagFileDocument` — parser + validator (id pattern,
  dependency existence, self-dependency, cycle, model-scenario
  referential integrity, etc.)
- The `GoalDagFileDocument` / `GoalDagFileNode` / `GoalDagFileDefaults`
  / `GoalDagConflictHints` / `GoalDagNode` / `GoalModelRoutingConfig`
  types.

A small Pi skill (`/skill:goal-planner`) ships in the planner
package; it teaches an agent to read a development document, extract
a `GoalDagSpec`, and call the planner's CLI to produce a DAG file
ready for `/goal --dag <path>`.

## Consequences

### Runtime stays lean

- The runtime's API surface remains "I can read this DAG file." It
  does not know about specs, planners, or document formats.
- `node:fs` is no longer pulled into the core module path
  (an earlier draft had a `writeGoalDagFileFromSpec` in the runtime;
  moving the producer side out removed that dep).
- Spec shape evolution belongs to the planner layer, not the
  runtime. A new planner (Linear → DAG, Jira → DAG, OpenSpec change
  → DAG) can ship without touching the runtime.

### The parser remains the single source of truth

- The planner's `buildGoalDagFromSpec()` composes a draft
  `GoalDagFileDocument` from the spec and round-trips it through
  `parseGoalDagFileDocument`. All structural / graph /
  referential-integrity rules live in one place.
- The cycle detection added in `agent-goal-runtime@0.1.1` is the
  same check the planner surfaces to the user before the file is
  written.

### The dependency surface is small and explicit

```json
{
  "dependencies": {
    "agent-goal-runtime": "github:a5345534/agent-goal-runtime#v0.1.1"
  }
}
```

Pinned to a tag, not a range, so planner releases are reproducible
and the runtime's release cadence does not silently pull breaking
changes into the planner.

### The skill is prompt + reference heavy, code-light

- The skill's `SKILL.md` teaches the agent how to extract a
  `GoalDagSpec` from a document (creative work, the LLM's job).
- The CLI (`agent-goal-planner build-dag --spec ... --out ...`) is a
  thin shell over the spec parser and the runtime round-trip
  (mechanical work, deterministic code).
- The `references/` directory has DAG format and model-routing
  examples for the agent to load on demand.

This split keeps the creative and mechanical parts on opposite sides
of a stable API boundary.

## Data flow

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   ┌────────────┐    spec      ┌─────────────────┐    file      │
│   │  LLM /     │  extraction  │  agent-goal-    │   written    │
│   │  agent     ├─────────────►│  planner CLI    ├──────────────►│
│   │  (skill)   │              │  (build-dag)    │              │
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

If a future planner needs the runtime to ship its own builder helper
(for example, to give the Pi adapter a one-call "spec → orchestrable
DAG" path that bypasses the file system), the right move is to:

1. Promote `buildGoalDagDocumentFromSpec` to a stable runtime export
   behind a `GoalDagSpec` type that the runtime also owns.
2. Bump the runtime's major version and the planner's dep range.
3. Have the planner's CLI keep its current behavior as a thin
   wrapper, so existing skill workflows do not change.

The decision recorded here is therefore not a one-way door, but the
default until something concrete forces the change.
