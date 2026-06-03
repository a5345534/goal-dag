#!/usr/bin/env node
import { buildGoalDagFromSpecFile } from "../builder.js";

interface CliOptions {
  spec: string;
  out: string;
  help: boolean;
}

function printUsage(): void {
  process.stdout.write(
    [
      "agent-goal-planner build-dag — build a Goal DAG file from a spec",
      "",
      "Usage:",
      "  agent-goal-planner build-dag --spec <path> --out <path>",
      "",
      "Arguments:",
      "  --spec <path>   Path to a JSON file containing a GoalDagSpec",
      "  --out <path>    Path to write the validated DAG JSON file",
      "  -h, --help      Show this help",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { spec: "", out: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "--spec") {
      const value = argv[++i];
      if (!value) throw new Error("--spec requires a path argument");
      opts.spec = value;
      continue;
    }
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a path argument");
      opts.out = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.help) {
    if (!opts.spec) throw new Error("Missing required --spec <path>");
    if (!opts.out) throw new Error("Missing required --out <path>");
  }
  return opts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const document = buildGoalDagFromSpecFile(args.spec, args.out);
  process.stdout.write(
    `Wrote Goal DAG file (${document.nodes.length} node${document.nodes.length === 1 ? "" : "s"}) to ${args.out}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
