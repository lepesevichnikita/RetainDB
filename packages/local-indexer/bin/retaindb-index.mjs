#!/usr/bin/env node
/**
 * retaindb-index: index a repository where it lives, ship only content.
 *
 * The file system is read in this process, on the machine that owns the repository.
 * Only chunk text and repository-relative paths leave it. The server never resolves a
 * path, never reads a file and never receives an absolute path: it stores what is sent.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chunkSource } from "../src/chunker.mjs";

const MAX_BYTES = 256 * 1024;
const BATCH_ITEMS = 200;
const RETRIES = 3;
const MANIFEST_VERSION = 1;

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt",
  ".rb", ".php", ".cs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".sh",
  ".sql", ".proto", ".tf", ".yaml", ".yml", ".toml", ".md", ".vue", ".svelte",
]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".turbo", ".cache",
]);

const HELP = `retaindb-index: index a repository where it lives and ship chunks to RetainDB

Usage:
  retaindb-index --root <dir> --api <url> --key <key> [--project <name>] [--dry-run]

Options:
  --root      repository to index (default: current directory)
  --api       RetainDB base URL (default: $RETAINDB_BASE_URL)
  --key       API key (default: $RETAINDB_API_KEY)
  --project   project name or slug (default: $RETAINDB_PROJECT or "default")
  --dry-run   report what would be sent, post nothing
  --help      this text

Reads files here, posts POST /v1/learn/batch. Repository-relative paths only.`;

function manifestFile() {
  return join(homedir(), ".retaindb-mcp", "index-manifest.json");
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

function isCodeFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function gitTrackedFiles(root) {
  return new Promise((ok, fail) => {
    const args = ["-C", root, "ls-files", "-z"];
    const budget = { maxBuffer: 64 * 1024 * 1024 };
    execFile("git", args, budget, (error, stdout) => {
      if (error) return fail(error);
      return ok(stdout.split("\0").filter(Boolean));
    });
  });
}

async function walkFiles(root, dir = root, found = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(root, full, found);
    else if (entry.isFile()) found.push(relative(root, full));
  }
  return found;
}

async function listRepositoryFiles(root) {
  try {
    return await gitTrackedFiles(root);
  } catch {
    return await walkFiles(root);
  }
}

async function readTextFile(absolutePath) {
  const info = await stat(absolutePath);
  if (info.size > MAX_BYTES) return null;
  const bytes = await readFile(absolutePath);
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

async function collectItems(root, files, known) {
  const items = [];
  const accepted = [];
  for (const path of files) {
    if (!isCodeFile(path)) continue;
    const prepared = await chunksForFile(root, path);
    if (prepared === null) continue;
    if (known[path] === prepared.sha) continue;
    for (const chunk of prepared.chunks) items.push(toItem(path, prepared.sha, chunk));
    accepted.push({ path, sha: prepared.sha, chunks: prepared.chunks.length });
  }
  return { items, accepted };
}

async function pushAll(api, key, project, items) {
  let sent = 0;
  for (let index = 0; index < items.length; index += BATCH_ITEMS) {
    const batch = items.slice(index, index + BATCH_ITEMS);
    await withRetries(() => postBatch(api, key, project, batch));
    sent += batch.length;
  }
  return sent;
}

export async function run(options) {
  const root = resolve(options.root);
  const manifest = await loadManifest();
  const known = (manifest.roots[root] ??= {});
  const files = await listRepositoryFiles(root);
  const { items, accepted } = await collectItems(root, files, known);
  if (options.dryRun) return { root, files: files.length, items: items.length, sent: 0 };
  const sent = await pushAll(options.api, options.key, options.project, items);
  for (const entry of accepted) known[entry.path] = entry.sha;
  await saveManifest(manifest);
  return { root, files: files.length, items: items.length, sent, changed: accepted.length };
}

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

function parseOptions(argv, env) {
  const root = readFlag(argv, "root", process.cwd());
  const api = readFlag(argv, "api", env.RETAINDB_BASE_URL);
  const key = readFlag(argv, "key", env.RETAINDB_API_KEY);
  const project = readFlag(argv, "project", env.RETAINDB_PROJECT ?? "default");
  const dryRun = argv.includes("--dry-run");
  if (!dryRun && (!api || !key)) throw new Error("--api and --key are required (or RETAINDB_BASE_URL / RETAINDB_API_KEY)");
  return { root, api, key, project, dryRun };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) return process.stdout.write(`${HELP}\n`);
  const options = parseOptions(argv, process.env);
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
