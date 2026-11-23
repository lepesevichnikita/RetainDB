import test from "node:test";
import assert from "node:assert/strict";
import { buildIndexArgs } from "../src/index-args.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), `${api}/v1/context/query`);
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.project === "missing") return Response.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
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
  assert.deepEqual(requests.map(body => body.project), [undefined, "project-two", "missing"]);
});
