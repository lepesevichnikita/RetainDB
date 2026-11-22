# `@retaindb/local-indexer`

One file, no dependencies. It indexes a repository where the repository lives and posts
the result to RetainDB. The server never sees a path and never reads a file.

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

Environment fallbacks: `RETAINDB_BASE_URL`, `RETAINDB_API_KEY`, `RETAINDB_PROJECT`.
`--dry-run` reports what would be sent and posts nothing.

## Why it is built this way

The remote deployment cannot read a client file system. A path sent to the server is a
server-side file read waiting to happen, and one shared API key away from reading any
file the server process can see. So the split is:

| Side | Does |
| --- | --- |
| client (this tool) | walks the worktree, reads bytes, splits into chunks, keeps the manifest |
| server | receives `POST /v1/learn/batch` items of `type: "text"`, embeds, stores in pgvector |

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
