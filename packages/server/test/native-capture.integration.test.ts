import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const savedEnvironment = { ...process.env };
const projectName = `native-${randomUUID()}`;
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.RETAINDB_API_KEY = randomBytes(32).toString("hex");
  process.env.EMBEDDING_MODE = "local";
  process.env.DISABLE_AUTO_EXTRACTION = "true";
  delete process.env.OPENAI_API_KEY;
}
const routesPath = "../src/api/routes.js";
const capturePath = "../src/engine/native-capture.js";

async function request(path: string, body?: unknown) {
  const { api } = await import(routesPath);
  const response = await api.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${process.env.RETAINDB_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}

run("workstation capture refuses missing, unusable or text-mismatched vectors before queuing", async () => {
  const { api } = await import(routesPath);
  const { db } = await import("../src/db/index.js");
  const project = `${projectName}-isolated`;
  const text = "Keep workstation inference local for a verified semantic capture.";
  const digest = createHash("sha256").update(text).digest("hex");
  const valid = { model: "fixture/model", vector: [1, ...Array(1023).fill(0)], content_sha256: digest };
  const payload = { project, session_id: randomUUID(), event: { kind: "prompt", summary: text } };
  for (const [embedding, status] of [[undefined, 400], [{ ...valid, vector: [1] }, 400],
    [{ ...valid, vector: Array(1024).fill(0) }, 400], [{ ...valid, content_sha256: "0".repeat(64) }, 422]] as const) {
    const response = await api.request("/v1/agent-events/workstation", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RETAINDB_API_KEY}` },
      body: JSON.stringify({ ...payload, embedding }),
    });
    assert.equal(response.status, status);
  }
  // No invalid capture may create even a pending server-side event.
  assert.equal(await db.session.count({ where: { sessionId: payload.session_id } }), 0);
});

run("the workstation receipt persists exactly the supplied searchable vector", async () => {
  const { db } = await import("../src/db/index.js");
  const { drainNativeCaptures } = await import(capturePath);
  const summary = "Workstation inference keeps event indexing off the server.";
  const model = "fixture/workstation";
  const vector = [0.25, -0.5, ...Array<number>(1022).fill(0)];
  const payload = { project: `${projectName}-isolated`, session_id: randomUUID(), event: { kind: "prompt", summary },
    embedding: { model, vector, content_sha256: createHash("sha256").update(summary).digest("hex") } };
  const receipt = await request("/v1/agent-events/workstation", payload);
  await drainNativeCaptures();
  const indexed = await request(`/v1/agent-events/${receipt.event_id}`);
  assert.equal(indexed.status, "indexed", JSON.stringify(indexed));
  assert.equal((await request("/v1/agent-events/workstation", payload)).event_id, receipt.event_id);

  // Search the saved vector independently of the product's text inference path.
  const rows = await db.$queryRaw<{ content: string; model: string; distance: number }[]>`
    SELECT content, metadata->>'embedding_model' AS model, embedding <=> ${`[${vector.join(",")}]`}::vector AS distance
    FROM chunks WHERE "documentId" = ${indexed.document_id} AND embedding IS NOT NULL
    ORDER BY distance ASC`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, summary);
  assert.equal(rows[0].model, model);
  assert.ok(Math.abs(rows[0].distance) < 1e-7);
});

const runWithLocalModel = process.env.RETAINDB_TEST_LOCAL_EMBEDDINGS === "true" ? run : test.skip;

runWithLocalModel("workstation tool hooks index safe output, not credential echoes", { timeout: 120000 }, async t => {
  const { api } = await import(routesPath);
  const { db } = await import("../src/db/index.js");
  const { serve } = await import("@hono/node-server");
  const { embedLocal, LOCAL_EMBEDDING_MODEL } = await import("../src/engine/embeddings-local.js");
  const project = `${projectName}-tools`;
  const expected = "Found zeolite desiccant [REDACTED]";
  // Warm the shared model cache before running the offline hooks.
  await embedLocal([expected]);
  const secret = `fixture-echo-${randomUUID()}`;
  const wire: { path: string; containsSecret: boolean; status: number }[] = [];
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    const containsSecret = (await req.clone().text()).includes(secret);
    const response = await api.fetch(req);
    wire.push({ path: new URL(req.url).pathname, containsSecret, status: response.status });
    return response;
  } });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const local = fileURLToPath(new URL("../../local/", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RETAINDB_")));
  Object.assign(env, {
    RETAINDB_BASE_URL: `http://127.0.0.1:${address.port}`, RETAINDB_API_KEY: process.env.RETAINDB_API_KEY,
    RETAINDB_CONFIG: join(tmpdir(), `retaindb-absent-${randomUUID()}.json`), RETAINDB_PROJECT: project,
    RETAINDB_HOOK_EMBEDDING_MODE: "local", RETAINDB_HOOK_EMBEDDING_MODEL: LOCAL_EMBEDDING_MODEL, TSX_DISABLE_CACHE: "1",
  });

  // Both hooks run the same tool; only their outputs distinguish the facts in search.
  const invocations = [
    { args: [join(local, "plugin/scripts/post-tool-use.mjs")], field: "tool_response", fact: "zeolite desiccant" },
    { args: ["--import", "tsx/esm", join(local, "src/cli.ts"), "hook", "--kind=tool_result"], field: "tool_output", fact: "zirconia bushing" },
  ];
  for (const { args, field, fact } of invocations) {
    const sessionId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, args, { cwd: local, env, timeout: 12000 }, error => error ? reject(error) : resolve());
      child.stdin!.end(JSON.stringify({ session_id: sessionId, tool_name: "Read", tool_input: { password: secret }, [field]: `Found ${fact} ${secret}` }));
    });
    assert.deepEqual(wire.shift(), { path: "/v1/agent-events/workstation", containsSecret: false, status: 202 });
    const stored = await db.message.findFirstOrThrow({ where: { session: { sessionId } } });
    assert.equal(stored.content, `Found ${fact} [REDACTED]`);
    assert.ok(!JSON.stringify(stored).includes(secret));
  }
  assert.deepEqual(wire, [], "workstation hooks must not issue recall or server capture requests");
  const result = await request("/v1/context/query", {
    project, query: "zeolite desiccant", use_vector: false, oracle_mode: "off", rerank: false, use_cache: false,
  });
  assert.deepEqual(result.results.map((hit: { content: string }) => hit.content), [expected]);
  // A vector for different text must not pass an exact-summary cosine threshold.
  const semantic = await request("/v1/context/query", {
    project, query: expected, hybrid: false, threshold: 0.99, oracle_mode: "off", rerank: false, use_cache: false,
  });
  assert.deepEqual(semantic.results.map((hit: { content: string }) => hit.content), [expected]);
});

