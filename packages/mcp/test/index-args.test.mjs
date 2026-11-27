import test from "node:test";
import assert from "node:assert/strict";
import { buildIndexArgs } from "../src/index-args.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";

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

test("MCP search shares knowledge by default, labels hits, and reports a missing project", async t => {
  const api = "https://search-fixture.invalid";
  const config = { RETAINDB_BASE_URL: api, RETAINDB_PROJECT: "project-one", RETAINDB_API_KEY: "fixture" };
  const previous = Object.keys(config).map(name => [name, process.env[name]]);
  Object.assign(process.env, config);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const requests = [];
  let supportsTags = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), `${api}/v1/context/query`);
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.project === "missing") return Response.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
    if (body.tags && supportsTags) return Response.json({ results: [{ id: "project-two", content: "Tagged hit", project: "project-two", metadata: { tags: body.tags } }], context: "Tagged hit", meta: { applied_tags: body.tags } });
    const results = (body.project ? [body.project] : ["project-one", "project-two"])
      .map(project => ({ id: project, content: `Found in ${project}`, project }));
    return Response.json({ results, context: "Shared query", meta: {} });
  });
  const { createMcpServer } = await import("../src/server.ts");
  const server = createMcpServer();
  const client = new Client({ name: "search-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // A configured write project must not narrow search unless the call selects it.
  for (const project of [undefined, "project-two"]) {
    const result = await client.callTool({ name: "search", arguments: { query: "f8b3f57e-remote-search-fixture", project } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results.map(hit => hit.project), project ? [project] : ["project-one", "project-two"]);
  }
  const missing = await client.callTool({ name: "search", arguments: { query: "f8b3f57e-remote-search-fixture", project: "missing" } });
  assert.equal(missing.isError, true);
  // Tool validation must pass the exact tag filter to the server, not filter the returned top hits.
  const tags = ["project:project-two", "machine:mac-mini"];
  const args = { query: "f8b3f57e-remote-search-fixture", tags };
  const unsupported = await client.callTool({ name: "search", arguments: args });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0].text, /TAG_FILTER_UNSUPPORTED/);
  supportsTags = true;
  const tagged = await client.callTool({ name: "search", arguments: args });
  assert.equal(tagged.isError, undefined);
  assert.deepEqual(JSON.parse(tagged.content[0].text).results.map(hit => hit.project), ["project-two"]);
  assert.deepEqual(requests.at(-1).tags, tags);
  assert.deepEqual(requests.map(body => body.project), [undefined, "project-two", "missing", undefined, undefined]);
});

test("the cluster MCP package filters shared knowledge without changing scoped search", async t => {
  const bodies = [];
  let acknowledgeTags = false;
  const api = createServer(async (request, response) => {
    let json = "";
    for await (const chunk of request) json += chunk;
    if (request.url !== "/v1/context/query" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(json);
    bodies.push(body);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      context: "Knowledge fixture",
      results: [{ id: "fixture-hit", content: "Knowledge fixture", project: "chosen-project", metadata: { tags: body.tags } }],
      meta: { applied_tags: acknowledgeTags ? body.tags : undefined },
    }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [createRequire(import.meta.url).resolve("@retaindb/mcp-server/dist/server.js")],
    env: { RETAINDB_BASE_URL: `http://127.0.0.1:${api.address().port}`, RETAINDB_API_KEY: "fixture", RETAINDB_PROJECT: "default-project" },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-compatibility-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await new Promise(resolve => api.close(resolve)); });
  await client.connect(transport);

  const { tools } = await client.listTools();
  for (const name of ["context.query", "index.workspace_run", "memory.forget", "search"]) {
    assert.ok(tools.some(tool => tool.name === name), `missing existing tool: ${name}`);
  }
  assert.equal(tools.find(tool => tool.name === "search").inputSchema.properties.tags?.type, "array");

  const tags = ["project:chosen-project", "machine:build-host"];
  const search = args => client.callTool({ name: "search", arguments: { query: "Knowledge fixture", top_k: 1, ...args } });
  const refused = await search({ tags });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).error.code, "TAG_FILTER_UNSUPPORTED");
  acknowledgeTags = true;
  const tagged = JSON.parse((await search({ tags })).content[0].text);
  assert.deepEqual(tagged.applied_tags, tags);
  assert.deepEqual(tagged.results.map(hit => [hit.id, hit.project, hit.metadata.tags]), [["fixture-hit", "chosen-project", tags]]);
  const scoped = JSON.parse((await search({ project: "chosen-project", tags })).content[0].text);
  assert.equal(scoped.success, true);
  const shared = JSON.parse((await search({ search_all: true })).content[0].text);
  assert.equal(shared.success, true);
  const legacy = JSON.parse((await search({})).content[0].text);
  assert.equal(legacy.success, true);
  assert.deepEqual(bodies.map(body => [body.project, body.tags, body.include_memories]), [
    [undefined, tags, false], [undefined, tags, false], ["chosen-project", tags, false],
    [undefined, undefined, false], ["default-project", undefined, false],
  ]);
  const incompatible = await search({ tags, include_memories: true });
  assert.equal(incompatible.isError, true);
  assert.equal(JSON.parse(incompatible.content[0].text).error.code, "KNOWLEDGE_SEARCH_ONLY");
  assert.equal(bodies.length, 5);
});
