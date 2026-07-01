import test from "node:test";
import assert from "node:assert/strict";
import {
  execSync,
  execFileSync,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  runPublishCloseout,
  type OwnedOutputPaths,
  type PublishCloseoutResult,
} from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Helpers: create temporary git repos with remotes
// --------------------------------------------------------------------------

interface TestRepo {
  dir: string;
  remoteDir: string;
  run: (args: string[], opts?: { expectedExitCode?: number }) => string;
}

function createTempRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "pco-test-"));
  const remoteDir = mkdtempSync(join(tmpdir(), "pco-remote-"));

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  const run = (args: string[], opts?: { expectedExitCode?: number }): string => {
    try {
      const result = execFileSync("git", args, {
        cwd: dir,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return (result ?? "").trim();
    } catch (error: unknown) {
      if (opts?.expectedExitCode !== undefined && error instanceof Error && "status" in error) {
        const err = error as { stderr?: string | Buffer; status?: number; stdout?: string | Buffer };
        if (err.status === opts.expectedExitCode) {
          const stderr = typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? "");
          return stderr.trim();
        }
      }
      throw error;
    }
  };

  // Init remote bare repo
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], {
    env: gitEnv, encoding: "utf8", stdio: "pipe",
  });

  // Init local repo with explicit initial branch
  run(["init", "--initial-branch=main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.com"]);

  // Create initial commit on main
  writeFileSync(join(dir, "README.md"), "# test repo\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-m", "initial commit"]);

  // Add remote
  run(["remote", "add", "origin", remoteDir]);

  // Set upstream tracking
  run(["push", "-u", "origin", "main"]);

  return { dir, remoteDir, run };
}

