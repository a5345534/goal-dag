# goal-dag

`goal-dag` is the **Stage 2 Goal DAG producer** in the three-stage agent pipeline:

```text
OpenSpec / PRD / design doc / ticket
→ GoalDagSpec
→ validated <name>.dag.json
→ optional <name>.trace.json
→ goal-runner stage via /goal --dag <path>
```

The Stage 3 runner accepts a strict JSON DAG file via `/goal --dag <path>`.
Writing that JSON by hand is error-prone (kebab-case ids, acyclic dependencies,
model-scenario referential integrity, etc.). This package adds a thin producer
layer before the runner:

- A programmatic `GoalDagSpec` builder API.
- A small CLI: `goal-dag build-dag --spec <in> --out <out> [--trace <trace>]`.
- A Pi skill (`/skill:goal-dag`) that teaches an agent to extract a
  spec from a PRD, design doc, or OpenSpec change, assign models from
  a catalog, and emit a valid DAG file.

The runner runtime stays the source of truth for the DAG schema and validation.
This package only does two things:

1. Reads a spec (which the agent or a script produces).
2. Composes a draft DAG file from the spec and round-trips it through the
   `goal-runner` parser exported as `parseGoalDagFileDocument()`. The parser is
   the single source of truth for id pattern, dependency existence,
   self-dependency, cycle, model-scenario referential integrity, and runtime
   DAG field validation. The builder refuses to write an invalid DAG.

For reviewability, `GoalDagSpec` may also carry spec-only planning metadata
(`consumes`, `produces`, `evidence`, `modelRationale`, `acceptanceCriteria`,
`decompositionRationale`, and root-level `openQuestions`). The builder strips
those fields from the runtime DAG and can write a separate planning trace
sidecar JSON. When `openQuestions` are used as a node acceptance handle, prefix
the question with `<node-id>:` so the trace can be reviewed against that node.

## Naming note: goal-runner

`goal-dag` depends on `goal-runner` for the Stage 3 parser/types and uses
`goal-runner` consistently in code and user-facing docs.

- `goal-dag` is Stage 2 and only produces validated DAG JSON plus optional trace
  JSON.
- `goal-runner` is Stage 3 and executes DAGs through `/goal --dag <path>`.

## Install

