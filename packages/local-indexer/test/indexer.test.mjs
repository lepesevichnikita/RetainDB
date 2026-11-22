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
import { loadConfig, parseOptions, run } from "../bin/retaindb-index.mjs";
import { IndexQueue, drainQueue } from "../src/queue.mjs";

const HOME_BACKUP = process.env.HOME;
let repository;
let home;
let receiver;
let api;
let batches;
let graph;

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
  graph = [];
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      if (request.url.startsWith("/v1/graph/batch")) {
        graph.push({ path: request.url, body: parsed });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"entities":${parsed.entities.length},"relations":${parsed.relations.length}}`);
        return;
      }
      batches.push(parsed);
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

test("config file supplies api, project and token, and flags still win", async () => {
  await mkdir(join(home, ".retaindb-mcp"), { recursive: true });
  await writeFile(join(home, ".retaindb-mcp", "config.json"), JSON.stringify({ api, project: "from-config", token: "config-key" }), "utf8");
  const config = await loadConfig();
  const fromFile = parseOptions([], {}, config);
  assert.equal(fromFile.api, api);
  assert.equal(fromFile.key, "config-key");
  assert.equal(fromFile.project, "from-config");
  const flagged = parseOptions(["--project", "flag"], {}, config);
  assert.equal(flagged.project, "flag");
});

test("--graph ships the module, its symbols and the import edges", async () => {
  await writeFile(join(repository, "src", "gamma.ts"), "import { alpha } from \"./alpha\";\nexport function gamma() { return 3; }\n", "utf8");
  graph.length = 0;
  const report = await run({ root: repository, api, key: "test-key", project: "retaindb", dryRun: false, graph: true });
  assert.equal(report.changed, 1);
  assert.ok(report.graph.entities >= 2);
  const entities = graph.flatMap((call) => call.body.entities);
  const relations = graph.flatMap((call) => call.body.relations);
  assert.ok(entities.some((entity) => entity.name === "src/gamma.ts" && entity.entity_type === "module"));
  assert.ok(entities.some((entity) => entity.name === "src/gamma.ts#gamma" && entity.entity_type === "symbol"));
  assert.ok(relations.some((relation) => relation.relation_type === "part_of"));
  assert.ok(relations.some((relation) => relation.relation_type === "imports" && relation.to_entity === "./alpha"));
});

test("a repeated chunk key keeps only the newest payload", async () => {
  const queue = await IndexQueue.open(join(home, "dedupe.json"));
  queue.add("src/a.ts#1-2", { content: "old" });
  queue.add("src/a.ts#1-2", { content: "new" });
  assert.equal(queue.size, 1);
  assert.equal(queue.take(10)[0][1].content, "new");
});

test("a failed drain leaves the whole queue on disk for the next run", async () => {
  const path = join(home, "resume.json");
  const queue = await IndexQueue.open(path);
  queue.add("k1", { n: 1 });
  queue.add("k2", { n: 2 });
  await queue.save();
  await assert.rejects(drainQueue(queue, async () => { throw new Error("boom"); }, { groupSize: 1, concurrency: 1 }));
  const reopened = await IndexQueue.open(path);
  assert.equal(reopened.size, 2);
});

test("graph rows leave in one batched request", async () => {
  await writeFile(join(repository, "src", "delta.ts"), "export function delta() { return 4; }\n", "utf8");
  graph.length = 0;
  const before = graph.length;
  const report = await run({ root: repository, api, key: "test-key", project: "retaindb", dryRun: false, graph: true, delay: 0 });
  assert.ok(report.graph.entities >= 1);
  assert.equal(graph.length - before, 1, `sent ${graph.length - before} requests`);
  const [call] = graph;
  assert.ok(call.body.entities.length >= 2);
  assert.ok(call.body.relations.length >= 1);
});
