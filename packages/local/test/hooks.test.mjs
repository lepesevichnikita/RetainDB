import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const compactContext = "Recorder project context";
const compressedOutput = "Recorder compact tool output";

async function startRecorder(t, requests, apiKey, sessionStartStatus = 200) {
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    const authorization = request.headers.authorization;
    const authenticated = !apiKey || authorization === `Bearer ${apiKey}`;
    const status = !authenticated ? 401 : request.url === "/retaindb/session/start" ? sessionStartStatus : request.url === "/v1/agent-events/workstation" ? 202 : 200;
    requests.push({
      path: request.url,
      method: request.method,
      contentType: request.headers["content-type"],
      authorization: !authorization ? "absent" : authenticated ? "accepted" : "rejected",
      status,
      body: JSON.parse(input),
    });
    let body;
    if (!authenticated) body = { error: "Unauthorized" };
    else if (status === 404) body = { error: "Not found" };
    else if (request.url === "/v1/context/pack") body = { context: compactContext };
    else if (request.url === "/v1/context/compress-output") body = { compressed: compressedOutput };
    else if (request.url === "/v1/agent-events") body = { captured: true };
    else body = { error: "Unexpected request" };
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function invokeHook(baseUrl, kind, data, apiKey, configPath = join(tmpdir(), "retaindb-absent-config.json")) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_BASE_URL: baseUrl,
    RETAINDB_CONFIG: configPath,
    RETAINDB_PROJECT: "native-hook-regression",
    RETAINDB_SESSION_ID: "hook-session",
    RETAINDB_AUTO_CONTEXT: "true",
    RETAINDB_COMPRESS_TOOL_OUTPUT: "true",
    RETAINDB_TOKEN_BUDGET: "1200",
    TSX_DISABLE_CACHE: "1",
    NODE_NO_WARNINGS: "1",
  });
  if (apiKey !== undefined) env.RETAINDB_API_KEY = apiKey;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx/esm", cliPath, "hook", `--kind=${kind}`, "--agent=native-test"], {
      cwd: packageRoot,
      env,
      timeout: 10000,
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    child.stdin.end(JSON.stringify(data));
  });
}

function assertRequests(requests, paths, protectedAccess) {
  assert.deepEqual(requests.map(({ path, status, authorization }) => ({ path, status, authorization })),
    paths.map((path) => ({ path, status: 200, authorization: protectedAccess ? "accepted" : "absent" })));
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.contentType, "application/json");
  }
}

