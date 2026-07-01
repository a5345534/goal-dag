#!/usr/bin/env node
import { buildGoalDagFromSpecFile } from "../builder.js";
import { runPublishCloseout } from "../publish-closeout.js";

interface CliOptions {
  spec: string;
  out: string;
  trace: string;
  closeout: boolean;
  nonPublished: boolean;
  help: boolean;
}

function printUsage(): void {
  process.stdout.write(
    [
      "goal-dag build-dag — build a Goal DAG file from a spec",
      "",
      "Usage:",
      "  goal-dag build-dag --spec <path> --out <path> [options]",
      "",
      "Arguments:",
      "  --spec <path>         Path to a JSON file containing a GoalDagSpec",
      "  --out <path>          Path to write the validated DAG JSON file",
      "  --trace <path>        Optional path to write the planning trace sidecar JSON",
      "  --closeout            Perform publish closeout after building (stage, commit, push)",
      "  --non-published       Explicit non-published mode (no commit/push; labels result)",
      "  -h, --help            Show this help",
      "",
      "Closeout notes:",
      "  --closeout stages owned output paths, creates a commit, pushes non-force to GitHub,",
      "  verifies the remote branch contains the commit, and checks worktree cleanliness.",
      "  If any safety check fails, closeout reports a blocking diagnostic and exits non-zero.",
      "  goal-dag does NOT execute Stage 3 /goal --dag as part of closeout.",
      "",
      "  --non-published skips commit/push and labels the result as not published.",
      "  Combine --non-published with --closeout to suppress publication while still",
      "  producing a closeout diagnostic.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { spec: "", out: "", trace: "", closeout: false, nonPublished: false, help: false };
  // Consume the leading subcommand if present.
  if (argv[0] === "build-dag") argv = argv.slice(1);
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
    if (arg === "--trace") {
      const value = argv[++i];
      if (!value) throw new Error("--trace requires a path argument");
      opts.trace = value;
      continue;
    }
    if (arg === "--closeout") {
      opts.closeout = true;
      continue;
    }
    if (arg === "--non-published") {
      opts.nonPublished = true;
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

function formatCloseoutResult(result: ReturnType<typeof runPublishCloseout>): string {
  const lines: string[] = [];
  lines.push(`Closeout mode: ${result.mode}`);
  if (result.commitSha) {
    lines.push(`Commit: ${result.commitSha}`);
  }
  if (result.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diag of result.diagnostics) {
      const prefix = diag.severity === "blocker" ? "  ✗" : diag.severity === "warning" ? "  ⚠" : "  ✓";
      lines.push(`${prefix} [${diag.code}] ${diag.message}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  // Step 1: Build the DAG file (includes validation)
  const document = buildGoalDagFromSpecFile(args.spec, args.out, {
    ...(args.trace ? { tracePath: args.trace } : {}),
  });
  process.stdout.write(
    `Wrote Goal DAG file (${document.nodes.length} node${document.nodes.length === 1 ? "" : "s"}) to ${args.out}\n`,
  );
  if (args.trace) {
    process.stdout.write(`Wrote planning trace to ${args.trace}\n`);
  }

  // Step 2: Publish closeout (if requested)
  if (args.closeout || args.nonPublished) {
    const ownedPaths: { primary: string; sidecar?: string } = {
      primary: args.out,
    };
    if (args.trace) {
      ownedPaths.sidecar = args.trace;
    }

    const result = runPublishCloseout({
      ownedPaths,
      nonPublished: args.nonPublished,
    });

    process.stdout.write(`\n${formatCloseoutResult(result)}\n`);

    if (result.mode === "blocked") {
      process.exit(1);
    }
  }

  // Step 3: Show handoff command but do NOT execute it (Stage 3 boundary)
  process.stdout.write(
    `\nHandoff command (do not execute from this producer):\n  /goal --dag ${args.out}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
