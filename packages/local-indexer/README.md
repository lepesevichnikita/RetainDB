# `@retaindb/local-indexer`

One package, two dependencies (tree-sitter grammars). It indexes a directory where the
directory lives and posts the result to RetainDB. The server never sees a path and never
reads a file.

```
node packages/local-indexer/bin/retaindb-index.mjs \
  --root . --project retaindb \
  --api https://retaindb.home.lan --key "$RETAINDB_API_KEY"
```

## Install

```bash
npm i -g ./packages/local-indexer    # puts `retaindb-index` on PATH
retaindb-index --help
```

Then write the target once, and run with no flags after that:

```bash
mkdir -p ~/.retaindb-mcp && chmod 700 ~/.retaindb-mcp
cat > ~/.retaindb-mcp/config.json <<'JSON'
{"api": "https://retaindb-api.home.lan", "project": "retaindb", "token": "<api key>"}
JSON
chmod 600 ~/.retaindb-mcp/config.json
retaindb-index --root /path/to/code
```

Precedence: flags, then `RETAINDB_BASE_URL` / `RETAINDB_API_KEY` / `RETAINDB_PROJECT`, then
the config file.

## Queue, throttling and dedup

Work is never posted straight from the walk. Chunks and graph rows go into two persisted
queues (`~/.retaindb-mcp/chunks.json`, `~/.retaindb-mcp/graph.json`) keyed by identity:
`path#start-end` for a chunk, `entity:<name>` and `edge:<from>|<type>|<to>` for the graph.

- the same key queued twice keeps only its newest payload, so a file re-read in one run
  replaces its earlier chunks instead of sending both
- a batch is dropped from the queue only after the server accepted it, so a killed run
  resumes with exactly what is left
- `--batch` sets rows per request (200) for both chunks and graph: graph rows go through
  `POST /v1/graph/batch`, which writes entities and relations in one transaction and never
  calls the embedding model (node vectors are derived from the chunk vectors)
- `--delay` pauses between batches (200 ms)

`--dry-run` reports what would be sent and posts nothing.

## Embedding on the client

`--embed [model]` computes the vectors on the machine that owns the files and sends them
with each item, so the server writes the vector and never runs the model. That removes the
only part of indexing that used server CPU: with it, a push no longer keeps the service
busy for a second per chunk.

The model must emit 1024 dimensions, because that is what `chunks.embedding` and
`entities.embedding` hold. The default is `Xenova/bge-large-en-v1.5`, the same model the
server uses, so client and server vectors live in one space. `Xenova/multilingual-e5-large`
is also 1024-dimensional and is the better choice for Russian text, but pick one model per
project: mixing them makes similarities meaningless.

```
retaindb-index --root . --graph --embed                     # default model
retaindb-index --root . --graph --embed Xenova/multilingual-e5-large
```

The model is an optional dependency (`@xenova/transformers`); without it `--embed` fails
with a clear message and everything else keeps working. A device that cannot run 1024-dim
models can still let the server embed by omitting the flag.

## Why it is built this way

The remote deployment cannot read a client file system. A path sent to the server is a
server-side file read waiting to happen, and one shared API key away from reading any
file the server process can see. So the split is:

| Side | Does |
| --- | --- |
| client (this tool) | walks the directory, reads bytes, splits into chunks, keeps the manifest, and with `--embed` also computes the vectors |
| server | receives `POST /v1/learn/batch` items of `type: "text"`, stores text and vectors in pgvector, and embeds itself only when no vector was sent |

No git required and no extension filter: every file under `--root` is a candidate, `.git`
except. A file is skipped only when it reads as binary (a NUL byte), exceeds 1 MB, or is
whitespace. Everything else is chunked and shipped, including source, docs, configs and
notes.

The request body contains chunk text and repository-relative paths only. The tests assert
that the receiver never observes an absolute path, a binary file, or a file the client did
not choose to send.

## Contract used

`POST /v1/learn/batch` (`packages/server/src/api/routes.ts:1339`):

```json
{
  "project": "retaindb",
  "async": true,
  "items": [
    {
      "type": "text",
      "title": "src/alpha.ts:1-60",
      "content": "...",
      "custom_id": "src/alpha.ts#1#<sha12>",
      "metadata": { "source": "retaindb-index", "path": "src/alpha.ts", "start_line": 1, "end_line": 60, "sha": "..." }
    }
  ]
}
```

Max 600 items per request; this tool sends 200.

## Incremental state

`~/.retaindb-mcp/index-manifest.json`, keyed by absolute repository root, holding
`path -> sha256(content)`. A file whose digest is unchanged is not read again and not sent.
This is the file name already used by `@retaindb/mcp-server` 2.17.0, so both agree on it.

## Chunking

`src/chunker.mjs` parses with tree-sitter WASM grammars for TypeScript, TSX, JavaScript,
Python, Go, Rust and Java, then emits symbol ranges (functions, classes, methods) merged
into windows of at most 60 lines. Adjacent symbols closer than 3 lines merge. A file with
no grammar, or one that yields no symbols, falls back to 60-line windows with 8 lines of
overlap. Every chunk is capped at 12,000 characters.

## Tests

```
node --test packages/local-indexer/test/indexer.test.mjs
```

Six end-to-end cases against a real git repository and a real HTTP receiver: indexing,
relative-paths-only, binary exclusion, chunk splitting, unchanged-file skip on the second
run, and dry run. `npm test` inside the package runs the same file.