test("plugin and CLI hooks use the configured API, credentials and project", { timeout: 20000 }, async (t) => {
  const requests = [];
  const key = randomUUID();
  const baseUrl = await startRecorder(t, requests, key);
  const configPath = join(tmpdir(), `retaindb-config-${randomUUID()}.json`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_CONFIG: configPath, RETAINDB_SESSION_ID: "hook-session",
    RETAINDB_PORT: new URL(baseUrl).port, TSX_DISABLE_CACHE: "1", NODE_NO_WARNINGS: "1",
  });
  // Supply fixture file bytes without writing credentials or creating a file to delete.
  const fixture = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => path === ${JSON.stringify(configPath)}
      ? ${JSON.stringify(JSON.stringify({ api: baseUrl, token: key, project: "native-hook-regression" }))} : read(path, ...args);
    syncBuiltinESMExports();`;
  const preload = `data:text/javascript,${encodeURIComponent(fixture)}`;
  for (const args of [[join(packageRoot, "plugin", "scripts", "session-start.mjs")], ["--import", "tsx/esm", cliPath, "hook", "--kind=session_end"]]) {
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ["--import", preload, ...args], { cwd: packageRoot, env, timeout: 10000 },
        (error) => error ? reject(error) : resolve());
      child.stdin.end(JSON.stringify({ prompt: "Recall project context", cwd: packageRoot }));
    });
  }

  const accepted = requests.filter((request) => request.authorization === "accepted");
  assert.ok(accepted.length > 0, "a hook configured from the file must authenticate");
  assert.ok(accepted.some((request) => request.path === "/v1/context/pack"), "the context pack must be requested");
  assert.ok(accepted.some((request) => request.path === "/v1/agent-events"), "the native CLI must capture to the configured API");
  assert.ok(accepted.every((request) => request.body.project === "native-hook-regression"), "a working directory must not override the configured project");
  assert.equal(requests.filter((request) => request.authorization !== "accepted").length, 0, "no hook request may go out unauthenticated");
});

test("workstation hooks do not submit an unembedded event when the configured model is unavailable", { timeout: 20000 }, async (t) => {
  const requests = [];
  const baseUrl = await startRecorder(t, requests, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_BASE_URL: baseUrl, RETAINDB_AUTO_CONTEXT: "false", RETAINDB_HOOK_EMBEDDING_MODE: "workstation",
    RETAINDB_HOOK_EMBEDDING_MODEL: `unavailable-fixture/${randomUUID()}`, TSX_DISABLE_CACHE: "1",
    RETAINDB_CONFIG: join(tmpdir(), `retaindb-absent-${randomUUID()}.json`),
  });
  for (const args of [[join(packageRoot, "plugin", "scripts", "prompt-submit.mjs")], ["--import", "tsx/esm", cliPath, "hook", "--kind=prompt"]]) {
    const stderr = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, args, { cwd: packageRoot, env, timeout: 12000 },
        (error, _stdout, stderr) => error ? reject(error) : resolve(stderr));
      child.stdin.end(JSON.stringify({ prompt: "Synthetic workstation capture" }));
    });
    // A workstation error stays visible and cannot silently become a server capture.
    assert.deepEqual(requests, []);
    assert.match(stderr, /workstation capture not submitted/i);
  }
});

const workstationModel = process.env.RETAINDB_TEST_WORKSTATION_MODEL;
const runWorkstation = workstationModel ? test : test.skip;
runWorkstation("shared local hook configuration embeds in both entry points and rejects an invalid override", { timeout: 30000 }, async (t) => {
  const requests = [];
  const key = randomUUID();
  const api = await startRecorder(t, requests, key);
  const configPath = join(tmpdir(), `retaindb-config-${randomUUID()}.json`);
  const config = { api, token: key, project: "configured-project", hook_embedding_mode: "local", hook_embedding_model: workstationModel };
  const fixture = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => path === ${JSON.stringify(configPath)}
      ? ${JSON.stringify(JSON.stringify(config))} : read(path, ...args);
    syncBuiltinESMExports();`;
  const preload = `data:text/javascript,${encodeURIComponent(fixture)}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, { RETAINDB_CONFIG: configPath, TSX_DISABLE_CACHE: "1" });
  const plugin = (script) => [join(packageRoot, "plugin", "scripts", script)];
  const cli = ["--import", "tsx/esm", cliPath, "hook", "--kind=prompt"];
  for (const [mode, args] of [[null, plugin("prompt-submit.mjs")], [null, cli],
    ["workstaton", plugin("session-start.mjs")], ["workstaton", plugin("stop.mjs")], ["workstaton", cli]]) {
    const before = requests.length;
    const selected = mode ? { ...env, RETAINDB_HOOK_EMBEDDING_MODE: mode } : env;
    const stderr = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ["--import", preload, ...args], { cwd: packageRoot, env: selected, timeout: 10000 },
        (error, _stdout, stderr) => error ? reject(error) : resolve(stderr));
      child.stdin.end(JSON.stringify({ prompt: "Cache this fact locally", project: "payload-project",
        session_id: "source-session", agent_id: "source-agent" }));
    });
    // An invalid override must not trigger capture, context, or lifecycle calls.
    if (mode) {
      assert.deepEqual(requests.slice(before), []);
      assert.match(stderr, /invalid hook embedding mode/i);
      continue;
    }
    const sent = requests.slice(before);
    assert.deepEqual(sent.map(({ path, authorization }) => [path, authorization]), [["/v1/agent-events/workstation", "accepted"]]);
    assert.equal(sent[0].body.project, "configured-project");
    // The authenticated capture must retain the original conversation and agent.
    assert.equal(sent[0].body.session_id, "source-session");
    assert.equal(sent[0].body.agent_id, "source-agent");
    assert.equal(sent[0].body.embedding.model, workstationModel);
    assert.equal(sent[0].body.embedding.vector.length, 1024);
    assert.ok(sent[0].body.embedding.vector.some((value) => value !== 0));
  }
});

runWorkstation("the plugin executes the cached model and submits only an embedded capture", { timeout: 30000 }, async (t) => {
  const requests = [];
  const key = randomUUID();
  const baseUrl = await startRecorder(t, requests, key);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_BASE_URL: baseUrl, RETAINDB_API_KEY: key, RETAINDB_HOOK_EMBEDDING_MODE: "workstation",
    RETAINDB_HOOK_EMBEDDING_MODEL: workstationModel,
    RETAINDB_CONFIG: join(tmpdir(), `retaindb-absent-${randomUUID()}.json`),
  });
  const stderr = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(packageRoot, "plugin", "scripts", "prompt-submit.mjs")],
      { cwd: packageRoot, env, timeout: 25000 }, (error, _stdout, stderr) => error ? reject(error) : resolve(stderr));
    child.stdin.end(JSON.stringify({ project: "workstation-project", session_id: "workstation-session", prompt: "Cache a useful search result." }));
  });

  // Real model inference should emit an authenticated receipt and no recall or server embedding request.
  assert.equal(stderr.includes("workstation capture not submitted"), false);
  assert.deepEqual(requests.map(({ path, authorization }) => [path, authorization]), [["/v1/agent-events/workstation", "accepted"]]);
  const { body } = requests[0];
  assert.equal(body.project, "workstation-project");
  assert.equal(body.session_id, "workstation-session");
  assert.equal(body.event.summary, "Cache a useful search result.");
  assert.equal(body.embedding.model, workstationModel);
  assert.equal(body.embedding.vector.length, 1024);
  assert.ok(body.embedding.vector.every(Number.isFinite));
  assert.ok(body.embedding.vector.some((value) => value !== 0));
});

test("the plugin stop hook authenticates and attributes every request to the explicit project", { timeout: 20000 }, async (t) => {
  const requests = [];
  const key = randomUUID();
  const baseUrl = await startRecorder(t, requests, key);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_BASE_URL: baseUrl, RETAINDB_API_KEY: key,
    RETAINDB_CONFIG: join(tmpdir(), `retaindb-absent-${randomUUID()}.json`),
  });
  await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(packageRoot, "plugin", "scripts", "stop.mjs")],
      { cwd: packageRoot, env, timeout: 10000 }, (error) => error ? reject(error) : resolve());
    child.stdin.end(JSON.stringify({ project: "named-project", cwd: packageRoot, session_id: "stop-session" }));
  });

  // Capture and lifecycle requests must agree even when the checkout name differs.
  assertRequests(requests, ["/retaindb/observe", "/retaindb/summarize", "/retaindb/session/end"], true);
  assert.deepEqual(requests.map(({ body }) => body.project), ["named-project", "named-project", "named-project"]);
  assert.deepEqual(requests.map(({ body }) => body.sessionId), ["stop-session", "stop-session", "stop-session"]);
});

test("the plugin session-start hook captures the event when the Local session API is absent", { timeout: 20000 }, async (t) => {
  const requests = [];
  const key = randomUUID();
  const baseUrl = await startRecorder(t, requests, key, 404);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_BASE_URL: baseUrl, RETAINDB_API_KEY: key, RETAINDB_AUTO_CONTEXT: "false",
    RETAINDB_MACHINE: "fixture-workstation",
    RETAINDB_CONFIG: join(tmpdir(), `retaindb-absent-${randomUUID()}.json`),
  });
  await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(packageRoot, "plugin", "scripts", "session-start.mjs")],
      { cwd: packageRoot, env, timeout: 10000 }, (error) => error ? reject(error) : resolve());
    child.stdin.end(JSON.stringify({ project: "named-project", cwd: packageRoot, session_id: "start-session" }));
  });

  // PostgreSQL Server accepts native observations, not Local session-start requests.
  const observation = requests.find((request) => request.path === "/retaindb/observe");
  assert.equal(observation?.authorization, "accepted");
  assert.equal(observation.body.machine, "fixture-workstation");
  assert.deepEqual([observation.body.hookType, observation.body.sessionId, observation.body.project],
    ["session_start", "start-session", "named-project"]);
});

for (const mode of ["protected", "open-unset", "open-empty"]) {
  for (const kind of ["prompt", "pre_tool_use", "pre_compact"]) {
    test(`${kind} authenticates context and event requests (${mode})`, { timeout: 20000 }, async (t) => {
      const requests = [];
      const key = mode === "protected" ? randomUUID() : undefined;
      const baseUrl = await startRecorder(t, requests, key);
      const input = { prompt: "Recall project context", cwd: packageRoot, files: ["src/cli.ts"], previous_context_hash: "prior-context" };
      const result = await invokeHook(baseUrl, kind, input, mode === "open-empty" ? "" : key);

      assertRequests(requests, ["/v1/context/pack", "/v1/agent-events"], mode === "protected");
      assert.deepEqual(requests[0].body, {
        project: "native-hook-regression",
        query: input.prompt,
        cwd: packageRoot,
        files: input.files,
        previous_context_hash: input.previous_context_hash,
        token_budget: 1200,
      });
      assert.equal(requests[1].body.event.kind, kind);
      assert.equal(requests[1].body.session_id, "hook-session");
      assert.equal(requests[1].body.agent_id, "native-test");
      assert.deepEqual(JSON.parse(requests[1].body.event.details), input);
      assert.equal(result.stdout, `\nRetainDB compact context:\n${compactContext}\n`);
      assert.equal(result.stderr, "");
    });
  }

  test(`tool_result authenticates compression and event requests (${mode})`, { timeout: 20000 }, async (t) => {
    const requests = [];
    const key = mode === "protected" ? randomUUID() : undefined;
    const baseUrl = await startRecorder(t, requests, key);
    const input = { tool_name: "Read", tool_output: "Tool output diagnostic\n".repeat(100) };
    const result = await invokeHook(baseUrl, "tool_result", input, mode === "open-empty" ? "" : key);

    assertRequests(requests, ["/v1/context/compress-output", "/v1/agent-events"], mode === "protected");
    assert.deepEqual(requests[0].body, {
      output: input.tool_output,
      token_budget: 1200,
    });
    assert.equal(requests[1].body.event.kind, "tool_result");
    assert.equal(requests[1].body.event.summary, JSON.stringify(input));
    const details = JSON.parse(requests[1].body.event.details);
    assert.equal(details.tool_output, compressedOutput);
    assert.equal(details.tool_response, compressedOutput);
    assert.equal(details.output_compressed, true);
    assert.match(details.raw_output_hash, /^[a-f0-9]{64}$/);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test(`session_end authenticates its event without extra requests (${mode})`, { timeout: 20000 }, async (t) => {
    const requests = [];
    const key = mode === "protected" ? randomUUID() : undefined;
    const baseUrl = await startRecorder(t, requests, key);
    const input = { summary: "Finished native hook regression" };
    const result = await invokeHook(baseUrl, "session_end", input, mode === "open-empty" ? "" : key);

    assertRequests(requests, ["/v1/agent-events"], mode === "protected");
    assert.equal(requests[0].body.event.kind, "session_end");
    assert.equal(requests[0].body.event.summary, JSON.stringify(input));
    assert.equal(requests[0].body.project, "native-hook-regression");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
}

for (const credentials of ["missing", "incorrect"]) {
  test(`protected recorder rejects ${credentials} credentials`, { timeout: 20000 }, async (t) => {
    const requests = [];
    const baseUrl = await startRecorder(t, requests, randomUUID());
    const result = await invokeHook(baseUrl, "session_end", { summary: "Rejected event" }, credentials === "missing" ? undefined : randomUUID());

    assert.deepEqual(requests.map(({ path, status, authorization }) => ({ path, status, authorization })), [{
      path: "/v1/agent-events",
      status: 401,
      authorization: credentials === "missing" ? "absent" : "rejected",
    }]);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
  });
}
