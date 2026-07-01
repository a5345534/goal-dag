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
  spec from a PRD, design doc, or OpenSpec change, assign abstract
  `modelScenario` / `modelClass` routing from shared model-class guidance,
  and emit a valid DAG file.

goal-contract owns the runtime DAG parser/types/schema for the DAG schema and validation.
This package only does two things:

1. Reads a spec (which the agent or a script produces).
2. Composes a draft DAG file from the spec and round-trips it through the
   `goal-contract` parser exported as `parseGoalDagFileDocument()`. The parser is
   the single source of truth for id pattern, dependency existence,
   self-dependency, cycle, model-scenario referential integrity, and runtime
   DAG field validation. The builder refuses to write an invalid DAG.

For reviewability, `GoalDagSpec` may also carry spec-only planning metadata
(`consumes`, `produces`, `evidence`, `modelRationale`, `acceptanceCriteria`,
`decompositionRationale`, and root-level `openQuestions`). The builder strips
those fields from the runtime DAG and can write a separate planning trace
sidecar JSON. When `openQuestions` are used as a node acceptance handle, prefix
the question with `<node-id>:` so the trace can be reviewed against that node.

## Naming note

`goal-dag` depends on `goal-contract` for Stage 3 DAG parser/types/schema.
`goal-runner` is referenced only as the downstream Stage 3 runtime consumer.

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

The runtime contract dependency is pinned via `goal-dag`'s own `package.json` to
`github:a5345534/goal-contract#8523c07`, so a single install or update brings in
the Stage 2 producer plus the Stage 3 DAG parser/schema API it validates
against. This pin includes the abstract `modelClass` routing contract and rejects
legacy concrete `model` routing fields.

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

### Publish closeout

`goal-dag` includes an optional publish closeout step that validates, stages,
commits, and non-force pushes owned output artifacts to the configured GitHub
branch, then verifies the remote contains the commit and checks worktree
cleanliness:

```bash
# Build and publish closeout (commit + non-force push + remote verify)
npx goal-dag build-dag --spec spec.json --out goal.dag.json \
  --trace goal.trace.json --closeout

# Build with explicit non-published mode (skip commit/push)
npx goal-dag build-dag --spec spec.json --out goal.dag.json \
  --trace goal.trace.json --non-published
```

Closeout blocks with actionable diagnostics for:
- Unrelated dirty files in the worktree
- Ambiguous owned path ownership
- Missing publication remote or upstream
- Detached HEAD
- Branch divergence from remote
- Authentication or network failure
- Push rejection (branch protection, non-fast-forward)
- Remote verification failure

`goal-dag` NEVER executes Stage 3 behavior (`/goal --dag`) as part of closeout.

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
  runPublishCloseout,
  type GoalDagSpec,
  type OwnedOutputPaths,
  type PublishCloseoutOptions,
  type PublishCloseoutResult,
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

### Publish closeout API

After building a DAG output and running validators, call `runPublishCloseout`
to commit, push, and verify the generated artifacts:

```ts
import { runPublishCloseout } from "goal-dag";

const result = runPublishCloseout({
  ownedPaths: { primary: "goal.dag.json", sidecar: "goal.trace.json" },
  cwd: process.cwd(),
});

if (result.mode === "published") {
  console.log(`Published commit ${result.commitSha}`);
} else if (result.mode === "blocked") {
  for (const diag of result.diagnostics) {
    if (diag.severity === "blocker") {
      console.error(`[${diag.code}] ${diag.message}`);
    }
  }
} else if (result.mode === "non_published") {
  console.log("Non-published mode: artifacts are local only.");
}
```

Optionally, pass `closeout: true` to `buildGoalDagFromSpecFile()` for a
single-call build+closeout workflow.

For native-git nodes, the builder emits `workspace.worktreeSlug = node.id` when
omitted. Expected `outputs` are emitted relative to that node workspace root; do
not put `.worktrees/<slug>/...` in artifact paths.

Spec-only planning fields are accepted for trace generation but are never emitted
in the runtime DAG JSON. Use them to explain dependencies, acceptance criteria,
decomposition rationale, unresolved node-level questions, and model choices.
Runtime fields such as `kind`, `validation`, `thinkingLevel`, `workspace`,
`completionGates`, and `modelScenario` are preserved in the emitted DAG and
validated by the shared `goal-contract` parser.

## Producer/runtime field guidance

`goal-dag` inputs (`GoalDagSpec`) and outputs (`.dag.json`) share runtime field
names but differ in ownership:

- Runtime-owned fields are included in the output DAG (for controller use):
  `id`, `objective`, `after`, `outputs`, `validators`, `conflicts`, `scope`,
  `kind`, `validation`, `workspaceStrategy`, `workspace`, `risk`,
  `completionGates`, `modelScenario`, and `thinkingLevel`.
