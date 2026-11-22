import test from "node:test";
import assert from "node:assert/strict";
import { buildIndexArgs } from "../src/index-args.mjs";

test("a plain index request carries the root and the graph flag", () => {
  assert.deepEqual(buildIndexArgs({ root: "/code/repo" }), ["--root", "/code/repo", "--graph"]);
});

test("graph can be turned off and a project passed", () => {
  assert.deepEqual(buildIndexArgs({ root: ".", project: "retaindb", graph: false }), ["--root", ".", "--project", "retaindb"]);
});

test("dry run, batch and delay reach the CLI in order", () => {
  assert.deepEqual(
    buildIndexArgs({ root: "/a", dry_run: true, batch: 50, delay: 0 }),
    ["--root", "/a", "--graph", "--dry-run", "--batch", "50", "--delay", "0"],
  );
});
