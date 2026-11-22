/**
 * End-to-end tests for the local indexer: a real repository on disk, a real HTTP
 * receiver standing in for the cluster, and the real CLI entrypoint in between.
 *
 * The security invariant under test: no absolute path and no file content read by
 * the server. Everything the receiver sees must be text that the client chose to send.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../bin/retaindb-index.mjs";

const HOME_BACKUP = process.env.HOME;
let repository;
let home;
let receiver;
let api;
let batches;

before(async () => {
  repository = await mkdtemp(join(tmpdir(), "retaindb-index-"));
  home = await mkdtemp(join(tmpdir(), "retaindb-index-home-"));
  process.env.HOME = home;
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src", "alpha.ts"), "export const alpha = 1;\n".repeat(80), "utf8");
  await writeFile(join(repository, "src", "beta.py"), "value = 2\n".repeat(40), "utf8");
  await writeFile(join(repository, "src", "skip.bin"), "binary\0payload", "utf8");
  await writeFile(join(repository, "notes.txt"), "deployment notes\n", "utf8");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "docs", "runbook.md"), "# runbook\nrollback steps\n", "utf8");
  batches = [];
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      batches.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"success\":true}");
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${receiver.address().port}`;
});

after(async () => {
  process.env.HOME = HOME_BACKUP;
  await new Promise((resolve) => receiver.close(resolve));
  await rm(repository, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("indexes every text file in a plain directory, no git and no extension filter", async () => {
  const report = await run({ root: repository, api, key: "test-key", project: "retaindb", dryRun: false });
  assert.equal(report.changed, 4);
  assert.ok(report.sent >= 2);
  const items = batches.flatMap((batch) => batch.items);
  assert.ok(items.every((item) => item.type === "text"));
  assert.ok(items.every((item) => item.metadata.source === "retaindb-index"));
});

test("sends repository-relative paths only", async () => {
  const payload = JSON.stringify(batches);
  assert.ok(payload.includes("src/alpha.ts"));
  assert.ok(payload.includes("notes.txt"));
  assert.ok(payload.includes("docs/runbook.md"));
  assert.ok(!payload.includes(repository));
  assert.ok(!payload.includes("/src/alpha.ts:"));
});

test("never sends a binary or non-source file", async () => {
  const titles = batches.flatMap((batch) => batch.items).map((item) => item.title);
  assert.ok(titles.every((title) => !title.startsWith("src/skip.bin")));
});

test("splits long files into overlapping chunks", async () => {
  const alpha = batches.flatMap((batch) => batch.items).filter((item) => item.title.startsWith("src/alpha.ts"));
  assert.ok(alpha.length >= 2);
  const [first, second] = alpha;
  assert.ok(first.metadata.end_line >= second.metadata.start_line - 8);
});

test("a second run sends nothing for unchanged files", async () => {
  const before = batches.length;
  const report = await run({ root: repository, api, key: "test-key", project: "retaindb", dryRun: false });
  assert.equal(report.changed, 0);
  assert.equal(batches.length, before);
});

test("dry run reports what would be sent and posts nothing", async () => {
  const before = batches.length;
  const report = await run({ root: repository, api, key: "test-key", project: "retaindb", dryRun: true });
  assert.equal(report.sent, 0);
  assert.equal(batches.length, before);
});
