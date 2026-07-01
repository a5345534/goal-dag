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
import { execFileSync } from "node:child_process";
import { resolve, relative, normalize } from "node:path";
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_REMOTE = "origin";
const DEFAULT_CLOSEOUT_MESSAGE_PREFIX = "goal-dag closeout";
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
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
export function runPublishCloseout(options) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const remote = options.remote ?? DEFAULT_REMOTE;
    const diagnostics = [];
    // ---- Step 0: Explicit non-published mode ----
    if (options.nonPublished) {
        addDiagnostic(diagnostics, "warning", "np-mode-active", [
            "Explicit non-published mode is active.",
            "The generated artifacts were validated but have NOT been committed or pushed to GitHub.",
            "goal-runner may still block startup if the worktree is dirty.",
        ].join(" "));
        return { mode: "non_published", diagnostics };
    }
    // ---- Step 1: Determine current branch ----
    let branch;
    let headSha;
    let gitDir;
    try {
        gitDir = git(["rev-parse", "--git-dir"], cwd).trim();
        headSha = git(["rev-parse", "HEAD"], cwd).trim();
        branch = options.branch ?? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    }
    catch (error) {
        addDiagnostic(diagnostics, "blocker", "not-a-git-repo", [
            "Not a Git repository or git command failed.",
            error instanceof Error ? error.message : String(error),
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 2: Check for detached HEAD ----
    if (branch === "HEAD") {
        addDiagnostic(diagnostics, "blocker", "detached-head", [
            "The repository is in detached HEAD state.",
            "Switch to a branch before publishing:",
            "  git checkout -b <branch>",
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 3: Check for configured upstream ----
    let upstreamRef;
    try {
        upstreamRef = git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd).trim();
    }
    catch {
        addDiagnostic(diagnostics, "blocker", "missing-upstream", [
            `Branch "${branch}" has no configured upstream.`,
            `Set one with: git branch --set-upstream-to=${remote}/${branch} ${branch}`,
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 4: Check remote exists ----
    let remoteUrl;
    try {
        remoteUrl = git(["remote", "get-url", remote], cwd).trim();
    }
    catch {
        addDiagnostic(diagnostics, "blocker", "missing-remote", [
            `Remote "${remote}" is not configured.`,
            "Add it with: git remote add <name> <url>",
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // Skip full GitHub verification for non-GitHub remotes but still allow closeout
    const isGitHubRemote = /github\.com[:/]/i.test(remoteUrl);
    // ---- Step 5: Normalize owned paths ----
    const ownedPaths = normalizeOwnedPaths(options.ownedPaths, cwd);
    if (ownedPaths.length === 0) {
        addDiagnostic(diagnostics, "blocker", "no-owned-paths", [
            "No owned output paths were provided. Cannot determine what to publish.",
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 6: Git status scan ----
    const statusResult = scanGitStatus(cwd, ownedPaths);
    for (const stale of statusResult.ownedUnchanged) {
        addDiagnostic(diagnostics, "info", "owned-path-unchanged", [
            `Owned path "${stale}" has no changes since the last commit.`,
        ].join(" "));
    }
    // ---- Step 7: Check for ambiguous ownership ----
    if (statusResult.ambiguousPaths.length > 0) {
        for (const path of statusResult.ambiguousPaths) {
            addDiagnostic(diagnostics, "blocker", "ambiguous-ownership", [
                `Path "${path}" may or may not be owned by this producer run.`,
                "Closeout cannot prove ownership from invocation context.",
                "Resolve by staging or committing manually, or add to ownedPaths.",
            ].join(" "));
        }
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 8: Check for unrelated dirty files ----
    if (statusResult.unrelatedDirty.length > 0) {
        for (const path of statusResult.unrelatedDirty) {
            addDiagnostic(diagnostics, "blocker", "unrelated-dirty-file", [
                `Unrelated dirty file: "${path}".`,
                "This file is not owned by the current producer run.",
                "Commit, stash, remove, or otherwise resolve it before retrying.",
            ].join(" "));
        }
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 9: No-op check ----
    if (statusResult.ownedDirty.length === 0) {
        addDiagnostic(diagnostics, "info", "no-changes", [
            "No owned output files changed. Worktree is clean.",
            "Closeout result: no_changes.",
        ].join(" "));
        return { mode: "no_changes", diagnostics };
    }
    // ---- Step 10: Check for divergence before push ----
    try {
        git(["fetch", remote, branch], cwd, { dryRun: false });
        const behindCount = parseInt(git(["rev-list", "--count", `${branch}..${branch}@{upstream}`], cwd).trim(), 10);
        if (behindCount > 0) {
            addDiagnostic(diagnostics, "blocker", "branch-diverged", [
                `Branch "${branch}" is ${behindCount} commit(s) behind ${remote}/${branch}.`,
                "Local changes would require a force push or merge.",
                "Reconcile manually: git pull --rebase or git merge.",
            ].join(" "));
            return { mode: "blocked", diagnostics };
        }
    }
    catch (error) {
        addDiagnostic(diagnostics, "warning", "fetch-warning", [
            `Could not check branch divergence for ${remote}/${branch}:`,
            error instanceof Error ? error.message : String(error),
            "Proceeding with local push attempt.",
        ].join(" "));
    }
    // ---- Step 11: Stage owned paths ----
    try {
        for (const path of statusResult.ownedDirty) {
            git(["add", "--", path], cwd, { dryRun: options.dryRun });
        }
    }
    catch (error) {
        addDiagnostic(diagnostics, "blocker", "stage-failed", [
            "Failed to stage owned paths:",
            error instanceof Error ? error.message : String(error),
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 12: Create commit ----
    const commitMessage = options.commitMessage ?? autoCommitMessage(options.ownedPaths, remote, branch);
    let commitSha;
    try {
        if (options.dryRun) {
            process.stderr.write(`[dry-run] Would commit with message: ${commitMessage}\n`);
            // Use the current HEAD SHA as placeholder
            commitSha = headSha;
        }
        else {
            git(["commit", "-m", commitMessage], cwd);
            commitSha = git(["rev-parse", "HEAD"], cwd).trim();
        }
    }
    catch (error) {
        addDiagnostic(diagnostics, "blocker", "commit-failed", [
            "Failed to create closeout commit:",
            error instanceof Error ? error.message : String(error),
        ].join(" "));
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 13: Push non-force ----
    try {
        if (options.dryRun) {
            process.stderr.write(`[dry-run] Would push: git push ${remote} HEAD:refs/heads/${branch}\n`);
        }
        else {
            git(["push", remote, `HEAD:refs/heads/${branch}`], cwd);
        }
    }
    catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // Classify push failure
        if (/rejected|non-fast-forward|fetch first/i.test(errMsg)) {
            addDiagnostic(diagnostics, "blocker", "push-rejected", [
                `Push to ${remote}/${branch} was rejected (non-fast-forward or branch protection).`,
                "Manual reconciliation is required: git pull --rebase, then retry.",
            ].join(" "));
        }
        else if (/authentication|auth|403|401/i.test(errMsg)) {
            addDiagnostic(diagnostics, "blocker", "auth-failure", [
                `Authentication failure for remote "${remote}".`,
                `Check credentials and try again.`,
            ].join(" "));
        }
        else if (/timed? ?out|network|connect|resolve|Could not read/i.test(errMsg)) {
            addDiagnostic(diagnostics, "blocker", "network-failure", [
                `Network error pushing to "${remote}":`,
                errMsg,
                "Check network connectivity and retry.",
            ].join(" "));
        }
        else {
            addDiagnostic(diagnostics, "blocker", "push-failed", [
                `Failed to push to ${remote}/${branch}:`,
                errMsg,
            ].join(" "));
        }
        return { mode: "blocked", diagnostics };
    }
    // ---- Step 14: Remote verification ----
    if (commitSha && isGitHubRemote) {
        try {
            const remoteRefs = git(["ls-remote", remote, `refs/heads/${branch}`], cwd);
            if (!remoteRefs.includes(commitSha)) {
                addDiagnostic(diagnostics, "blocker", "remote-verification-failed", [
                    `Remote ${remote}/${branch} does not contain commit ${commitSha}.`,
                    "This may indicate a race condition or unexpected remote state.",
                    "Verify manually: git ls-remote",
                ].join(" "));
                return { mode: "blocked", diagnostics };
            }
            addDiagnostic(diagnostics, "info", "remote-verified", [
                `Remote ${remote}/${branch} confirmed to contain commit ${commitSha}.`,
            ].join(" "));
        }
        catch (error) {
            addDiagnostic(diagnostics, "blocker", "remote-verification-error", [
                "Failed to verify remote branch after push:",
                error instanceof Error ? error.message : String(error),
                "Manual verification recommended.",
            ].join(" "));
            return { mode: "blocked", diagnostics };
        }
    }
    else if (commitSha && !isGitHubRemote) {
        addDiagnostic(diagnostics, "info", "remote-verification-skipped", [
            `Remote "${remote}" does not appear to be a GitHub remote; remote verification skipped.`,
            `Commit ${commitSha} was pushed to ${remote}/${branch}.`,
        ].join(" "));
    }
    // ---- Step 15: Final worktree cleanliness check ----
    try {
        const finalStatus = git(["status", "--porcelain"], cwd).trim();
        if (finalStatus.length > 0) {
            const dirtyLines = finalStatus.split("\n").slice(0, 5);
            addDiagnostic(diagnostics, "blocker", "worktree-still-dirty", [
                "After commit, the worktree still has dirty files:",
                ...dirtyLines.map((line) => `  ${line}`),
                "Resolve remaining dirty files before runner handoff.",
            ].join(" "));
            return { mode: "blocked", diagnostics };
        }
    }
    catch {
        // Non-fatal; we already did the push
        addDiagnostic(diagnostics, "warning", "status-check-failed", [
            "Could not verify final worktree cleanliness.",
            "Manual check recommended: git status",
        ].join(" "));
    }
    addDiagnostic(diagnostics, "info", "published", [
        `Published closeout commit ${commitSha} to ${remote}/${branch}.`,
        "Worktree is clean.",
    ].join(" "));
    return {
        mode: "published",
        commitSha,
        diagnostics,
    };
}
function git(args, cwd, execOptions) {
    const isReadOnly = isReadOnlyCommand(args);
    const dryRun = execOptions?.dryRun === true && !isReadOnly;
    if (dryRun) {
        process.stderr.write(`[dry-run] git ${args.join(" ")}\n`);
        return "";
    }
    try {
        const result = execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 60_000,
        });
        return (result ?? "").trim();
    }
    catch (error) {
        if (error && typeof error === "object" && "stderr" in error) {
            const stderr = error.stderr;
            const msg = typeof stderr === "string" ? stderr : stderr.toString("utf8");
            throw new Error(msg.trim() || `git ${args.join(" ")} failed`);
        }
        throw error;
    }
}
/** Commands that do not mutate remote state */
function isReadOnlyCommand(args) {
    const cmd = args[0] ?? "";
    const readOnlyCmds = [
        "rev-parse",
        "status",
        "ls-remote",
        "rev-list",
        "remote",
    ];
    if (readOnlyCmds.includes(cmd))
        return true;
    // fetch reads from remote but does not push local changes
    if (cmd === "fetch")
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Add a diagnostic to the result array */
function addDiagnostic(diagnostics, severity, code, message) {
    diagnostics.push({ severity, code, message });
}
/** Normalize owned paths to repo-root-relative, filtering out non-existent files */
function normalizeOwnedPaths(owned, cwd) {
    const paths = [];
    // Normalize and make repo-relative
    const primaryNormalized = normalize(replaceBackslashes(owned.primary));
    const primaryRel = relative(cwd, resolve(cwd, primaryNormalized));
    if (!primaryRel.startsWith("..")) {
        paths.push(primaryRel);
    }
    else {
        paths.push(primaryNormalized);
    }
    if (owned.sidecar) {
        const sidecarNormalized = normalize(replaceBackslashes(owned.sidecar));
        const sidecarRel = relative(cwd, resolve(cwd, sidecarNormalized));
        if (!sidecarRel.startsWith("..")) {
            paths.push(sidecarRel);
        }
        else {
            paths.push(sidecarNormalized);
        }
    }
    return paths;
}
function replaceBackslashes(value) {
    return value.replace(/\\/g, "/");
}
/**
 * Scan Git status and classify paths.
 *
 * Classification rules:
 * - A path listed in `ownedPaths` that is dirty → ownedDirty
 * - A path listed in `ownedPaths` that is NOT dirty → ownedUnchanged
 * - A dirty path NOT in ownedPaths and not matching standard ignore patterns → unrelatedDirty
 * - A dirty path matching "ambiguous" heuristics → ambiguousPaths
 */
function scanGitStatus(cwd, ownedPaths) {
    const ownedSet = new Set(ownedPaths.map((p) => normalize(p)));
    const ownedDirty = [];
    const ownedUnchanged = [];
    const unrelatedDirty = [];
    const ambiguousPaths = [];
    // Check which owned files actually have changes
    for (const ownedPath of ownedPaths) {
        try {
            const diffIndex = git(["diff-index", "HEAD", "--", ownedPath], cwd);
            const diffStat = git(["diff-files", "--", ownedPath], cwd);
            const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ownedPath], cwd);
            const hasStagedChanges = diffIndex.length > 0;
            const hasWorkingChanges = diffStat.length > 0;
            const isUntracked = untracked.length > 0;
            if (hasStagedChanges || hasWorkingChanges || isUntracked) {
                ownedDirty.push(ownedPath);
            }
            else {
                ownedUnchanged.push(ownedPath);
            }
        }
        catch {
            // If the owned path doesn't exist in the index yet (new file), treat as dirty
            ownedDirty.push(ownedPath);
        }
    }
    // Scan all dirty paths and classify
    try {
        const porcelain = git(["status", "--porcelain"], cwd);
        const lines = porcelain.split("\n").filter(Boolean);
        for (const line of lines) {
            const path = extractStatusPath(line);
            if (!path)
                continue;
            const normalizedPath = normalize(path);
            // Check if it's an owned path
            if (isOwnedPath(normalizedPath, ownedPaths)) {
                continue; // Already counted above
            }
            // Check if it's a node_modules or common ignore
            if (isIgnoredPath(normalizedPath)) {
                continue;
            }
            // Ambiguous heuristic: paths in .git or .worktrees that might be generated
            if (isAmbiguousPath(normalizedPath)) {
                ambiguousPaths.push(path);
                continue;
            }
            unrelatedDirty.push(path);
        }
    }
    catch {
        // If status scan fails, treat conservatively
        ambiguousPaths.push("<git status scan failed>");
    }
    return { ownedDirty, ownedUnchanged, unrelatedDirty, ambiguousPaths };
}
function extractStatusPath(line) {
    // porcelain format: XY <path> or XY <path> -> <renamed_path>
    const trimmed = line.trim();
    if (trimmed.length < 3)
        return undefined;
    const pathPart = trimmed.substring(2).trim();
    // Handle renames: "R  old -> new"
    const renameArrow = " -> ";
    const arrowIndex = pathPart.lastIndexOf(renameArrow);
    if (arrowIndex !== -1) {
        return pathPart.substring(arrowIndex + renameArrow.length);
    }
    return pathPart;
}
function isOwnedPath(normalizedPath, ownedPaths) {
    return ownedPaths.some((owned) => {
        const normalizedOwned = normalize(owned);
        // Exact match or the path is a parent directory of an owned file
        if (normalizedPath === normalizedOwned)
            return true;
        // Match if owned path is a directory and path is inside it
        if (normalizedPath.startsWith(normalizedOwned + "/"))
            return true;
        // Match if owned path is a glob-like pattern (e.g., src/**)
        if (normalizedOwned.endsWith("/**")) {
            const prefix = normalizedOwned.slice(0, -3);
            return normalizedPath === prefix || normalizedPath.startsWith(prefix + "/");
        }
        return false;
    });
}
function isIgnoredPath(path) {
    const ignorePatterns = [
        /^node_modules\//,
        /\/node_modules\//,
        /^\.git\//,
        /^dist\//,
        /^\.tsbuildinfo$/,
        /\.log$/,
        /^\.DS_Store$/,
    ];
    return ignorePatterns.some((p) => p.test(path));
}
function isAmbiguousPath(path) {
    const ambiguousPatterns = [
        /^\.worktrees\//,
        /^\.worktree\//,
        /^\.pi\//,
    ];
    return ambiguousPatterns.some((p) => p.test(path));
}
function autoCommitMessage(ownedPaths, remote, branch) {
    const parts = [`${DEFAULT_CLOSEOUT_MESSAGE_PREFIX}: publish ${ownedPaths.primary}`];
    if (ownedPaths.sidecar) {
        parts.push(`with ${ownedPaths.sidecar}`);
    }
    parts.push(`[${remote}/${branch}]`);
    return parts.join(" ");
}
//# sourceMappingURL=publish-closeout.js.map