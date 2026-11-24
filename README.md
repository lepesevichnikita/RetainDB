<p align="center">
  <img src="https://retaindb.com/retaindb-mark.svg" alt="RetainDB" height="64" />
</p>

<h1 align="center">RetainDB</h1>

<p align="center">
  Memory infrastructure for AI agents, from local coding-agent recall to hosted product memory.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@retaindb/sdk"><img src="https://img.shields.io/npm/v/@retaindb/sdk?label=%40retaindb%2Fsdk" alt="@retaindb/sdk on npm" /></a>
  <a href="https://www.npmjs.com/package/@retaindb/mcp"><img src="https://img.shields.io/npm/v/@retaindb/mcp?label=%40retaindb%2Fmcp" alt="@retaindb/mcp on npm" /></a>
  <img src="https://img.shields.io/badge/local-first-success" alt="Local first" />
  <img src="https://img.shields.io/badge/license-Apache%202.0%20%2F%20BSL%201.1-blue" alt="License" />
</p>

RetainDB gives agents durable memory: decisions, preferences, workflows, corrections, project facts, and session handoffs that survive across conversations.

It ships as two related products:

- **RetainDB Local**: persistent memory for coding agents. Runs on your machine, no cloud account required.
- **RetainDB Server / Cloud**: memory API infrastructure for apps, teams, SDKs, auth, connectors, dashboards, and managed deployments.

## Why RetainDB

Agents are most useful when they remember the right things and forget the noise. RetainDB is built around memory quality, not just vector storage:

- **Capture** prompts, tool events, file edits, failures, session summaries, and explicit memories.
- **Filter** low-signal noise before it pollutes recall.
- **Structure** memories into semantic facts, procedures, corrections, preferences, and events.
- **Retrieve** with lexical search, vector similarity, graph signals, RRF fusion, and reranking.
- **Reinforce** memories that get reused, so important knowledge gets stronger over time.
- **Handoff** context between sessions, agents, and workflows.
- **Route** normal coding context so agents stop rereading whole files, logs, and sessions every turn.
- **Compress** repeated context with deltas, hard token budgets, and tool-output cleanup.

## Quick Start

### RetainDB Local

Start local memory in one command:

```bash
npx -y @retaindb/local
```

RetainDB Local starts an API on `http://localhost:3111` and a viewer on `http://localhost:3113`.

Or use docker compose to run RetainDB in container:

```bash
git clone https://github.com/retaindb/retaindb
```

Set the correct directory path for `RETAINDB_HOME` map in `docker-compose-local.yml`.
Run docker compose:

```bash
cd retaindb
docker compose -f docker-compose-local.yml up -d
```
To see the container logs:

```bash
docker compose -f docker-compose-local.yml logs -f -n 10
```

RetainDB Local inside container starts an API on `http://localhost:3111` and a viewer on `http://localhost:3113`.

Run the demo:

```bash
npx -y @retaindb/local demo
```

Wire local memory into Codex, Claude Code, and OpenCode:

```bash
npx -y @retaindb/local connect all
```

Run the MCP bridge:

```bash
RETAINDB_BASE_URL=http://localhost:3111 npx -y @retaindb/local mcp
```

Local mode uses an atomic disk snapshot plus append-only journal under `~/.retaindb/`. It does not require Postgres, Redis, Kafka, Qdrant, Cloudflare, or API keys.

### Self-Hosted Server

Use this path when you want the full API server with Postgres and pgvector.

```bash
git clone https://github.com/retaindb/retaindb
cd retaindb
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
docker compose up
```

Server runs on `http://localhost:3000`.

Keep `ENCRYPTION_KEY` stable across restarts so stored agent credentials remain readable. Local BGE embeddings do not require an OpenAI key; the first request downloads the model. Explicit `EMBEDDING_MODE=local` keeps all batches local, including large documents. Set `EMBEDDING_MODE=openai` and `OPENAI_API_KEY` to use OpenAI embeddings instead; hybrid mode switches large batches to OpenAI. LLM extraction and research still require an OpenAI key.

Local inference prefers the native CPU backend. If model construction falls back to WebAssembly, the Server uses a single WASM thread because Node cannot start the browser Blob workers used by the pinned ONNX runtime. This does not limit native CPU inference threads or switch embedding providers.

Use pgvector 0.8 or later for filtered HNSW retrieval. Document and memory vector searches enable strict iterative scans inside their own transaction so project, source, type and metadata filters can continue past unrelated neighbors without changing pooled connection settings. Approximate search still has pgvector's scan limits. Compose supplies pgvector; an existing PostgreSQL installation must upgrade its extension separately.

Database upgrades preserve existing organization IDs, ownership and slugs. If another organization already uses the `default` slug, the ownerless default organization receives an available `default-oss-N` slug instead. Previously deployed migration files remain unchanged.

To verify the packaged Prisma client and migration CLI without network access or a running database:

```bash
docker build -t retaindb-runtime-check -f packages/server/Dockerfile .
node scripts/check-server-image.mjs retaindb-runtime-check
```

### Node + Postgres