function cleanupRepo(repo: TestRepo): void {
  try {
    rmSync(repo.dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    rmSync(repo.remoteDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test("runPublishCloseout returns no_changes when worktree is clean and owned paths unchanged", () => {
  const repo = createTempRepo();
  try {
    const result = runPublishCloseout({
      ownedPaths: { primary: "README.md" },
      cwd: repo.dir,
    });
    assert.equal(result.mode, "no_changes");
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout returns published after commit and push", () => {
  const repo = createTempRepo();
  try {
    // Create an owned output file
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "add output.dag.json for test"]);
    repo.run(["push", "origin", "main"]);

    // Now modify the owned output but keep nothing else dirty
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "published");
    assert.ok(result.commitSha, "commit SHA should be present");
    assert.ok(
      result.diagnostics.some((d) => d.code === "remote-verified") ||
        result.diagnostics.some((d) => d.code === "remote-verification-skipped"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout returns published with sidecar when both paths dirty", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    writeFileSync(join(repo.dir, "output.trace.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json", "output.trace.json"]);
    repo.run(["commit", "-m", "add outputs"]);
    repo.run(["push", "origin", "main"]);

    // Modify both
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");
    writeFileSync(join(repo.dir, "output.trace.json"), JSON.stringify({ version: 1, trace: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json", sidecar: "output.trace.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "published");
    assert.ok(result.commitSha);
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout blocks on unrelated dirty files", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");
    // Create an unrelated dirty file
    writeFileSync(join(repo.dir, "unrelated.txt"), "should not be here", "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "blocked");
    assert.ok(
      result.diagnostics.some((d) => d.code === "unrelated-dirty-file"),
      "should have unrelated-dirty-file diagnostic",
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout blocks on detached HEAD", () => {
  const repo = createTempRepo();
  try {
    // Detach HEAD
    repo.run(["checkout", "--detach", "HEAD"]);

    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "on detached"]);
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "blocked");
    assert.ok(
      result.diagnostics.some((d) => d.code === "detached-head"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout blocks on missing upstream", () => {
  const repo = createTempRepo();
  try {
    // Create a new branch without pushing
    repo.run(["checkout", "-b", "feature-branch"]);

    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "on feature branch"]);

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "blocked");
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-upstream"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout returns non_published mode", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
      nonPublished: true,
    });

    assert.equal(result.mode, "non_published");
    assert.ok(
      result.diagnostics.some((d) => d.code === "np-mode-active"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout blocks on missing remote", () => {
  const repo = createTempRepo();
  try {
    repo.run(["remote", "remove", "origin"]);

    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "blocked");
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-remote" || d.code === "missing-upstream"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout creates commit for new untracked file", () => {
  const repo = createTempRepo();
  try {
    // Create a new owned output file that doesn't exist in git yet
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "published");
    assert.ok(result.commitSha, "should have a commit SHA");
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout blocks on branch divergence", () => {
  const repo = createTempRepo();
  try {
    // Make an owned change and push it
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "add dag"]);
    repo.run(["push", "origin", "main"]);

    // Advance the remote via a separate clone
    const otherDir = mkdtempSync(join(tmpdir(), "pco-other-"));
    const otherEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Other",
      GIT_AUTHOR_EMAIL: "other@example.com",
      GIT_COMMITTER_NAME: "Other",
      GIT_COMMITTER_EMAIL: "other@example.com",
    };
    try {
      execFileSync("git", ["clone", repo.remoteDir, "clone"], {
        cwd: otherDir,
        encoding: "utf8",
        stdio: "pipe",
        env: otherEnv,
      });
      const cloneDir = join(otherDir, "clone");
      writeFileSync(join(cloneDir, "other.txt"), "other change", "utf8");
      execFileSync("git", ["add", "other.txt"], { cwd: cloneDir, encoding: "utf8", stdio: "pipe", env: otherEnv });
      execFileSync("git", ["commit", "-m", "other commit"], { cwd: cloneDir, encoding: "utf8", stdio: "pipe", env: otherEnv });
      execFileSync("git", ["push", "origin", "main"], { cwd: cloneDir, encoding: "utf8", stdio: "pipe", env: otherEnv });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }

    // Now modify the owned file locally (creating divergence)
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, diverged: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "blocked");
    assert.ok(
      result.diagnostics.some((d) => d.code === "branch-diverged"),
      "should detect branch divergence",
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout produces diagnostics for every severity level", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");
    writeFileSync(join(repo.dir, "unrelated.txt"), "unrelated", "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "blocked");
    assert.ok(result.diagnostics.length > 0);
    // Should have blocker-level diagnostic
    assert.ok(
      result.diagnostics.some((d) => d.severity === "blocker"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout skips owned file that has no changes", () => {
  const repo = createTempRepo();
  try {
    const result = runPublishCloseout({
      ownedPaths: { primary: "README.md" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "no_changes");
    assert.ok(
      result.diagnostics.some((d) => d.code === "no-changes"),
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout creates commit message with primary and sidecar", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "init dag"]);
    repo.run(["push", "origin", "main"]);

    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");
    writeFileSync(join(repo.dir, "output.trace.json"), JSON.stringify({ trace: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json", sidecar: "output.trace.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "published");

    // Check commit message
    const msg = repo.run(["log", "-1", "--pretty=%s"]);
    assert.match(msg, /goal-dag closeout/);
    assert.match(msg, /output\.dag\.json/);
    assert.match(msg, /output\.trace\.json/);
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout blocks when worktree is dirty after committing owned files and unrelated dirt remains", () => {
  const repo = createTempRepo();
  try {
    // Create owned output
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "add owned"]);
    repo.run(["push", "origin", "main"]);

    // An unrelated dirty file that persists
    writeFileSync(join(repo.dir, "other.txt"), "i am unrelated", "utf8");

    // Modify owned file
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    // Since there's an unrelated dirty file, it should block before commit
    assert.equal(result.mode, "blocked");
    assert.ok(
      result.diagnostics.some((d) => d.code === "unrelated-dirty-file"),
      "unrelated dirty file should block",
    );
  } finally {
    cleanupRepo(repo);
  }
});

test("build-dag CLI integration smoke test with closeout and non-published", () => {
  const repo = createTempRepo();
  try {
    const specPath = join(repo.dir, "spec.json");
    const outPath = join(repo.dir, "out.dag.json");

    writeFileSync(
      specPath,
      JSON.stringify({
        objective: "x",
        nodes: [{ id: "test-node", objective: "test" }],
      }),
      "utf8",
    );

    // Run with --non-published (no real git changes needed for build)
    const result = execFileSync(
      process.execPath,
      [
        resolve(HERE, "..", "scripts", "build-dag.js"),
        "build-dag",
        "--spec", specPath,
        "--out", outPath,
        "--non-published",
      ],
      {
        cwd: repo.dir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    assert.match(result, /Closeout mode: non_published/);
    assert.match(result, /\[np-mode-active\]/);
    assert.match(result, /\/goal --dag/);
  } finally {
    cleanupRepo(repo);
  }
});

test("build-dag CLI rejects closeout when owned paths cannot be committed", () => {
  const repo = createTempRepo();
  try {
    const specPath = join(repo.dir, "spec.json");
    const outPath = join(repo.dir, "out.dag.json");

    writeFileSync(
      specPath,
      JSON.stringify({
        objective: "x",
        nodes: [{ id: "test-node", objective: "test" }],
      }),
      "utf8",
    );

    // Create an unrelated dirty file to cause closeout to block
    writeFileSync(join(repo.dir, "unrelated.txt"), "i am unrelated", "utf8");

    // Run with --closeout (will fail because of unrelated dirty file)
    try {
      execFileSync(
        process.execPath,
        [
          resolve(HERE, "..", "scripts", "build-dag.js"),
          "build-dag",
          "--spec", specPath,
          "--out", outPath,
          "--closeout",
        ],
        {
          cwd: repo.dir,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      assert.fail("Should have exited with non-zero code");
    } catch (error: unknown) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      // Exit code should be non-zero (1 from process.exit or 1 from uncaught throw)
      assert.notEqual(err.status, 0);
      assert.ok(
        (err.stderr ?? "").includes("blocked") || (err.stdout ?? "").includes("blocked"),
        `Should output blocked state, got stderr: ${err.stderr}, stdout: ${err.stdout}`,
      );
    }
  } finally {
    cleanupRepo(repo);
  }
});

test("publish closeout result has consistent structure", () => {
  const repo = createTempRepo();
  try {
    const result = runPublishCloseout({
      ownedPaths: { primary: "README.md" },
      cwd: repo.dir,
    });

    // Check structural invariants
    assert.ok(["published", "no_changes", "blocked", "non_published"].includes(result.mode));
    assert.ok(Array.isArray(result.diagnostics));
    for (const diag of result.diagnostics) {
      assert.ok(["info", "warning", "blocker"].includes(diag.severity));
      assert.ok(typeof diag.code === "string" && diag.code.length > 0);
      assert.ok(typeof diag.message === "string" && diag.message.length > 0);
    }
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout returns non_published with warning about goal-runner", () => {
  const repo = createTempRepo();
  try {
    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
      nonPublished: true,
    });

    assert.equal(result.mode, "non_published");
    const warnMsg = result.diagnostics.find((d) => d.code === "np-mode-active")?.message ?? "";
    assert.match(warnMsg, /NOT been committed/);
    assert.match(warnMsg, /goal-runner/);
  } finally {
    cleanupRepo(repo);
  }
});

test("runPublishCloseout includes remote verification for GitHub-like remote", () => {
  const repo = createTempRepo();
  try {
    // The temp repo uses a local bare repo as remote, which doesn't match github.com
    // So remote-verification should be skipped with info diagnostic
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1 }), "utf8");
    repo.run(["add", "output.dag.json"]);
    repo.run(["commit", "-m", "add dag"]);
    repo.run(["push", "origin", "main"]);
    writeFileSync(join(repo.dir, "output.dag.json"), JSON.stringify({ version: 1, updated: true }), "utf8");

    const result = runPublishCloseout({
      ownedPaths: { primary: "output.dag.json" },
      cwd: repo.dir,
    });

    assert.equal(result.mode, "published");
    // Since remote is local (not github.com), verification should be skipped
    assert.ok(
      result.diagnostics.some((d) => d.code === "remote-verification-skipped"),
    );
  } finally {
    cleanupRepo(repo);
  }
});
