#!/usr/bin/env node
/**
 * retaindb-index: index a repository where it lives, ship only content.
 *
 * The file system is read in this process, on the machine that owns the repository.
 * Only chunk text and repository-relative paths leave it. The server never resolves a
 * path, never reads a file and never receives an absolute path: it stores what is sent.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chunkSource } from "../src/chunker.mjs";
import { IndexQueue, drainQueue } from "../src/queue.mjs";
import { createEmbedder, resolveModel } from "../src/embedder.mjs";
import { referenceEdges } from "../src/references.mjs";
import { listFiles } from "../src/files.mjs";

const MAX_BYTES = 1024 * 1024;
const DEFAULT_BATCH = 200;
const DEFAULT_DELAY_MS = 200;
const EMBED_BATCH = 8;
const VECTOR_POST_SIZE = 16; // keeps one request well under the proxy body limit
const RETRIES = 3;
const MANIFEST_VERSION = 1;
const MAX_SYMBOLS_PER_FILE = 20;

const HELP = `retaindb-index: index a directory where it lives and ship chunks to RetainDB

Usage:
  retaindb-index --root <dir> --api <url> --key <key> [--project <name>] [--dry-run]

Options:
  --root      repository to index (default: current directory)
  --api       RetainDB base URL (default: $RETAINDB_BASE_URL)
  --key       API key (default: $RETAINDB_API_KEY)
  --project   project name or slug (default: $RETAINDB_PROJECT or "default")
  --dry-run   report what would be sent, post nothing
  --graph     also send the symbol graph to /v1/entities and /v1/relations
  --batch     chunks per request (default 200)
  --delay     pause between batches in ms (default 200)
  --embed     compute vectors here with @xenova/transformers, so the server only stores them
              optional value: model id (default Xenova/multilingual-e5-large, 1024 dimensions)
  --reembed   move the stored corpus to that model: fetch stale chunk text, embed here, post vectors
  --help      this text

Flags beat environment, environment beats ~/.retaindb-mcp/config.json
({"api": "...", "project": "...", "token": "..."}, chmod 600).

Reads files here, posts POST /v1/learn/batch. Repository-relative paths only.`;

function manifestFile() {
  return join(homedir(), ".retaindb-mcp", "index-manifest.json");
}

export function configFile() {
  return join(homedir(), ".retaindb-mcp", "config.json");
}

export async function loadConfig() {
  try {
    const raw = await readFile(configFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function loadManifest() {
  try {
    const raw = await readFile(manifestFile(), "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: MANIFEST_VERSION, roots: {} };
  }
}

async function saveManifest(manifest) {
  await mkdir(dirname(manifestFile()), { recursive: true });
  await writeFile(manifestFile(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readTextFile(absolutePath) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return null;
  }
  if (info.size > MAX_BYTES) return null;
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    return null;
  }
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function toItem(path, sha, chunk) {
  const identity = `${path}#${chunk.start_line}#${sha.slice(0, 12)}`;
  return {
    type: "text",
    title: `${path}:${chunk.start_line}-${chunk.end_line}`,
    content: chunk.content,
    custom_id: identity.slice(0, 100),
    metadata: {
      source: "retaindb-index",
      path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      symbol: chunk.symbol ?? null,
      sha,
    },
  };
}

async function postBatch(api, key, project, items) {
  const response = await fetch(`${api.replace(/\/$/, "")}/v1/learn/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ project, async: true, items }),
  });
  if (!response.ok) {
    throw new Error(`learn/batch ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json().catch(() => ({}));
}

async function getJson(api, key, path) {
  const response = await fetch(`${api.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function postJson(api, key, path, body) {
  const response = await fetch(`${api.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json().catch(() => ({}));
}

function graphRows(path, chunks, text, sha, knownFiles) {
  const symbols = [...new Set(chunks.map((chunk) => chunk.symbol).filter(Boolean))].slice(0, MAX_SYMBOLS_PER_FILE);
  const entity = (name, entityType, description) => ({
    key: `entity:${name}`,
    payload: { kind: "entity", body: { name, entity_type: entityType, description, metadata: { sha } } },
  });
  const relation = (from, fromType, to, toType, type) => ({
    key: `edge:${from}|${type}|${to}`,
    payload: { kind: "relation", body: { from_entity: from, from_type: fromType, to_entity: to, to_type: toType, relation_type: type } },
  });
  return [
    entity(path, "module", `${chunks.length} chunks`),
    ...symbols.map((name) => entity(`${path}#${name}`, "symbol", name)),
    ...symbols.map((name) => relation(`${path}#${name}`, "symbol", path, "module", "part_of")),
    ...referenceEdges(path, text, knownFiles).map((edge) => relation(edge.from, "module", edge.to, "module", edge.kind)),
  ];
}

function graphPayload(project, rows) {
  const entities = rows.filter((row) => row.kind === "entity").map((row) => row.body);
  const relations = rows.filter((row) => row.kind === "relation").map((row) => row.body);
  return { project, entities, relations };
}

function postGraphBatch(api, key, project, rows) {
  return postJson(api, key, "/v1/graph/batch", graphPayload(project, rows));
}

async function withRetries(attempt) {
  let lastError;
  for (let tryNo = 1; tryNo <= RETRIES; tryNo += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      await new Promise((wait) => setTimeout(wait, 500 * tryNo));
    }
  }
  throw lastError;
}

async function chunksForFile(root, path) {
  const text = await readTextFile(resolve(root, path));
  if (text === null) return null;
  const chunks = await chunkSource(text, extname(path).toLowerCase());
  return { sha: digest(text), chunks };
}

function queueFile(name) {
  return join(homedir(), ".retaindb-mcp", name);
}

async function enqueueFiles(root, files, known, chunks, symbols, withGraph) {
  const accepted = [];
  const knownFiles = new Set(files);
  for (const path of files) {
    const prepared = await chunksForFile(root, path);
    if (prepared === null) continue;
    if (known[path] === prepared.sha) continue;
    for (const chunk of prepared.chunks) {
      chunks.add(`${path}#${chunk.start_line}-${chunk.end_line}`, toItem(path, prepared.sha, chunk));
    }
    if (withGraph) {
      const text = await readTextFile(resolve(root, path));
      for (const row of graphRows(path, prepared.chunks, text ?? "", prepared.sha, knownFiles)) symbols.add(row.key, row.payload);
    }
    accepted.push({ path, sha: prepared.sha });
  }
  return accepted;
}

export async function run(options) {
  if (options.reembed) return reembedCorpus(options);
  const batch = options.batch ?? DEFAULT_BATCH;
  const delay = options.delay ?? DEFAULT_DELAY_MS;
  const root = resolve(options.root);
  const manifest = await loadManifest();
  const known = (manifest.roots[root] ??= {});
  const files = await listFiles(root);
  const chunks = await IndexQueue.open(queueFile("chunks.json"));
  const symbols = await IndexQueue.open(queueFile("graph.json"));
  const accepted = await enqueueFiles(root, files, known, chunks, symbols, options.graph);
  const pending = { chunks: chunks.size, graph: symbols.size };
  if (options.dryRun) return { root, files: files.length, items: chunks.size, sent: 0, pending };
  const embedLocal = options.embed ? await createEmbedder(options.embed) : null;
  const sent = await drainQueue(
    chunks,
    async (items) => {
      const payload = embedLocal ? await withVectors(items, embedLocal, options.embed) : items;
      return withRetries(() => postBatch(options.api, options.key, options.project, payload));
    },
    { groupSize: embedLocal ? Math.min(batch, EMBED_BATCH) : batch, concurrency: 1, delayMs: delay },
  );
  const graph = options.graph ? await drainGraph(options, symbols, delay) : null;
  for (const entry of accepted) known[entry.path] = entry.sha;
  await saveManifest(manifest);
  return { root, files: files.length, items: sent, sent, changed: accepted.length, graph, pending };
}

async function withVectors(items, embed, model) {
  const vectors = await embed(items.map((item) => item.content));
  return items.map((item, index) => ({ ...item, embedding: vectors[index], embedding_model: model }));
}

/**
 * Moves an existing corpus onto one model. The server hands out the text of chunks whose
 * vector came from another model; this machine embeds them and posts the vectors back, so the
 * service never runs the model and the corpus ends up in a single space.
 */
