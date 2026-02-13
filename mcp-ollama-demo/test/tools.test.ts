import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRuntime, normalizeWorkspaceRelativePath, resolveWorkspacePath } from "../tools.js";

async function withTempWorkspace(fn: (workspace: string, runtime: ToolRuntime) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ollama-demo-"));
  const workspace = path.join(base, "workspace");
  const runtime = new ToolRuntime(workspace);
  await runtime.ensureWorkspace();
  try {
    await fn(workspace, runtime);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("normalizeWorkspaceRelativePath strips leading workspace/", () => {
  assert.equal(normalizeWorkspaceRelativePath("workspace/workspace/test.txt"), "test.txt");
  assert.equal(normalizeWorkspaceRelativePath("./workspace/src/index.html"), "src/index.html");
});

test("normalizeWorkspaceRelativePath rejects invalid paths", () => {
  assert.throws(() => normalizeWorkspaceRelativePath("/etc/passwd"), /Absolute paths/);
  assert.throws(() => normalizeWorkspaceRelativePath("../secret"), /must not contain '\.\.'/);
});

test("resolveWorkspacePath stays under workspace root", async () => {
  await withTempWorkspace(async (workspace) => {
    const resolved = resolveWorkspacePath(workspace, "workspace/docs/readme.md");
    assert.equal(resolved.relative, "docs/readme.md");
    assert.ok(resolved.absolute.startsWith(path.resolve(workspace)));
  });
});

test("write_file + read_file roundtrip", async () => {
  await withTempWorkspace(async (_workspace, runtime) => {
    const writeRes = await runtime.writeFile({ file: "notes.txt", content: "hello" });
    assert.equal(writeRes.ok, true);

    const readRes = await runtime.readFile({ file: "notes.txt" });
    assert.equal(readRes.ok, true);
    assert.equal(readRes.data.content, "hello");
  });
});

test("edit_file replaces content and supports expectedOccurrences", async () => {
  await withTempWorkspace(async (_workspace, runtime) => {
    await runtime.writeFile({ file: "a.txt", content: "cat cat cat" });
    const editRes = await runtime.editFile({
      file: "a.txt",
      find: "cat",
      replace: "dog",
      replaceAll: true,
      expectedOccurrences: 3,
    });
    assert.equal(editRes.ok, true);
    assert.equal(editRes.data.replacements, 3);

    const readRes = await runtime.readFile({ file: "a.txt" });
    assert.equal(readRes.data.content, "dog dog dog");
  });
});

test("mkdir + list_dir + move_file + delete_file", async () => {
  await withTempWorkspace(async (_workspace, runtime) => {
    await runtime.mkdir({ dir: "src/components", recursive: true });
    await runtime.writeFile({ file: "src/components/a.txt", content: "x" });
    await runtime.movePath({
      from: "workspace/src/components/a.txt",
      to: "src/components/b.txt",
      overwrite: false,
    });

    const listRes = await runtime.listDir({ dir: "src", recursive: true });
    assert.equal(listRes.ok, true);
    assert.ok(listRes.data.entries.some((entry) => entry.path === "src/components/b.txt"));

    const deleteRes = await runtime.deletePath({ path: "src/components/b.txt" });
    assert.equal(deleteRes.ok, true);
  });
});

test("run_command rejects non-allowlisted command", async () => {
  await withTempWorkspace(async (_workspace, runtime) => {
    await assert.rejects(
      () =>
        runtime.runCommand({
          command: "bash",
          args: ["-lc", "echo hello"],
        }),
      /Command is not in allowlist/,
    );
  });
});

