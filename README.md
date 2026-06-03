# agent-goal-planner

Plan [Goal DAG](https://github.com/a5345534/agent-goal-runtime) files from
development documents for the [`agent-goal-runtime`](https://github.com/a5345534/agent-goal-runtime).

The runtime accepts a strict JSON DAG file via `/goal --dag <path>`. Writing
that JSON by hand is error-prone (kebab-case ids, acyclic dependencies,
model-scenario referential integrity, etc.). This package adds a thin
**planner layer** on top of the runtime:

- A programmatic `GoalDagSpec` builder API.
- A small CLI: `agent-goal-planner build-dag --spec <in> --out <out>`.
- A Pi skill (`/skill:goal-planner`) that teaches an agent to extract a
  spec from a PRD, design doc, or OpenSpec change and emit a valid DAG
  file.

The runtime stays the source of truth for the DAG schema and validation.
This package only does two things:

1. Reads a spec (which the agent or a script produces).
2. Hands it to `agent-goal-runtime`'s `buildGoalDagDocumentFromSpec()`,
   which round-trips the spec through the runtime's parser and refuses to
   write an invalid DAG file.

## Install

This package is in early development. For now, install from the local
checkout:

```bash
git clone https://github.com/a5345534/agent-goal-planner
cd agent-goal-planner
npm install
npm run build
```

Then expose the skill to Pi by adding the local path to
`~/.pi/agent/settings.json` (or project `.pi/settings.json`):

```json
{
  "packages": ["/absolute/path/to/agent-goal-planner"]
}
```

## CLI

```bash
# 1. Write a spec.json (the agent fills this in via the /skill:goal-planner workflow)
# 2. Build a validated DAG file:
npx agent-goal-planner build-dag --spec spec.json --out goal.dag.json
# 3. Hand it to the runtime:
/goal --dag goal.dag.json
```

The CLI is a thin wrapper over `buildGoalDagFromSpecFile()` from
`agent-goal-planner`'s public API.

## Programmatic API

```ts
import {
  parseGoalDagSpec,
  buildGoalDagFromSpec,
  serializeGoalDagDocument,
  validateGoalDagJson,
  type GoalDagSpec,
} from "agent-goal-planner";

const spec: GoalDagSpec = {
  objective: "Ship the People Frappe backend slices",
  nodes: [
    { id: "attendance-parity", objective: "Add attendance parity fixtures" },
    { id: "payroll-doctypes",  objective: "Add payroll DocTypes" },
    {
      id: "integration-validation",
      objective: "Run integrated validation",
      after: ["attendance-parity", "payroll-doctypes"],
    },
  ],
};

const document = buildGoalDagFromSpec(spec);          // throws on invalid spec
const json = serializeGoalDagDocument(document);      // pretty JSON
const reparsed = validateGoalDagJson(json);           // smoke check
```

## Pi skill

The skill lives at `skills/goal-planner/SKILL.md` and ships in the npm
tarball. Once installed, the agent can run:

```text
/skill:goal-planner .goal/people-frappe-prd.md
```

The skill walks the agent through:

1. Reading the document.
2. Asking clarifying questions about dependencies, conflicts, validators.
3. Writing a `GoalDagSpec` JSON.
4. Running the CLI to build a parser-valid DAG file.
5. Showing the user the resulting DAG and offering
   `/goal --dag <out.dag.json>`.

## Architecture

```
┌────────────────────────────────────────┐
│  agent-goal-runtime                    │
│  - parseGoalDagFileDocument (parser)   │
│  - buildGoalDagDocumentFromSpec (new)  │
│  - serializeGoalDagDocument (new)      │
└────────────────────────────────────────┘
                  ▲
                  │ uses
                  │
┌────────────────────────────────────────┐
│  agent-goal-planner (this package)     │
│  - parseGoalDagSpec (loose spec JSON)  │
│  - buildGoalDagFromSpec (delegates)    │
│  - CLI: build-dag                      │
│  - Pi skill: goal-planner              │
└────────────────────────────────────────┘
```

The runtime owns the schema and validation. The planner owns the
"how do I extract a plan from a document" prompt / script / agentic
workflow. New planners (Linear tickets, Jira epics, OpenSpec changes)
can ship as additional skills or scripts under this package without
touching the runtime.

## Development

```bash
npm install
npm run check   # build + tests
```

The package depends on `agent-goal-runtime` via a `file:` reference to a
sibling checkout. Once `agent-goal-runtime` publishes a release that
includes the `buildGoalDagDocumentFromSpec` API, switch the dependency
to a real version range.