async function reembedCorpus(options) {
  const embed = await createEmbedder(options.embed);
  let updated = 0;
  for (;;) {
    const page = await getJson(
      options.api, options.key,
      `/v1/chunks/stale?model=${encodeURIComponent(options.embed)}&limit=${VECTOR_POST_SIZE}&project=${encodeURIComponent(options.project)}`,
    );
    if (!page.chunks?.length) return { model: options.embed, updated, remaining: 0 };
    const vectors = [];
    for (let i = 0; i < page.chunks.length; i += EMBED_BATCH) {
      const slice = page.chunks.slice(i, i + EMBED_BATCH);
      const embedded = await embed(slice.map((chunk) => chunk.content));
      slice.forEach((chunk, index) => vectors.push({ id: chunk.id, embedding: embedded[index] }));
    }
    let accepted = 0;
    for (let i = 0; i < vectors.length; i += VECTOR_POST_SIZE) {
      const result = await postJson(options.api, options.key, "/v1/chunks/vectors", {
        project: options.project, model: options.embed, vectors: vectors.slice(i, i + VECTOR_POST_SIZE),
      });
      accepted += Number(result.updated || 0);
    }
    updated += accepted;
    process.stderr.write(`[reembed] ${updated} updated, ${page.remaining} left\n`);
  }
}