runWithLocalModel("context search only compares workstation vectors from its query model", async () => {
  const { drainNativeCaptures } = await import(capturePath);
  const { embedSingle } = await import("../src/engine/embeddings.js");
  const { LOCAL_EMBEDDING_MODEL } = await import("../src/engine/embeddings-local.js");
  const project = `${projectName}-models`;
  const query = "A cobalt diaphragm controls the pneumatic actuator.";
  const vector = await embedSingle(query);
  const compatible = "The actuator diaphragm is made of cobalt.";
  const incompatible = "A saffron compass identifies the calibration fixture.";
  // Equal vector coordinates in different model spaces are not comparable.
  for (const [summary, model] of [[compatible, LOCAL_EMBEDDING_MODEL], [incompatible, "fixture/incompatible"]]) {
    const receipt = await request("/v1/agent-events/workstation", {
      project, session_id: randomUUID(), event: { kind: "prompt", summary },
      embedding: { model, vector, content_sha256: createHash("sha256").update(summary).digest("hex") },
    });
    await drainNativeCaptures();
    assert.equal((await request(`/v1/agent-events/${receipt.event_id}`)).status, "indexed");
  }
  const search = { project, oracle_mode: "off", rerank: false, threshold: 0, use_cache: false };
  const semantic = await request("/v1/context/query", { ...search, query, hybrid: false });
  const hits = semantic.results.map((row: { content: string }) => row.content);
  assert.ok(hits.includes(compatible));
  assert.ok(!hits.includes(incompatible), "same-width vectors from a different model must not rank");
  const lexical = await request("/v1/context/query", { ...search, query: "saffron compass", use_vector: false });
  assert.ok(lexical.results.some((row: { content: string }) => row.content === incompatible));
});