- Producer-only fields are stripped from `.dag.json` and only appear in the
  planning trace sidecar: `openQuestions`, `consumes`, `produces`, `evidence`,
  `modelRationale`, `acceptanceCriteria`, and `decompositionRationale`.

For deterministic checks, map source shell commands to `validators` and also
enforce `validation.requiredEvidence: ["validators-ran"]` so the runtime can
confirm execution. For audit-artifact requirements, map to
`validation.auditReportPaths` plus `validation.requiredEvidence: ["audit-report-present"]`.
For scope constraints, map to `validation.allowedPaths` /
`validation.forbiddenPaths`.
For prose-only acceptance, use `acceptanceCriteria` plus `evidence` and rely on
`<name>.trace.json` for review context.

## Producer boundary

`goal-dag` is intentionally Stage 2 only. It must not:

- Execute `/goal --dag`.
- Manage subagents or create worktrees.
- Run runtime validators.
- Decide goal completion or blocked state.
- Modify implementation files.
- Create or modify OpenSpec source packages.
- Preserve producer-only trace metadata in the runtime DAG JSON.

Every emitted DAG JSON is validated by the shared `goal-contract` parser before
it is shown as ready for handoff.

## Pi skill

The skill lives at `skills/goal-dag/SKILL.md` and ships in the npm
tarball. Once installed, the agent can run:

```text
/skill:goal-dag .goal/people-frappe-prd.md
```

The skill walks the agent through:

1. Reading the document.
2. Reading model-class routing guidance (`goal-contract/catalogs/model-classes.json`
   and optional project `.goal/model-catalog.json`, which may contain advisory
   rules that map task traits to `modelScenario` plus abstract `modelClass`).
3. Running a planning-quality pass: evidence table → abstract transition graph
   → recursive decomposition review → node quality review →
   dependency/critical-path review, with a skeptical judge pass for high-risk
   or ambiguous plans.
4. Asking clarifying questions about dependencies, conflicts, validators,
   unresolved acceptance handles, redundant shortcut nodes, and model assignment.
5. Producing a model assignment table and, when most implementation leaves need
   the strictest model class, a model-cost sanity review table.
6. Writing `modelRouting.scenarios` with abstract `modelClass` values, a
   dedicated `controllerScenario`, and per-node `modelScenario` /
   `modelRationale` into the `GoalDagSpec`.
7. Writing the `GoalDagSpec` JSON with spec-only planning metadata for traceability.
8. Running the CLI to build a parser-valid DAG file and trace sidecar.
9. Showing the user the resulting DAG, `nodeQuality` trace warnings/open questions,
   and the exact `/goal --dag <out.dag.json>` handoff command without executing it.

## Model-class routing

`goal-dag` emits abstract `modelClass` routing only. Concrete provider/model ids
are intentionally absent from DAGs and traces; `goal-runner` resolves classes
through harness binding catalogs at runtime and records resolution evidence.

Project-specific advisory rules may live at `.goal/model-catalog.json`. They map
task traits to `modelScenario` plus `modelClass`, never to concrete models. The
skill uses those rules to inform LLM judgment, then declares runtime-compatible
`modelRouting.scenarios`, sets a `controllerScenario`, and shows a model
assignment table before writing the DAG. If most implementation leaves require
the strictest class, the skill runs a model-cost sanity review before finalizing
assignments.

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

goal-contract owns the runtime DAG parser/types/schema. goal-runner owns the execution runtime, scheduling, validator
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

`dist/` is **committed to the repo**, not gitignored. The reason:
`pi install` runs `npm install --omit=dev`, which means `tsc` is not on PATH
during install — any hook that tries to build will fail. Shipping a pre-built
`dist/` makes the package install-anywhere.

**When you change `src/`, you must also rebuild `dist/` and commit
the regenerated build output**:

```bash
npm run check   # builds + runs tests
git add src/ dist/
git commit
```

The `prepack` script still rebuilds on `npm pack` / `npm publish`
to catch stale artifacts at release time.

### Runtime dependency

The package depends on `goal-contract` via a git ref:

```json
"goal-contract": "github:a5345534/goal-contract#8523c07"
```

Pin to a tag or commit so `goal-dag` releases are reproducible. The pinned commit
is the version-sync proof for the Stage 3 parser/schema surface; it includes the
abstract `modelClass` routing contract, shared model-class catalog, and legacy
concrete `model` rejection.

- `parseGoalDagFileDocument` (parser + validator)
- `GoalDagFileDocument`, `GoalDagFileNode`, `GoalDagFileDefaults`,
  `GoalDagConflictHints`, `GoalDagNode`, `GoalModelRoutingConfig` types.
