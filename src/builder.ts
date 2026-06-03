import { readFileSync, writeFileSync } from "node:fs";
import {
  buildGoalDagDocumentFromSpec,
  parseGoalDagFileDocument,
  serializeGoalDagDocument,
  type GoalDagFileDocument,
  type GoalDagSpec,
} from "agent-goal-runtime";

/**
 * Parse a {@link GoalDagSpec} from a JSON string. A spec is the programmatic
 * input to {@link buildGoalDagDocumentFromSpec} — structurally similar to
 * the on-disk DAG file, but with `version` optional and the agent-runtime's
 * parser is the source of truth for shape and graph validity.
 */
export function parseGoalDagSpec(content: string): GoalDagSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid goal DAG spec JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseGoalDagSpecDocument(parsed);
}

export function parseGoalDagSpecDocument(input: unknown): GoalDagSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid goal DAG spec: root must be an object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.objective !== "string" || !record.objective.trim()) {
    throw new Error("Invalid goal DAG spec: objective must be a non-empty string");
  }
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new Error("Invalid goal DAG spec: nodes must be a non-empty array");
  }
  if (record.version !== undefined && record.version !== 1) {
    throw new Error("Invalid goal DAG spec: version must be 1 when present");
  }
  // Defer the deep structural / graph / model-scenario checks to the runtime
  // builder's parser round-trip; here we just confirm the shape is plumbable.
  return record as unknown as GoalDagSpec;
}

/**
 * Build a validated {@link GoalDagFileDocument} from a spec, by delegating
 * to the runtime builder (which round-trips through the parser for full
 * structural and graph validation).
 */
export function buildGoalDagFromSpec(spec: GoalDagSpec): GoalDagFileDocument {
  return buildGoalDagDocumentFromSpec(spec);
}

/**
 * Convenience helper: read a spec file, build a validated document, write a
 * pretty-printed DAG JSON to disk, and return the document.
 */
export function buildGoalDagFromSpecFile(specPath: string, outPath: string): GoalDagFileDocument {
  const spec = parseGoalDagSpec(readFileSync(specPath, "utf8"));
  const document = buildGoalDagDocumentFromSpec(spec);
  writeFileSync(outPath, serializeGoalDagDocument(document), "utf8");
  return document;
}

/**
 * Validate a candidate JSON string as a Goal DAG document (i.e. the on-disk
 * format the runtime accepts via `/goal --dag <path>`). Re-exported so the
 * CLI / skill can dry-run the produced file before showing it to the user.
 */
export function validateGoalDagJson(content: string): GoalDagFileDocument {
  return parseGoalDagFileDocument(JSON.parse(content) as unknown);
}

export { serializeGoalDagDocument };
