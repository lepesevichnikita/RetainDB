#!/usr/bin/env node

import { createHash } from "node:crypto";
import { API_KEY, BASE_URL, HOOK_EMBEDDING_MODEL, HOOK_EMBEDDING_MODE, HOOK_MACHINE, resolveHookProject } from "./_config.mjs";
import { redactCapture } from "./_redact.mjs";
const AUTO_CONTEXT = process.env.RETAINDB_AUTO_CONTEXT !== "false";
const COMPRESS_TOOL_OUTPUT = process.env.RETAINDB_COMPRESS_TOOL_OUTPUT !== "false";
const TOKEN_BUDGET = Number(process.env.RETAINDB_TOKEN_BUDGET || 1200);

function headers() {
  const value = { "Content-Type": "application/json" };
  if (API_KEY) value.Authorization = `Bearer ${API_KEY}`;
  return value;
}

function truncate(value, max = 8000) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...[truncated]` : value;
  } catch {
    return value;
  }
}

export async function readHookInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data = {};
  try {
    data = input.trim() ? JSON.parse(input) : {};
  } catch {
    data = { raw: input.slice(0, 8000) };
  }
  return { input, data };
}

export function hookMeta(data = {}) {
  return {
    sessionId: data.session_id || data.sessionId || process.env.RETAINDB_SESSION_ID || "unknown",
    project: resolveHookProject(data),
    agentId: process.env.RETAINDB_AGENT_ID || data.agent_id || data.agentId || "agent",
    cwd: data.cwd || process.cwd(),
  };
}

export function postRequest(path, body, timeout = 2500) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}

export async function post(path, body, timeout) {
  const res = await postRequest(path, body, timeout);
  return res.ok ? res.json() : null;
}

export function shouldInjectContext() {
  return HOOK_EMBEDDING_MODE === "server" && AUTO_CONTEXT && process.env.RETAINDB_INJECT_CONTEXT !== "false";
}

export async function buildContextPack(data, hookType, query) {
  if (!shouldInjectContext()) return null;
  const meta = hookMeta(data);
  const previous = process.env[`RETAINDB_CONTEXT_HASH_${meta.sessionId}`] || data.previous_context_hash || data.context_hash;
  return post("/v1/context/pack", {
    project: meta.project,
    query: query || data.prompt || data.message || data.tool_input || data.tool_name || hookType,
    cwd: meta.cwd,
    files: data.files || data.filePaths || data.paths || [],
    tool_output: COMPRESS_TOOL_OUTPUT ? data.tool_output || data.tool_response || "" : "",
    previous_context_hash: previous,
    token_budget: TOKEN_BUDGET,
  });
}

export async function printContextPack(data, hookType, query) {
  try {
    const pack = await buildContextPack(data, hookType, query);
    if (pack?.context_hash) process.env[`RETAINDB_CONTEXT_HASH_${hookMeta(data).sessionId}`] = pack.context_hash;
    const text = pack?.delta_context ?? pack?.context;
    if (text && String(text).trim()) process.stdout.write(`\nRetainDB compact context:\n${text}\n`);
  } catch {
    // Hooks must never block the agent.
  }
}

async function compressedData(data) {
  if (!COMPRESS_TOOL_OUTPUT) return data;
  const raw = data.tool_output ?? data.tool_response;
  if (typeof raw !== "string" || raw.length < 1200) return data;
  try {
    const body = await post("/v1/context/compress-output", { output: raw, token_budget: Math.min(TOKEN_BUDGET, 600) }, 2500);
    if (body?.compressed) return { ...data, tool_output: body.compressed, tool_response: body.compressed, raw_output_hash: await hash(raw), output_compressed: true };
  } catch {}
  return data;
}

async function hash(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function workstationEmbedding(summary) {
  const { pipeline } = await import("@xenova/transformers");
  const model = HOOK_EMBEDDING_MODEL;
  const extractor = await pipeline("feature-extraction", model, { quantized: true, local_files_only: true });
  const output = await extractor(summary, { pooling: "mean", normalize: true });
  return { model, vector: Array.from(output.data), content_sha256: createHash("sha256").update(summary).digest("hex") };
}

function workstationSummary(kind, supplied, data) {
  const values = [supplied, data.tool_output, data.tool_response, data.tool_result, data.prompt, data.message, data.tool_name, kind];
  const candidate = values.find(value => value != null && (typeof value !== "string" || value.trim()));
  const text = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 200).join("").trim() || kind;
}

export async function captureOnWorkstation({ baseUrl = BASE_URL, project, sessionId, agentId, kind, data, summary: supplied = "" }) {
  try {
    const safe = redactCapture({ kind, supplied, data });
    const summary = workstationSummary(safe.kind, safe.supplied, safe.data);
    const embedding = await workstationEmbedding(summary);
    const response = await fetch(`${baseUrl}/v1/agent-events/workstation`, { method: "POST", headers: headers(), redirect: "error",
      signal: AbortSignal.timeout(3000), body: JSON.stringify({ project, machine: HOOK_MACHINE, session_id: sessionId, agent_id: agentId,
        event: { kind: safe.kind, summary, details: JSON.stringify(safe.data).slice(0, 12000), timestamp: new Date().toISOString() }, embedding }) });
    if (response.status !== 202) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    process.stderr.write(`RetainDB workstation capture not submitted: ${/^HTTP \d{3}$/.test(error?.message) ? error.message : "local model or Server endpoint unavailable"}.\n`);
  }
}

export async function capture(hookType, providedData) {
  if (HOOK_EMBEDDING_MODE === "invalid") return;
  const { data } = providedData ? { data: providedData } : await readHookInput();
  if (process.env.RETAINDB_SDK_CHILD === "1" || data.entrypoint === "sdk-ts") return;

  const meta = hookMeta(data);
  if (HOOK_EMBEDDING_MODE === "workstation") return captureOnWorkstation({ ...meta, kind: hookType, data });
  const safeData = await compressedData(data);

  const payload = {
    hookType,
    sessionId: meta.sessionId,
    project: meta.project,
    machine: HOOK_MACHINE,
    cwd: meta.cwd,
    timestamp: new Date().toISOString(),
    data: {
      ...safeData,
      tool_output: truncate(safeData.tool_output ?? safeData.tool_response),
      prompt: truncate(safeData.prompt),
    },
  };

  try {
    await post("/retaindb/observe", payload, 3000);
  } catch {
    // Hooks must never block the agent.
  }
}