```bash
git clone https://github.com/retaindb/retaindb
cd retaindb
cp .env.example packages/server/.env
pnpm install
pnpm --filter @retaindb/server run db:generate
pnpm --filter @retaindb/server exec prisma migrate deploy
pnpm dev:server
```

Postgres must have the `pgvector` extension enabled.

Set a stable `ENCRYPTION_KEY` in `packages/server/.env` before starting the server. Apply the committed migrations with `prisma migrate deploy`; do not replace an existing database with the generated Prisma schema. The migration history also contains legacy tables not managed by the current server client.

Concurrent synchronous text learns reuse one ingestion source per project.
Source-version allocation is serialized in PostgreSQL for each source, so
first writes and staged syncs do not race to allocate the same version number.
Retained version-number gaps are preserved rather than reused.

Batch ingestion binds source versions before submitting queued work. A failed
batch waits for its submitted tasks to settle before returning an error, so
connector failure handling cannot race later writes from that batch. Documents
remain `PROCESSING` during a rebuild and become `READY` after chunk persistence.
A required embedding or persistence failure records `ERROR` with the failure
message as `parseError`; a successful retry clears the previous `parseError`.
An empty, wrong-width or missing embedding fails that document instead of
publishing a searchable chunk the store cannot answer.

### Coding-agent hooks with PostgreSQL

The Server accepts the native Local hooks at `POST /retaindb/observe` and
`POST /v1/agent-events`. Point `RETAINDB_BASE_URL` at the Server and set
`RETAINDB_API_KEY` for both the hook process and Server. Keep the existing
project and session identifiers in the hook payload.

The bundled plugin hooks and `retaindb hook` use the same client config for
the API URL, credentials and project. They resolve the project from
`RETAINDB_PROJECT`, the client config's `project`, the hook payload's project,
then its working directory. Plugin capture and session lifecycle requests
use that same project and send the configured API key on every request.

For workstation-side capture, set `RETAINDB_HOOK_EMBEDDING_MODE=workstation`
(or `hook_embedding_mode` in the client config). `local` also selects the
workstation. `server` is the default when unset; invalid values stop hook
requests rather than falling back to the server. The hook computes a vector
for a short event summary with the cached Transformers.js model selected by
`RETAINDB_HOOK_EMBEDDING_MODEL` / `hook_embedding_model`. Use the same
1024-dimensional model as the Server's semantic search. Context search only
ranks labelled chunk vectors against a query from the same model. Chunks from
other models remain available to text search; older unlabelled chunks retain
their existing behavior until re-embedded. The hook redacts recognized
credentials and their echoes in event content before embedding or sending it.
A short excerpt of tool output is searchable, rather than just the tool name.
The Server commits the receipt and searchable summary together at
`/v1/agent-events/workstation`.
This mode does not download a model, request automatic context, or fall back
to server-side inference. Missing models and rejected submissions are reported
on the hook's stderr; the agent session continues.

A successful capture returns HTTP 202 only after the event is committed to
PostgreSQL. In `server` mode this acknowledges the event, not the embedding.
The Server indexes in the background with its configured provider and commits
the searchable document and indexed status together. A failed indexing attempt
leaves the receipt retryable without exposing a partial document. Pending events
resume after restart. Repeating the same event payload reuses
its receipt. `GET /v1/agent-events/:eventId` reports `pending`, `processing`
or `indexed`, including retry diagnostics when embedding fails. Recognized
credentials, connection-URL user information and complete private-key blocks
are redacted before captured data is persisted. Redaction is not a substitute
for keeping unrelated secrets out of captured tool output.

With `EMBEDDING_MODE=local`, native capture and retrieval share one model
session and run one embedding at a time. A timed-out capture does not write a
late result or start duplicate inference; an active ONNX call keeps its slot
until it returns. Other embedding modes keep the reusable, isolated child
process with kill-and-wait recovery. Both paths honor the capture attempt
deadline (120 seconds by default; `NATIVE_CAPTURE_EMBEDDING_TIMEOUT_MS` can
lower it). Retry delays start when the failure is recorded. Receipt and
document writes remain in the Server under exclusive database row ownership.

Set `RERANK_MODE=off` on the server to skip optional model-based reranking,
even for clients that request it. Search keeps its existing vector and lexical
ranking, including local embeddings when `EMBEDDING_MODE=local`.

The vector-index migration replaces the initially empty IVFFlat indexes
with HNSW indexes. HNSW does not require training data, so retrieval can
work immediately after the first import without rebuilding an index.

The Server also supports `POST /v1/context/pack`, `POST /v1/context/delta`
and `POST /v1/context/compress-output` without a cloud model. Context packs
combine indexed documents and memories within the requested project and
token budget. An unchanged context hash returns an empty delta, which CLI and
plugin hooks preserve rather than replacing it with the previous full context. Client `cwd`
and `files` paths are diagnosed, not read from the Server filesystem; ingest
those files through the source APIs first.

To exercise the packaged Server, migrations, vectors, hook receipts,
authentication and restart recovery in a disposable Compose project, run
`node scripts/check-server-compose.mjs`. The script removes only its own
containers, image and database volume when it finishes.

## RetainDB Local

RetainDB Local is an agent-native memory runtime for coding workflows.

