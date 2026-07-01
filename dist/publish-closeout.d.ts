/**
 * publish-closeout.ts — Producer publish closeout for goal-dag
 *
 * After Stage 2 output validation, this module handles:
 * - Owned-output-path tracking from the producer invocation
 * - Owned-output-only staging (blocks on unrelated dirty files / ambiguous ownership)
 * - Non-force GitHub branch push with commit creation
 * - Remote verification (confirm remote branch contains the commit)
 * - Final worktree cleanliness check
 * - Fail-closed diagnostics for every blocking condition
 * - Explicit non-published mode (skip commit/push, label result)
 *
 * Stage boundary: this module NEVER executes Stage 3 behavior.
 * It may show the downstream handoff command but must not run it.
 */
/** Result mode after closeout evaluation */
export type CloseoutMode = "published" | "no_changes" | "blocked" | "non_published";
/** Severity level for diagnostics */
export type DiagnosticSeverity = "info" | "warning" | "blocker";
/** A single closeout diagnostic message */
export interface CloseoutDiagnostic {
    severity: DiagnosticSeverity;
    code: string;
    message: string;
}
/** Result of a publish closeout run */
export interface PublishCloseoutResult {
    /** The closeout mode */
    mode: CloseoutMode;
    /** SHA of the closeout commit, if one was created */
    commitSha?: string;
    /** Ordered diagnostics from the closeout run */
    diagnostics: CloseoutDiagnostic[];
}
/**
 * Output paths owned by the current producer invocation.
 * All paths are relative to the repository root.
 */
export interface OwnedOutputPaths {
    /** Primary generated handoff artifact (the .dag.json file) */
    primary: string;
    /** Optional review sidecar (the .trace.json file) */
    sidecar?: string;
}
/** Options for runPublishCloseout */
export interface PublishCloseoutOptions {
    /** Paths owned by the current producer run (repo-root-relative) */
    ownedPaths: OwnedOutputPaths;
    /** Git remote name (defaults to "origin") */
    remote?: string;
    /** Branch to push (defaults to current HEAD branch name) */
    branch?: string;
    /** Commit message. Auto-generated when omitted. */
    commitMessage?: string;
    /** Repository root for git operations (defaults to process.cwd()) */
    cwd?: string;
    /** Explicit non-published mode — skip commit/push, label result */
    nonPublished?: boolean;
    /**
     * When true, git commands that would mutate state are printed to stderr
     * but not executed. Read-only queries (status, rev-parse, ls-remote)
     * still run normally for accurate diagnostics.
     */
    dryRun?: boolean;
}
/**
 * Run the publish closeout pipeline.
 *
 * 1. Checks for explicit non-published mode (short-circuit).
 * 2. Reads Git status.
 * 3. If worktree is clean and owned outputs have no changes → no_changes.
 * 4. If dirty paths exist outside owned set → blocked with diagnostics.
 * 5. If ambiguous paths exist → blocked.
 * 6. Stages owned paths, commits, pushes non-force.
 * 7. Verifies remote branch contains commit.
 * 8. Re-checks worktree cleanliness.
 *
 * Validation is the CALLER's responsibility — call this only after
 * producer validators have passed.
 */
export declare function runPublishCloseout(options: PublishCloseoutOptions): PublishCloseoutResult;
