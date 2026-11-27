import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Client configs that can already hold a working RetainDB MCP server entry. */
const CLIENT_CONFIGS = [
  ".claude.json",
  join("Library", "Application Support", "Claude", "claude_desktop_config.json"),
  join(".config", "claude", "claude_desktop_config.json"),
];

/**
 * A machine that already runs the RetainDB MCP server should not be asked for the same API
 * key again: the server entry carries it in its environment, so the indexer reads it there.
 */
export async function findMcpTarget(home = homedir()) {
  for (const relative of CLIENT_CONFIGS) {
    let data;
    try {
      data = JSON.parse(await readFile(join(home, relative), "utf8"));
    } catch {
      continue;
    }
    for (const server of Object.values(data?.mcpServers ?? {})) {
      const env = server?.env ?? {};
      if (!env.RETAINDB_API_KEY || !env.RETAINDB_BASE_URL) continue;
      return {
        api: env.RETAINDB_BASE_URL,
        token: env.RETAINDB_API_KEY,
        ...(env.RETAINDB_PROJECT ? { project: env.RETAINDB_PROJECT } : {}),
      };
    }
  }
  return {};
}