What it includes:

- One-process local runtime on `:3111`
- Built-in viewer on `:3113`
- MCP tools for `context`, `remember`, `recall`, `handoff`, `session_history`, and `forget`
- Auto-capture hooks for coding-agent lifecycle events
- Codex, Claude Code, and OpenCode setup snippets
- Session replay API and step-through replay viewer
- Clickable concept graph
- BM25 + vector + graph retrieval with RRF and reranking
- Low-signal capture filtering
- Semantic, procedural, correction, and summary memory typing
- Recall reinforcement with access counts, last-access timestamps, and memory strength
- Consolidation with duplicate cleanup, session rollups, and stale weak-memory decay
- Optional local transformer embeddings
- Local benchmark reports in `~/.retaindb/benchmarks/`
- Token-budgeted context packs for files, memory, code maps, and tool output
- Delta compression so agents receive only what changed since the last context pack
- Tool-output compression that keeps errors, failing tests, and stack traces while dropping noise
- Code maps that show relevant files and symbols without dumping the whole repo

Useful commands:

```bash
retaindb                  # start local memory
retaindb demo             # seed and search demo memories
retaindb benchmark        # run recall/latency benchmark
retaindb connect all      # write agent config snippets
retaindb connect all --install
retaindb import-jsonl     # import Claude-style JSONL transcripts
retaindb consolidate      # dedupe and roll up memories
retaindb reembed          # refresh embeddings
retaindb doctor           # print local status
```

Optional local transformer embeddings:

```bash
retaindb install-embeddings
RETAINDB_EMBEDDING_PROVIDER=local-transformers retaindb reembed
```

If the local native embedding runtime is unavailable, RetainDB falls back to hash-vector embeddings so local memory keeps working.

### Context Router and Token Reduction

RetainDB Local can also act as a local context router for coding agents. Instead of sending huge files, repeated terminal logs, or the same project summary every turn, agents can ask RetainDB for a compact context pack.

```bash
curl -X POST http://localhost:3111/v1/context/pack \
  -H "Content-Type: application/json" \
  -d '{
    "query": "fix auth middleware tests",
    "cwd": ".",
    "files": ["src/auth.ts", "tests/auth.test.ts"],
    "token_budget": 1200
  }'
```

The response includes:

- `context`: packed memory, relevant file chunks, code map, and compressed tool output
- `context_hash`: stable hash for the pack
- `delta_context`: only the changed parts when `previous_context_hash` is supplied
- `estimated_tokens` and `estimated_delta_tokens`
- `changed` and `removed` entries for delta-aware agents

Useful endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/context/pack` | Build a token-budgeted context pack |
| `POST` | `/v1/context/delta` | Return only context changes since a previous pack |
| `POST` | `/v1/context/compress-output` | Compress test/build/tool output |
| `POST` | `/v1/context/code-map` | Build a compact file and symbol map |

MCP tools expose the same flow as `context_pack`, `context_delta`, `compress_output`, and `code_map`.

## Platform Features

RetainDB Server and Cloud are the API/product infrastructure layer around the same memory model.

Core platform features:

- **Structured memory extraction** from conversations, sessions, and explicit writes
- **Semantic search + BM25 + reranking** for context retrieval
- **Memory graph** with relationships like `updates`, `contradicts`, `supports`, `extends`, and `derives`
- **Temporal validity** with `validFrom` and `validUntil` so stale facts can be superseded instead of silently reused
- **Versioned memories** for corrections and evolving user/project state
- **Project and user scoping** for multi-agent and product use cases
- **Connectors** for GitHub, docs sites, PDFs, Notion, Confluence, Slack, Discord, package docs, and more
- **Framework adapters** for Vercel AI SDK, LangChain, and LangGraph
- **MCP server** for agent clients that speak tools
- **Self-hosted Postgres + pgvector path** for teams that want to own the stack
- **Cloud track** for hosted auth, dashboards, SDK defaults, lifecycle email, usage controls, and managed reliability

RetainDB Local optimizes for coding-agent memory on one machine. RetainDB Server and Cloud optimize for product memory across users, apps, teams, and integrations.

## SDK

```bash
npm install @retaindb/sdk
```

### Local

```ts
import { RetainDBContext } from "@retaindb/sdk";

const db = new RetainDBContext({
  baseUrl: "http://localhost:3111",
  project: "my-agent",
});
```

### Cloud or Self-Hosted API

```ts
import { RetainDBContext } from "@retaindb/sdk";

const db = new RetainDBContext({
  apiKey: process.env.RETAINDB_API_KEY,
  baseUrl: "https://api.retaindb.com",
  project: "my-agent",
});
```

Store a memory:

```ts
await db.addMemory({
  project: "my-agent",
  user_id: "user_123",
  memory_type: "preference",
  content: "User prefers concise answers with concrete next steps.",
});
```

Retrieve context before an LLM call:

```ts
const { context, memories } = await db.query({
  project: "my-agent",
  user_id: "user_123",
  query: "What should I remember about this user?",
  include_memories: true,
});
```

Ingest a session:

```ts
await db.ingestSession({
  project: "my-agent",
  session_id: "session_abc",
  user_id: "user_123",
  messages: [
    { role: "user", content: "I'm building a SaaS in Next.js, Prisma, and Postgres." },
    { role: "assistant", content: "Got it. I will remember that stack." },
  ],
});
```

### Vercel AI SDK

```ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { RetainDBContext } from "@retaindb/sdk";

