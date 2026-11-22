import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the hooks send captured events.
 *
 * The environment wins, then the same config file the CLI and the MCP server read, so a
 * machine configured once does not need the base URL and key repeated in every hook process.
 */
function readConfig() {
  const path = process.env.RETAINDB_CONFIG || join(homedir(), ".retaindb-mcp", "config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const config = readConfig();

export const BASE_URL = (process.env.RETAINDB_BASE_URL || config.api || "http://localhost:3111").replace(/\/+$/, "");
export const API_KEY = process.env.RETAINDB_API_KEY || config.token || "";
export const PROJECT = process.env.RETAINDB_PROJECT || config.project || "default";