Install once via Pi (matches the runtime package's pattern):

```bash
pi install git:github.com/a5345534/goal-dag
```

For an existing installation, update `goal-dag` with `pi update` instead of
reinstalling:

```bash
pi update git:github.com/a5345534/goal-dag
# or update all Pi packages:
pi update
```

The runtime dependency is pinned via `goal-dag`'s own `package.json` to
`github:a5345534/goal-runner#8a0f9a00ab9c51142e17eba856a1f757daad1d07`, so a
single install or update brings in the Stage 2 producer plus the Stage 3
parser/runtime API it validates against. This pin includes `validation.allowedPaths`,
`validation.forbiddenPaths`, and `defaults.thinkingLevel` support.

For a local-development checkout:

```bash
git clone https://github.com/a5345534/goal-dag
cd goal-dag
npm install      # devDeps only
npm run build
```

Then add the local path to `~/.pi/agent/settings.json` (or project
`.pi/settings.json`):

```json
{
  "packages": ["/absolute/path/to/goal-dag"]
}
```

## CLI

```bash
# 1. Write a spec.json (the agent fills this in via the /skill:goal-dag workflow)
# 2. Build a validated DAG file plus optional planning trace:
npx goal-dag build-dag --spec spec.json --out goal.dag.json --trace goal.trace.json
# 3. Hand the file to the goal-runner stage yourself:
/goal --dag goal.dag.json
```

The CLI is a thin wrapper over `buildGoalDagFromSpecFile()` from
`goal-dag`'s public API. It does not execute `/goal`, create worktrees, run
validators, manage subagents, decide goal completion/blocked, modify
implementation files, or modify OpenSpec source packages.

Producer-side schema reference: [`schemas/goal-dag-spec.schema.json`](schemas/goal-dag-spec.schema.json).

## Programmatic API

```ts
import {
  parseGoalDagSpec,
  buildGoalDagFromSpec,
  buildGoalDagPlanningTrace,
  serializeGoalDagDocument,
  serializeGoalDagPlanningTrace,
  validateGoalDagJson,
  type GoalDagSpec,
} from "goal-dag";

const spec: GoalDagSpec = {
  objective: "Ship the People Frappe backend slices",
  nodes: [
    {
      id: "attendance-parity",
      objective: "Add attendance parity fixtures",
      workspace: { worktreeSlug: "attendance-parity" },
      outputs: ["tests/test_attendance_parity.py"],
    },
    {
      id: "payroll-doctypes",
      objective: "Add payroll DocTypes",
      acceptanceCriteria: ["Payroll DocType changes are reviewable against the source requirement"],
      decompositionRationale: "Single bounded DocType artifact slice",
    },
    {
      id: "integration-validation",
      objective: "Run integrated validation",
      kind: "validation",
      validation: {
        profile: "code-change",
        testSpecNodeId: "attendance-parity",
        diffBaseRef: "main",
        allowedPaths: ["tests/**", "people_frappe/**"],
        forbiddenPaths: ["package-lock.json", "infra/**"],
      },
      after: ["attendance-parity", "payroll-doctypes"],
      consumes: ["attendance fixtures complete", "payroll doctypes complete"],
      produces: ["integrated validation complete"],
      evidence: [{ source: "prd.md#validation", quote: "Run validation after both slices land" }],
      modelScenario: "review",
      modelRationale: "Fan-in validation benefits from review-oriented reasoning",
    },
  ],
};

const document = buildGoalDagFromSpec(spec);          // throws on invalid spec
const trace = buildGoalDagPlanningTrace(spec, document); // review sidecar data
const json = serializeGoalDagDocument(document);      // pretty runtime DAG JSON
const traceJson = serializeGoalDagPlanningTrace(trace); // pretty trace JSON
const reparsed = validateGoalDagJson(json);           // smoke check
```

For native-git nodes, the builder emits `workspace.worktreeSlug = node.id` when
omitted. Expected `outputs` are emitted relative to that node workspace root; do
not put `.worktrees/<slug>/...` in artifact paths.

Spec-only planning fields are accepted for trace generation but are never emitted
in the runtime DAG JSON. Use them to explain dependencies, acceptance criteria,
decomposition rationale, unresolved node-level questions, and model choices.
Runtime fields such as `kind`, `validation`, `thinkingLevel`, `workspace`,
`completionGates`, and `modelScenario` are preserved in the emitted DAG and
validated by the runner parser.

## Producer boundary

`goal-dag` is intentionally Stage 2 only. It must not:

- Execute `/goal --dag`.
- Manage subagents or create worktrees.
- Run runtime validators.
- Decide goal completion or blocked state.
- Modify implementation files.
- Create or modify OpenSpec source packages.
- Preserve producer-only trace metadata in the runtime DAG JSON.

Every emitted DAG JSON is validated by the runner parser before it is shown as
ready for handoff.

## Pi skill

The skill lives at `skills/goal-dag/SKILL.md` and ships in the npm
tarball. Once installed, the agent can run:

```text
/skill:goal-dag .goal/people-frappe-prd.md
```

The skill walks the agent through:

1. Reading the document.
2. Reading the active model catalog (`.goal/model-catalog.json` when present,
   otherwise `catalogs/pi-available-models.json`).
3. Running a planning-quality pass: evidence table → abstract transition graph
   → recursive decomposition review → node quality review →
   dependency/critical-path review, with a skeptical judge pass for high-risk
   or ambiguous plans.
4. Asking clarifying questions about dependencies, conflicts, validators,
   unresolved acceptance handles, redundant shortcut nodes, and model assignment.
5. Producing a model assignment table and, when most implementation leaves need
   the strongest model, a model-cost sanity review table.
6. Writing `modelRouting.scenarios`, a dedicated `controllerScenario`, and
   per-node `modelScenario` / `modelRationale` into the `GoalDagSpec`.
7. Writing the `GoalDagSpec` JSON with spec-only planning metadata for traceability.
8. Running the CLI to build a parser-valid DAG file and trace sidecar.
9. Showing the user the resulting DAG, `nodeQuality` trace warnings/open questions,
   and the exact `/goal --dag <out.dag.json>` handoff command without executing it.

## Model catalog

The package ships a default Pi model-routing catalog at
[`catalogs/pi-available-models.json`](catalogs/pi-available-models.json). It
contains ordered `modelRouting.rules` that map task traits (task type, risk,
privacy, and estimated context) to a recommended `modelScenario` and Pi model id.

Project-specific overrides should live at `.goal/model-catalog.json`. The skill
prefers that file when it exists. The catalog's role is to inform LLM judgment;
the LLM still chooses the final controller and per-node `modelScenario`
assignments, declares runtime-compatible `modelRouting.scenarios`, sets a
`controllerScenario`, and shows a model assignment table before writing the DAG.
If most implementation leaves require the strongest model, the skill runs a
model-cost sanity review before finalizing the assignments.

Schema: [`schemas/model-catalog.schema.json`](schemas/model-catalog.schema.json).

## Architecture

See [`docs/architecture-decision.md`](docs/architecture-decision.md) for
the rationale behind splitting this Stage 2 Goal DAG producer out from the Stage
3 runner/runtime API surface it depends on.

```
┌────────────────────────────────────────┐
│  goal-runner stage                     │
│  - parseGoalDagFileDocument (parser)   │
│  - GoalDagFileDocument / types         │
└────────────────────────────────────────┘
                  ▲
                  │ uses
                  │
┌────────────────────────────────────────┐
│  goal-dag (this package)               │
│  - parseGoalDagSpec (loose spec JSON)  │
│  - buildGoalDagFromSpec (delegates)    │
│  - buildGoalDagPlanningTrace (sidecar) │
│  - CLI: build-dag                      │
│  - Pi skill: goal-dag                  │
└────────────────────────────────────────┘
```

The goal-runner runtime owns the schema, validation, scheduling, validator
execution, completion decisions, and subagent orchestration. `goal-dag` owns the
"how do I extract a DAG from a document" prompt / script / agentic workflow and
the optional planning trace sidecar. New document-to-DAG workflows (Linear
tickets, Jira epics, OpenSpec changes) can ship as additional skills or scripts
under this package without touching the runner.

## Development

```bash
npm install
npm run check   # build + tests
```

### Build artifact policy

`dist/` is **committed to the repo**, not gitignored. The runtime
package does the same. The reason: `pi install` runs
`npm install --omit=dev`, which means `tsc` is not on PATH during
install — any `prepare` hook that tries to build will fail with
`sh: 1: tsc: not found`. Shipping a pre-built `dist/` makes the
package install-anywhere.

**When you change `src/`, you must also rebuild `dist/` and commit
the regenerated build output** — otherwise the published package
will still ship the old compiled code:

```bash
npm run check   # builds + runs tests
git add src/ dist/
git commit
```

The `prepack` script still rebuilds on `npm pack` / `npm publish`
to catch stale artifacts at release time.

### Runtime dependency

The package depends on `goal-runner` via a git ref:

```json
"goal-runner": "github:a5345534/goal-runner#8a0f9a00ab9c51142e17eba856a1f757daad1d07"
```

Pin to a tag or commit so `goal-dag` releases are reproducible. The pinned commit
is the version-sync proof for the Stage 3 parser/schema surface: it includes
`validation.allowedPaths`, `validation.forbiddenPaths`, and
`defaults.thinkingLevel`. The runtime API surface `goal-dag` depends on:

- `parseGoalDagFileDocument` (parser + validator)
- `GoalDagFileDocument`, `GoalDagFileNode`, `GoalDagFileDefaults`,
  `GoalDagConflictHints`, `GoalDagNode`, `GoalModelRoutingConfig` types.