const db = new RetainDBContext({
  apiKey: process.env.RETAINDB_API_KEY,
  baseUrl: process.env.RETAINDB_BASE_URL,
  project: "my-agent",
});

const { context } = await db.query({
  user_id,
  query: userMessage,
  include_memories: true,
});

const result = await streamText({
  model: openai("gpt-4o"),
  system: `You are a helpful assistant.\n\nRelevant memory:\n${context}`,
  messages,
});
```

### LangChain and LangGraph

RetainDB also ships adapters for LangChain and LangGraph workflows, so memory can be retrieved before a chain/graph step and written back after the agent learns something useful.

## Installing the local tools

Three tools, one configuration file. Write it once:

```json
{ "api": "https://retaindb-api.example.lan", "token": "<api key>", "project": "my-agent" }
```

at `~/.retaindb-mcp/config.json`. Every tool below reads it; environment variables
(`RETAINDB_BASE_URL`, `RETAINDB_API_KEY`, `RETAINDB_PROJECT`, `RETAINDB_CONFIG`) override it.

**1. Indexer CLI** — reads files on this machine and ships chunks and vectors:

```bash
git clone https://github.com/lepesevichnikita/RetainDB.git && cd RetainDB
npm i -g --install-links ./packages/local-indexer
retaindb-index --root ~/src/my-project --graph --embed
```

**2. MCP server** — exposes recall/remember/context to the agent:

```bash
npx -y @retaindb/local mcp        # configuration comes from ~/.retaindb-mcp/config.json
```

```json
{
  "mcpServers": {
    "retaindb": { "command": "npx", "args": ["-y", "@retaindb/local", "mcp"] }
  }
}
```

**3. Coding-agent hooks** — capture prompts, tool calls and session ends:

```bash
ls packages/local/plugin/hooks/hooks.json        # Claude Code
ls packages/local/plugin/hooks/hooks.codex.json  # Codex
```

Point the harness at the matching file; each hook script resolves the same config file, so a
machine configured once needs no per-hook environment. `RETAINDB_AUTO_CONTEXT=false` turns off
context injection, `RETAINDB_COMPRESS_TOOL_OUTPUT=false` turns off tool-output compression.

Verify a consumer end to end:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.retaindb-mcp/config.json')))['api'])")/health"
```

Core tools:

| Tool | Purpose |
| --- | --- |
| `context` | Retrieve packed context for the current task |
| `remember` | Save a durable memory |
| `recall` | Search memory |
| `handoff` | Share session context |
| `session_history` | Inspect prior session memory |
| `forget` | Delete or deactivate memory |

## REST API

Local runs on `:3111`. The self-hosted server runs on `:3000` by default.

If `RETAINDB_API_KEY` is set, protected deployments require `Authorization: Bearer <RETAINDB_API_KEY>`. Local development can run without a key.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/memory` | Store a memory |
| `POST` | `/v1/memory/bulk` | Store multiple memories |
| `POST` | `/v1/memory/search` | Search memories |
| `POST` | `/v1/context/query` | Retrieve packed context |
| `POST` | `/v1/context/pack` | Build a token-budgeted coding context pack |
| `POST` | `/v1/context/delta` | Return changed context since a prior pack |
| `POST` | `/v1/context/compress-output` | Compress noisy tool output |
| `POST` | `/v1/context/code-map` | Return relevant files and symbols |
| `POST` | `/v1/memory/ingest/session` | Ingest messages and work events |
| `GET` | `/v1/memory/session/:sessionId` | List session memories |
| `GET` | `/v1/memory/profile/:userId` | List profile memories |
| `DELETE` | `/v1/memory/:id` | Delete or deactivate memory |
| `GET` | `/v1/projects` | List projects |
| `POST` | `/v1/projects/:id/sources` | Connect a knowledge source |
| `GET` | `/v1/projects/:id/sources` | List project sources |
| `POST` | `/v1/sources/:id/sync` | Trigger source sync |
| `GET` | `/v1/sources/:id` | Inspect source status |

Server graph endpoints:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/entities` | Create or update a project entity without a separate inference request |
| `POST` | `/v1/relations` | Create or update an edge between project entities |
| `POST` | `/v1/graph/search` | Find up to `top_k` visible name or vector matches and follow up to 50 edges per hop in both directions, for 1–3 hops; traversal-only entities have score `0` |
| `GET` | `/v1/memory/graph` | Return memory nodes, stored relationships, and chronological session edges |
| `GET` | `/v1/memory/graph/conversation/:sessionId` | Read the same memory graph for one conversation |

In `/v1/context/query`, `include_graph: true` adds chunks linked by the entity graph and preserves the matched entities and relationships in each result's `metadata.graph`, even if vector or lexical search found the same chunk. `graph_depth` accepts 1–3. Graph queries bypass the response cache and respect project, source, chunk-type, metadata, and active-version filters.