async function drainGraph(options, symbols, delay) {
  const counts = { entities: 0, relations: 0 };
  await drainQueue(
    symbols,
    async (rows) => {
      const written = await withRetries(() => postGraphBatch(options.api, options.key, options.project, rows));
      counts.entities += written.entities ?? 0;
      counts.relations += written.relations ?? 0;
    },
    { groupSize: options.batch ?? DEFAULT_BATCH, concurrency: 1, delayMs: Math.max(delay, 50) },
  );
  return counts;
}

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

export function parseOptions(argv, env, config = {}) {
  const root = readFlag(argv, "root", process.cwd());
  const api = readFlag(argv, "api", env.RETAINDB_BASE_URL ?? config.api);
  const key = readFlag(argv, "key", env.RETAINDB_API_KEY ?? config.token);
  const project = readFlag(argv, "project", env.RETAINDB_PROJECT ?? config.project ?? "default");
  const dryRun = argv.includes("--dry-run");
  const graph = argv.includes("--graph");
  const batch = Number(readFlag(argv, "batch", DEFAULT_BATCH));
  const delay = Number(readFlag(argv, "delay", DEFAULT_DELAY_MS));
  const reembed = argv.includes("--reembed");
  const embedFlag = argv.includes("--embed") || reembed;
  const embedNext = embedFlag ? argv[argv.indexOf("--embed") + 1] : undefined;
  const embed = embedFlag ? resolveModel(embedNext && !embedNext.startsWith("--") ? embedNext : true) : "";
  if (!dryRun && (!api || !key)) throw new Error("no API target: pass --api/--key, set RETAINDB_BASE_URL/RETAINDB_API_KEY, or write ~/.retaindb-mcp/config.json");
  return { root, api, key, project, dryRun, graph, batch, delay, embed, reembed };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) return process.stdout.write(`${HELP}\n`);
  const options = parseOptions(argv, process.env, await loadConfig());
  const report = await run(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";

if (import.meta.url === entry) {
  main().catch((error) => {
    process.stderr.write(`retaindb-index: ${error.message}\n`);
    process.exitCode = 1;
  });
}
