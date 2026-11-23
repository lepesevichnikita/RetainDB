import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMcpTarget } from "../src/client-config.mjs";

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "retaindb-home-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test("an MCP server entry supplies the target, so no key is asked twice", async (t) => {
  const dir = await home(t);
  await writeFile(join(dir, ".claude.json"), JSON.stringify({
    mcpServers: {
      other: { command: "x" },
      retaindb: {
        command: "node",
        args: ["server.js"],
        env: {
          RETAINDB_BASE_URL: "https://retaindb-api.example.lan",
          RETAINDB_API_KEY: "key-from-mcp",
          RETAINDB_PROJECT: "work",
        },
      },
    },
  }));

  assert.deepEqual(await findMcpTarget(dir), {
    api: "https://retaindb-api.example.lan",
    token: "key-from-mcp",
    project: "work",
  });
});

test("a Claude Desktop entry is read too", async (t) => {
  const dir = await home(t);
  await mkdir(join(dir, "Library", "Application Support", "Claude"), { recursive: true });
  await writeFile(join(dir, "Library", "Application Support", "Claude", "claude_desktop_config.json"), JSON.stringify({
    mcpServers: { retaindb: { env: { RETAINDB_BASE_URL: "https://h.lan", RETAINDB_API_KEY: "k" } } },
  }));

  assert.deepEqual(await findMcpTarget(dir), { api: "https://h.lan", token: "k" });
});

test("a machine with no MCP server entry yields nothing instead of guessing", async (t) => {
  const dir = await home(t);
  assert.deepEqual(await findMcpTarget(dir), {});
});