An answer produced while the embedder is unavailable is reported as partial: `meta.timing.embedding_unavailable` marks the vector half that was skipped, and `meta.timing.memory_skipped` marks memories that were asked for and never searched. Such an answer is not written to the response cache, so the next identical question is recomputed instead of being served a partial result as complete, and it comes back complete as soon as the embedder does.

Entity and edge IDs are stable within the project. Extraction records claims per source chunk, so staged, failed, superseded, and deleted content does not replace the active graph. Graph search, export, and entity counts use the same visibility rule. Manually written entities and edges remain independent of source versions; extraction does not replace their annotations.

Graph search and graph-assisted context do not compare vectors labelled with another embedding model. Entity name matches in graph search and traversal of visible edges do not depend on vector compatibility. Legacy unlabelled vectors remain eligible.

Omit `project` on `/v1/context/query` or `/v1/graph/search` to search visible knowledge across the authenticated organization. Document hits and graph entities include their source project as `project`; context responses also report `meta.project_scope`. Pass a project name, slug, or ID to narrow the query. An unknown or inaccessible project returns `404` without creating a project or widening the search. Context queries with `include_memories: true` still require a project: shared knowledge search does not search personal memories in other projects.

Use `tags: ["project:mp", "machine:mac-mini"]` on `/v1/context/query` or the workspace MCP `search` to require every listed tag before ranking. Omit both `tags` and `project` for organization-wide search. Hits return the effective tags in `metadata.tags`. RetainDB derives `project:<slug>` from the owning project, so a caller-supplied project tag cannot mislabel a record. Other tags come from indexed metadata. On a workstation, set `RETAINDB_MACHINE` or `machine` in the shared hook config to add `machine:<label>` to future captures in either embedding mode. Machine labels are optional; older records are not guessed or rewritten.

Requests with `include_memories: true` or nonempty `tags` bypass the shared response cache even when `use_cache` is set. `tags` filters indexed knowledge, not personal memories; do not combine it with `include_memories: true`.

The API echoes accepted filters in `meta.applied_tags`. The workspace MCP rejects tagged searches against older backends that do not confirm the filter, rather than presenting unfiltered results as matches.

The TypeScript SDK uses an explicit project or a project configured on the client, if present. The in-repository `@retaindb/mcp` tool `search` uses shared knowledge unless its call supplies `project`; the write-project setting does not narrow it. Project labels are retained in its results. An API failure is an MCP error, not an empty successful search. The separately published `@retaindb/mcp-server` is a different package and is not updated by building this workspace.

The cluster RetainDB integration uses the pinned `@retaindb/mcp-server@2.17.0` with the [compatibility patch](packages/mcp/patches/retaindb-mcp-server@2.17.0.patch) to retain its existing MCP tool catalog. Use `retaindb:search` through MCPProxy with `search_all: true` for shared knowledge or `tags` for all-of exact filters. Omit `project` for organization-wide tagged search; pass it to narrow tagged search. These modes require `query` and do not combine with memory lookup or graph expansion. Existing search calls without either option keep their original scope and behavior.

Semantic graph search uses the stored vector of the visible source chunk, with a legacy mention vector as a fallback when the chunk has none. A structural entity with neither remains searchable by name on `/v1/graph/search`.

Entity extraction runs only on eligible documents ingested with automatic extraction enabled and a configured inference provider. Native hook capture skips it. The migration preserves existing graph rows and backfills explicit legacy entity-to-chunk links. Old automatic edges without recorded provenance stay hidden until extraction confirms them. The migration does not extract from existing documents, and importing vector embeddings alone does not create graph edges.

Local-only runtime endpoints:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/retaindb/health` | Local health |
| `GET` | `/retaindb/snapshot` | Viewer snapshot |
| `GET` | `/retaindb/graph` | Concept graph |
| `GET` | `/retaindb/replay/:sessionId` | Replay session events |
| `POST` | `/retaindb/observe` | Hook capture endpoint |
| `POST` | `/retaindb/consolidate` | Run consolidation |

## Memory Model

RetainDB stores more than raw snippets. A memory can represent:

```ts
type MemoryType =
  | "factual"
  | "preference"
  | "semantic"
  | "procedural"
  | "decision"
  | "constraint"
  | "instruction"
  | "goal"
  | "event"
  | "correction"
  | "session_summary"
  | "project_state";

type RelationType =
  | "updates"
  | "extends"
  | "contradicts"
  | "supports"
  | "derives";
