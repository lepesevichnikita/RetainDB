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

export function resolveHookBaseUrl(fallback = "http://localhost:3111") {
  return (process.env.RETAINDB_BASE_URL || config.api || fallback).replace(/\/+$/, "");
}

export const BASE_URL = resolveHookBaseUrl();
export const API_KEY = process.env.RETAINDB_API_KEY || config.token || "";
function resolveHookEmbeddingMode(mode) {
  if (mode === "local" || mode === "workstation") return "workstation";
  if (mode === "server") return "server";
  process.stderr.write("RetainDB: invalid hook embedding mode; expected local, workstation, or server. Hook requests skipped.\n");
  return "invalid";
}
export const HOOK_EMBEDDING_MODE = resolveHookEmbeddingMode(process.env.RETAINDB_HOOK_EMBEDDING_MODE ?? config.hook_embedding_mode ?? "server");
export const HOOK_EMBEDDING_MODEL = process.env.RETAINDB_HOOK_EMBEDDING_MODEL || config.hook_embedding_model || "Xenova/multilingual-e5-large";
export function resolveHookProject(data = {}) {
  return process.env.RETAINDB_PROJECT || config.project || data.project || data.cwd || "default";
}