run("native hook events persist, replay once, recover pending work and retrieve real local vectors", async () => {
  const { db } = await import("../src/db/index.js");
  const { drainNativeCaptures } = await import(capturePath);
  const credentialEchoes = ["fixture-embedded-token", "12345678", "87654321"];
  const payload = {
    project: projectName, sessionId: "shared-external-session", hookType: "user_prompt_submit", agent_id: "native-fixture-agent",
    timestamp: "2026-11-06T12:00:00.000Z",
    data: { prompt: "PostgreSQL recovery must verify backup checksums before restoring database partitions.", api_key: "fixture-sensitive-value", env: { RETAINDB_API_KEY: "fixture-env-sensitive-value" }, details: 'password="fixture quoted secret phrase"',
      connection: "postgres://fixture-user:fixture-connection-secret@localhost:5432/memory",
      key_file: "-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----",
      authorization: ["Bearer", credentialEchoes[0]].join(" "), tool_input: `PASSWORD=${credentialEchoes[1]}`, password: Number(credentialEchoes[2]),
      tool_response: `fixture-env-sensitive-value fixture-connection-secret fixture-private-material ${credentialEchoes.join(" ")}` },
  };
  const responses = await Promise.all(Array.from({ length: 4 }, () => request("/retaindb/observe", payload)));
  assert.ok(responses.every(result => result.accepted && result.event_id === responses[0].event_id));
  const id = responses[0].event_id;
  assert.equal(await db.message.count({ where: { id } }), 1);
  const message = await db.message.findUniqueOrThrow({ where: { id }, include: { session: true } });
  assert.equal(message.session.sessionId, payload.sessionId);
  assert.equal(message.session.messageCount, 1);
  assert.equal(message.session.agentId, payload.agent_id);
  assert.ok(!JSON.stringify(message).includes("fixture-sensitive-value"));
  assert.ok(!JSON.stringify(message).includes("fixture-env-sensitive-value"));
  assert.ok(!JSON.stringify(message).includes("secret phrase"));
  assert.ok(!JSON.stringify(message).includes("fixture-connection-secret"));
  assert.ok(!JSON.stringify(message).includes("fixture-private-material"));
  for (const credential of credentialEchoes) assert.ok(!JSON.stringify(message).includes(credential));
  assert.ok(message.content.includes("[REDACTED]"));
  assert.equal(message.createdAt.toISOString(), payload.timestamp);

  if (process.env.RETAINDB_TEST_LOCAL_EMBEDDINGS === "true") {
    let status;
    for (let attempt = 0; attempt < 120; attempt++) {
      await drainNativeCaptures();
      status = await request(`/v1/agent-events/${id}`);
      if (status.status === "indexed") break;
      await delay(500);
    }
    assert.equal(status.status, "indexed", JSON.stringify(status));
    const chunks = await db.$queryRaw<Array<{ dimensions: number }>>`
      SELECT vector_dims(embedding) AS dimensions FROM chunks WHERE "documentId" = ${status.document_id}
    `;
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every(chunk => chunk.dimensions === 1024));
    const indexed = await db.document.findUniqueOrThrow({ where: { id: status.document_id } });
    const indexedChunks = await db.chunk.findMany({ where: { documentId: indexed.id } });
    for (const stored of [indexed, ...indexedChunks]) {
      assert.ok(!JSON.stringify(stored).includes("fixture-env-sensitive-value"));
      assert.ok(!JSON.stringify(stored).includes("fixture-connection-secret"));
      assert.ok(!JSON.stringify(stored).includes("fixture-private-material"));
      for (const credential of credentialEchoes) assert.ok(!JSON.stringify(stored).includes(credential));
    }
    const memoryText = "PostgreSQL recovery requires verified backup checksums before restoring partitions.";
    const storedMemory = await request("/v1/memory", {
      project: projectName, content: memoryText, memory_type: "factual", auto_detect: false,
      write_mode: "sync", scope_target: "PROJECT", confidence: 0.95, importance: 0.9,
    });
    assert.equal(storedMemory.success, true);
    const embeddingPath = "../src/engine/embeddings.js";
    const normalizationPath = "../src/lib/memory-normalization.js";
    const { embedSingle } = await import(embeddingPath);
    const { expandMemorySearchQueries } = await import(normalizationPath);
    const exactVector = await embedSingle(expandMemorySearchQueries(memoryText).join(" | ") || memoryText);
    await db.$executeRaw`UPDATE memories SET embedding = ${`[${exactVector.join(",")}]`}::vector WHERE id = ${storedMemory.memory_id}`;
    const memoryPack = await request("/v1/context/pack", {
      project: projectName, query: memoryText, include_company_brain: false, token_budget: 300,
    });
    assert.ok(memoryPack.context.includes("verified backup"));
    assert.equal(memoryPack.memories[0].id, storedMemory.memory_id);
    const cachedMemoryPack = await request("/v1/context/pack", {
      project: projectName, query: memoryText, include_company_brain: false, token_budget: 300,
    });
    assert.equal(cachedMemoryPack.context_hash, memoryPack.context_hash);
    const isolatedMemoryPack = await request("/v1/context/pack", {
      project: `${projectName}-isolated`, query: memoryText, include_company_brain: false, token_budget: 300,
    });
    assert.equal(isolatedMemoryPack.context, "");
    const pack = await request("/v1/context/pack", {
      project: projectName, query: "How can PostgreSQL be recovered from a backup safely?", include_memory: false, token_budget: 300,
      cwd: "/must/not/be/read", files: ["/must/not/be/read/secret"],
    });
    assert.ok(pack.context.includes("backup checksums"));
    assert.ok(pack.estimated_tokens <= 300);
    assert.deepEqual(pack.files_packed, []);
    assert.ok(pack.diagnostics.length > 0);
    const delta = await request("/v1/context/delta", {
      project: projectName, query: "How can PostgreSQL be recovered from a backup safely?", include_memory: false, token_budget: 300,
      previous_context_hash: pack.context_hash,
    });
    assert.equal(delta.unchanged, true);
    assert.equal(delta.delta_context, "");
    const secondProject = await request("/v1/context/pack", {
      project: `${projectName}-isolated`, query: "How can PostgreSQL be recovered from a backup safely?", include_memory: false, token_budget: 300,
      previous_context_hash: pack.context_hash,
    });
    assert.equal(secondProject.context, "");
    assert.notEqual(secondProject.context_hash, pack.context_hash);
    const otherProjectCapture = await request("/retaindb/observe", {
      ...payload, project: `${projectName}-isolated`, data: { prompt: "This separate project also needs independent native indexing." },
    });
    await drainNativeCaptures();
    assert.equal((await request(`/v1/agent-events/${otherProjectCapture.event_id}`)).status, "indexed");

    await db.$executeRaw`
      UPDATE messages SET metadata = (metadata - 'document_id') || jsonb_build_object(
        'native_capture_state', 'processing', 'claimed_at', NOW() - INTERVAL '20 minutes'
      ) WHERE id = ${id}
    `;
    await drainNativeCaptures();
    const recovered = await request(`/v1/agent-events/${id}`);
    assert.equal(recovered.status, "indexed");
    assert.equal(recovered.document_id, status.document_id);
    assert.equal(await db.document.count({ where: { externalId: id } }), 1);

    const constraint = `native_failure_${randomUUID().replaceAll("-", "")}`;
    const failureMarker = randomUUID();
    await db.$executeRawUnsafe(`ALTER TABLE chunks ADD CONSTRAINT "${constraint}" CHECK ((metadata->'data'->>'failure_fixture') IS DISTINCT FROM '${failureMarker}') NOT VALID`);
    let failedId: string;
    try {
      const accepted = await request("/retaindb/observe", {
        ...payload, data: { prompt: "Keep this recoverable PostgreSQL event until semantic indexing succeeds.", failure_fixture: failureMarker },
      });
      failedId = accepted.event_id;
      await drainNativeCaptures();
      const failed = await request(`/v1/agent-events/${failedId}`);
      assert.equal(failed.status, "pending");
      assert.ok(failed.last_error);
      assert.ok(failed.retry_at);
      assert.equal(await db.message.count({ where: { id: failedId } }), 1);
      // The receipt remains pending without a partially visible document.
      assert.equal(await db.document.count({ where: { externalId: failedId } }), 0);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE chunks DROP CONSTRAINT "${constraint}"`);
    }
    await db.$executeRaw`
      UPDATE messages SET metadata = metadata - 'retry_at' WHERE id = ${failedId!}
    `;
    await drainNativeCaptures();
    assert.equal((await request(`/v1/agent-events/${failedId!}`)).status, "indexed");
  }

  const event = await request("/v1/agent-events", {
    project: projectName, session_id: payload.sessionId, agent_id: "native-fixture-agent",
    event: { kind: "decision", summary: "Keep the verified backup until PostgreSQL recovery is complete.", timestamp: payload.timestamp },
  });
  assert.equal(event.accepted, true);
  assert.notEqual(event.event_id, id);
  const session = await db.session.findUniqueOrThrow({ where: { id: message.sessionId } });
  assert.equal(session.messageCount, process.env.RETAINDB_TEST_LOCAL_EMBEDDINGS === "true" ? 3 : 2);
});

after(async () => {
  if (databaseUrl) {
    const { drainNativeCaptures } = await import(capturePath);
    await drainNativeCaptures();
    const embeddingsPath = "../src/engine/native-embeddings.js";
    const { stopNativeEmbeddingProcess } = await import(embeddingsPath);
    await stopNativeEmbeddingProcess();
    await delay(100);
    const { db } = await import("../src/db/index.js");
    await db.project.deleteMany({ where: { name: { in: [projectName, `${projectName}-isolated`, `${projectName}-models`, `${projectName}-tools`] } } });
    await db.$disconnect();
    for (const key of ["DATABASE_URL", "ENCRYPTION_KEY", "RETAINDB_API_KEY", "EMBEDDING_MODE", "DISABLE_AUTO_EXTRACTION", "OPENAI_API_KEY"]) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
  }
});