```

Memories include confidence, importance, metadata, session and user scope, timestamps, and optional embeddings. Server and cloud deployments also support relationship and temporal metadata for richer memory graphs.

Examples:

- `preference`: "User prefers concise responses with concrete next steps."
- `decision`: "The project standardizes on Postgres and pgvector for self-hosted search."
- `constraint`: "Local mode must work without cloud API keys."
- `correction`: "The old webhook path is deprecated; use `/v1/agent-events`."
- `procedural`: "Before release, run typecheck, build, benchmark, and smoke replay."

## Connectors

The self-hosted server can index external knowledge sources into agent context:

| Connector | Type |
| --- | --- |
| GitHub | Repos, code, issues |
| Web / Sitemap | Docs sites and pages |
| PDF | Local or remote documents |
| Notion | Pages and databases |
| Confluence | Spaces and pages |
| Slack | Channel history |
| Discord | Server history |
| arXiv | Papers |
| npm / PyPI | Package docs |
| HuggingFace | Model cards |
| Plain text | Inline content |

## Repository indexer and client-side vectors

`retaindb-index` walks a directory, chunks every text file, and ships the chunks to a self-hosted
server. It is a separate package on purpose: the service stores what it is given, the machine that
holds the files does the reading.

`--install-links` matters: without it npm links the global command to the checkout, so moving or
deleting `~/Documents/projects/RetainDB` breaks `retaindb-index` everywhere. With it npm installs a
real copy of the package and the command survives the checkout.

The file set is what git says it is: `git ls-files --cached --others --exclude-standard` inside the
target. `.gitignore` therefore decides — `node_modules`, vendored code, build output and everything
your global excludes skip are not indexed, and a tracked file under an ignored path still is. A
directory outside a git work tree falls back to skipping the usual dependency and build stores
(`node_modules`, `.venv`, `__pycache__`, `.next`, `coverage`, …).

```bash
git clone https://github.com/lepesevichnikita/RetainDB.git
cd RetainDB
npm i -g --install-links ./packages/local-indexer   # provides the `retaindb-index` command
```

Configure once, in the same file the MCP server and the hooks read:

```json
{ "api": "https://retaindb-api.example.lan", "token": "<api key>", "project": "default" }
```

`~/.retaindb-mcp/config.json`. Environment variables win over it: `RETAINDB_BASE_URL`,
`RETAINDB_API_KEY`, `RETAINDB_PROJECT`.

A machine that already runs the RetainDB MCP server needs no extra configuration: the indexer reads
the server entry in `~/.claude.json` (or the Claude Desktop config) and takes the base URL, key and
project from its `env`. Ask for the key once in the client, and both tools use it.

```bash
retaindb-index --root . --graph           # index, and write module/reference edges
retaindb-index --root . --embed           # compute the vectors here, not on the server
retaindb-index --root . --embed custom/model-id   # any 1024-dimension model
retaindb-index --reembed                  # move the stored corpus onto the current model
retaindb-index --root . --dry-run         # show what would be sent
```

**Vectors.** `--embed` runs `@xenova/transformers` locally; the default model is
`Xenova/multilingual-e5-large`, because a vector is a vector and the model must embed every
language of the corpus into one space, not only English. The chunk row records the producing
model in `metadata.embedding_model`, so which model made a vector is data, not a schema change:
a new model needs no migration and no extra column.

Existing corpora move with `--reembed`: the server hands out the text of chunks whose vector came
from another model (`GET /v1/chunks/stale`), this machine embeds them, and posts the vectors back
(`POST /v1/chunks/vectors`) in batches of 16, which stays under the proxy body limit. The service
itself never loads a model in that path.

**References become graph edges.** Markdown links and images, `[[wiki links]]`, HTML `href`/`src`,
`import`/`require`/`export from`, and `#include` are extracted from each file and resolved against
the set of indexed files (extensions, `index.*`, relative traversal). An edge is written only when
both ends are real files; an unresolved target is dropped instead of stored as a name nobody can
open, and a self reference never becomes an edge. That is the chain: a README points at a document,
which points at code, and search can walk it.

**One chunk in, one vector out.** An item that carries an `embedding` must be exactly one chunk.
The server refuses anything that would split, with
`client embedding covers one chunk, this item split into N: send one chunk per item` — a vector
cannot honestly represent several chunks.

## Self-hosted dashboard

The dashboard opens on **All projects**. Overview, graph and vector map can
browse shared knowledge in the configured organization; use the project selector
to filter. Graph and vector inspectors and queue rows show the original project.
The graph also shows tag nodes linked to the visible documents carrying each
tag. The initial graph draws tags from a bounded sample of the most recent
visible chunks. Select a node to see its exact search tag and displayed links.
The graph shows a neighborhood, not all matches; use tag-filtered search for retrieval.
For API navigation, query the exact tag with `entity_types: ["knowledge_tag"]` at
`/v1/graph/search`. Tag nodes are derived from live records, with no rebuild or
separate tag index required.
This view does not move data or change machine API search scope.
The dashboard identifies members of Authelia's `admins` group as administrators.
It checks this group in Authelia's authorization response for the actual route
and request method, not in headers sent by the browser. Other signed-in viewers
retain read-only access.

Administrators can select one project or **All projects**, then choose **Rebuild
knowledge** in Overview or **Rebuild graph** in Knowledge graph. Knowledge repair
uses the configured server embedder for missing chunk vectors only; it does not
re-embed or relabel existing vectors, including workstation-generated ones.
Graph rebuild runs extraction on the selected scope's visible, indexed chunks
and merges the derived mentions only when the entire job can publish. A model
can omit facts even in a successful response, so omissions do not remove
existing mentions. Incomplete or refused responses fail the job in **Queue**
without changing the serving graph.
Manual entities and relations are preserved. This action sends eligible chunk
text to the configured extraction provider and requires `OPENAI_BASE_URL`,
`OPENAI_API_KEY`, and `EXTRACTION_MODEL`; it does not enable automatic extraction
during ingestion. Neither rebuild deletes source documents or memories.

