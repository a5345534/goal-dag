#!/usr/bin/env node
import { buildGoalDagFromSpecFile } from "../builder.js";
function printUsage() {
    process.stdout.write([
        "goal-dag build-dag — build a Goal DAG file from a spec",
        "",
        "Usage:",
        "  goal-dag build-dag --spec <path> --out <path> [--trace <path>]",
        "",
        "Arguments:",
        "  --spec <path>   Path to a JSON file containing a GoalDagSpec",
        "  --out <path>    Path to write the validated DAG JSON file",
        "  --trace <path>  Optional path to write the planning trace sidecar JSON",
        "  -h, --help      Show this help",
        "",
    ].join("\n"));
}
function parseArgs(argv) {
    const opts = { spec: "", out: "", trace: "", help: false };
    // Consume the leading subcommand if present. Today we only ship one
    // subcommand, so the parser just accepts and ignores it.
    if (argv[0] === "build-dag")
        argv = argv.slice(1);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-h" || arg === "--help") {
            opts.help = true;
            continue;
        }
        if (arg === "--spec") {
            const value = argv[++i];
            if (!value)
                throw new Error("--spec requires a path argument");
            opts.spec = value;
            continue;
        }
        if (arg === "--out") {
            const value = argv[++i];
            if (!value)
                throw new Error("--out requires a path argument");
            opts.out = value;
            continue;
        }
        if (arg === "--trace") {
            const value = argv[++i];
            if (!value)
                throw new Error("--trace requires a path argument");
            opts.trace = value;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    if (!opts.help) {
        if (!opts.spec)
            throw new Error("Missing required --spec <path>");
        if (!opts.out)
            throw new Error("Missing required --out <path>");
    }
    return opts;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }
    const document = buildGoalDagFromSpecFile(args.spec, args.out, {
        ...(args.trace ? { tracePath: args.trace } : {}),
    });
    process.stdout.write(`Wrote Goal DAG file (${document.nodes.length} node${document.nodes.length === 1 ? "" : "s"}) to ${args.out}\n`);
    if (args.trace) {
        process.stdout.write(`Wrote planning trace to ${args.trace}\n`);
    }
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=build-dag.js.map