import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { listFiles } from "../src/files.mjs";

const run = promisify(execFile);

async function scratchRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "retaindb-files-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function git(root, args) {
  await run("git", ["-C", root, ...args]);
}

test("a git work tree is indexed by its own ignore rules, so node_modules never becomes chunks", async (t) => {
  const root = await scratchRepo(t);
  await git(root, ["init", "-q"]);
  await writeFile(join(root, ".gitignore"), "node_modules/\nvendor/\n");
  await writeFile(join(root, "app.ts"), "export const a = 1;\n");
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor/lib.go"), "package lib\n");

  const files = await listFiles(root);
  assert.deepEqual(files.sort(), [".gitignore", "app.ts"]);
});

test("a file git tracks inside an ignored directory is still indexed", async (t) => {
  const root = await scratchRepo(t);
  await git(root, ["init", "-q"]);
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist/keep.js"), "export const kept = true;\n");
  await git(root, ["add", "-f", "dist/keep.js"]);

  const files = await listFiles(root);
  assert.ok(files.includes("dist/keep.js"), "a tracked file is part of the repository even under an ignored path");
});

test("an untracked file with a negation rule is indexed", async (t) => {
  const root = await scratchRepo(t);
  await git(root, ["init", "-q"]);
  await writeFile(join(root, ".gitignore"), "build/*\n!build/keep.md\n");
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "build/keep.md"), "keep me\n");
  await writeFile(join(root, "build/drop.md"), "drop me\n");

  const files = await listFiles(root);
  assert.ok(files.includes("build/keep.md"));
  assert.ok(!files.includes("build/drop.md"));
});

test("a directory outside git still skips dependency and build stores", async (t) => {
  const root = await scratchRepo(t);
  await writeFile(join(root, "main.py"), "print(1)\n");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules/index.js"), "module.exports = 1;\n");
  await mkdir(join(root, ".venv/lib"), { recursive: true });
  await writeFile(join(root, ".venv/lib/site.py"), "x = 1\n");

  const files = await listFiles(root);
  assert.deepEqual(files, ["main.py"]);
});