Each operation queues one persisted job; only one rebuild can be active in the
organization. **Queue** shows the selected scope, chunks prepared, and failure
details. Prepared vectors and graph claims stay private to the job across
worker restarts. The last step rechecks the indexed inputs and publishes all
changes in one transaction. If an input changed or publication fails, none of
the rebuild's changes become visible. No rebuild runs just because you open or
refresh the dashboard, or deploy an update.

Use **Overview** to see indexed documents, searchable chunks, sources, active
memories, visible entities, and how many chunks have a stored embedding.
Chunk, document, source and embedding statistics (including the Vector map's
model list) are refreshed in the background about every five minutes while the
dashboard is enabled. **Counts as of** shows when the last successful statistics
refresh took its snapshot. If a refresh fails, the last counts and timestamp
remain visible until the next successful refresh. The Refresh button rereads
the latest counts; it does not scan the corpus or rebuild embeddings.
Publication and authorization are checked live, so withdrawn documents do not
wait for the next count refresh.
Memory and entity counts and the plotted vector sample are read live.
You can open a model as soon as it has visible vectors; its count may not be
available until the next statistics refresh.

Use **Knowledge graph** to browse stored entities and one hop of relations, or search
for an entity by name. **Vector map** plots up to 200 recent, nonzero chunk
embeddings from one recorded model. The axes show cosine similarity to two
stored examples, not full-vector distance between points. Unlabelled vectors
count toward coverage but are not plotted with known models. Normal document
ingestion and repository publication record the model that generated each new
vector when the provider identifies it. Existing vectors are not relabelled.
The inspector shows the document title and chunk number. If a bookmarked model
is no longer present, use **Show available models**.

**Queue** shows persisted ingestion jobs, source syncs, repository index
generations, and native capture jobs across all authorized projects or for the
selected project. Counts cover all matching jobs; the table shows up to 50 with
active jobs first. Repository
attempts that cannot publish are marked blocked or superseded, not active. The
table does not show jobs queued only on another device. **Logs** shows up to 200
recent `/v1/` request outcomes for this server process, with the handling route's
template, status and duration. It is not a container log archive, and it clears
on process restart.
The **Refresh** button reads current data again without starting work. If the
server returns an error, the dashboard can keep the last result for that same
view and mark it as **Previous result**; changing scope or losing access clears it.

The dashboard is off by default. On the home cluster, enable it on the RetainDB
server in `terraform/stack/retaindb.tf` with the existing Authelia ingress:

```dotenv
RETAINDB_DASHBOARD_ORIGIN=https://retaindb.home.lan
RETAINDB_DASHBOARD_AUTH_URL=https://auth.home.lan/api/authz/forward-auth
```

Set `RETAINDB_DASHBOARD_SESSION_COOKIE` only if the Authelia cookie name differs
from `authelia_session`. Keep TLS verification enabled and use the existing
`NODE_EXTRA_CA_CERTS` bundle for the internal CA. The backend checks the browser
session with Authelia; it does not trust incoming identity headers or give the
browser the API key. The dashboard reads the OSS `default` organization only.
Apply the release's Prisma migrations before starting an upgraded server. The
dashboard Queue and rebuild controls require the `dashboard_rebuilds` table.
The Docker entrypoint applies migrations; on non-Docker installs, run
`pnpm --filter @retaindb/server exec prisma migrate deploy` against the server's
database before starting the new version. No host changes are required. The
browser opens `/dashboard` from the root URL; the machine API and its auth
remain unchanged.

If embedding a Knowledge rebuild batch takes longer than 60 seconds, the
job shows a timeout in **Queue** and releases the slot for another rebuild.
The timed-out batch cannot publish vectors after the error.

Run the dashboard end-to-end tests against a dedicated, migrated pgvector test
database and an installed Chrome browser:

```bash
RETAINDB_TEST_DATABASE_URL="$DATABASE_URL" RETAINDB_TEST_CHROME_CHANNEL=chrome \
  pnpm --filter @retaindb/server exec tsx --test test/dashboard.test.ts test/dashboard-data.integration.test.ts
```

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `RETAINDB_BASE_URL` | `http://localhost:3111` for local MCP | RetainDB API base URL |
| `RETAINDB_PROJECT` | `default` | Default local project |
| `RETAINDB_HOME` | `~/.retaindb` | Local runtime data directory |
| `RETAINDB_STORE` | `~/.retaindb/local-store.json` | Local snapshot path |
| `RETAINDB_EMBEDDING_PROVIDER` | `hash` | `hash` or `local-transformers` |
| `DATABASE_URL` | unset | Postgres connection string for server |
| `RETAINDB_API_KEY` | unset | Optional API auth key |
| `RETAINDB_DASHBOARD_ORIGIN` | unset | HTTPS origin reserved for the browser dashboard |
| `RETAINDB_DASHBOARD_AUTH_URL` | unset | Trusted HTTPS Authelia forward-auth endpoint |
| `RETAINDB_DASHBOARD_SESSION_COOKIE` | `authelia_session` | Authelia cookie validated by the dashboard |
| `OPENAI_API_KEY` | unset | Enables OpenAI-backed server embeddings |
| `EMBEDDING_MODE` | `auto` | Server embedding mode |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-large` | Model the server loads when it embeds itself; one model per corpus |
| `RETAINDB_CONFIG` | `~/.retaindb-mcp/config.json` | Config file the CLI, hooks and MCP server read |
| `EXTRACTION_MODEL` | `gpt-4o-mini` | Server extraction model |
| `DISABLE_AUTO_EXTRACTION` | `false` | Skip automatic entity extraction during document ingestion |
| `PORT` | `3000` | Server HTTP port |
| `DISABLE_SCHEDULER` | `false` | Disable server background sync |

## Local vs Cloud

| Use case | Choose |
| --- | --- |
| Coding-agent memory on your machine | RetainDB Local |
| Self-hosted memory API with Postgres | RetainDB Server |
| Production teams, auth, hosted reliability, dashboard, billing, managed infra | RetainDB Cloud |

RetainDB Cloud adds managed infrastructure, hosted auth, team workflows, production reliability, and cloud product features. RetainDB Local stays useful without cloud sync or an account.

Cloud adds:

- Hosted API keys, auth, and team access controls
- Managed database, vector search, and scaling
- Dashboard workflows for projects, keys, usage, and memory inspection
- Lifecycle email and product update campaigns
- Usage controls, alerts, and operational guardrails
- Higher-level product integrations that do not belong in the local-only runtime

Self-hosted notes:

- The OSS server is single-tenant by default.
- If `RETAINDB_API_KEY` is set, it acts as a shared deployment key.
- Local development can run open on localhost.
- Cloud-style organization isolation belongs in RetainDB Cloud.

## Packages

| Package | npm | Description |
| --- | --- | --- |
| `packages/local` | `@retaindb/local` | Local coding-agent memory runtime |
| `packages/sdk` | `@retaindb/sdk` | TypeScript SDK |
| `packages/mcp` | `@retaindb/mcp` | MCP server |
| `packages/server` | not published | Self-hostable API server |
| `packages/repo-sync` | not published | Rust `retaindb-repo` client: hook hints and Git reconcile |

## Development

```bash
pnpm install
pnpm local:demo
pnpm --filter @retaindb/local typecheck
pnpm --filter @retaindb/sdk build
pnpm --filter @retaindb/mcp typecheck
pnpm --filter @retaindb/mcp test
pnpm --filter @retaindb/sdk typecheck
```

Server development:

```bash
cp .env.example packages/server/.env
pnpm --filter @retaindb/server run db:generate
pnpm --filter @retaindb/server exec prisma migrate deploy
pnpm dev:server
```

Database-client regression tests use the generated Prisma client without a running database:

```bash
pnpm --filter @retaindb/server run db:generate
pnpm --filter @retaindb/server test
```

To run the same suite against a dedicated PostgreSQL database with pgvector:

```bash
export DATABASE_URL=postgresql://retaindb_test@localhost:5432/retaindb_test
pnpm --filter @retaindb/server exec prisma migrate deploy
RETAINDB_TEST_DATABASE_URL="$DATABASE_URL" \
  RETAINDB_TEST_LOCAL_EMBEDDINGS=true EMBEDDING_MODE=local \
  DISABLE_AUTO_EXTRACTION=true pnpm --filter @retaindb/server test
```

The integration tests create and remove their own project data and a temporary chunk constraint for failure injection; some also create and drop their own temporary databases, so the test role needs permission to do that. Use a dedicated test database, never a production memory store. Without `RETAINDB_TEST_DATABASE_URL`, these tests are reported as skipped. Vector ingestion/retrieval, bulk local embeddings and queued-document checks additionally require `RETAINDB_TEST_LOCAL_EMBEDDINGS=true` and download the BGE model on first use. Test processes isolate their database, embedding mode and credential environment before imports, then restore it during teardown. The Node 20/22 CI jobs apply all migrations, repeat deployment, and run this real-database suite. These checks cover the ownerless `default` organization without a fabricated user, retained tenant/project foreign keys, source versions, document vectors, queued document processing, persistence-failure reporting, connector job health, and API loading; they do not establish parity for every legacy table or optional agent/storage feature.

Client (`packages/repo-sync`, std-only Rust, no crates.io dependencies):

```bash
cargo fmt --manifest-path packages/repo-sync/Cargo.toml --check
cargo clippy --manifest-path packages/repo-sync/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path packages/repo-sync/Cargo.toml
```

## Contributing

PRs are welcome. For larger changes, open an issue first with the problem, proposed behavior, and test plan.

## License

- `packages/local`: Apache 2.0
- `packages/sdk`: Apache 2.0
- `packages/mcp`: Apache 2.0
- `packages/server`: [Business Source License 1.1](./LICENSE-BSL)

Self-hosting is free. Building a hosted service on top of the server requires a commercial license. Contact `alex@retaindb.com`.
