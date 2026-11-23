#!/usr/bin/env node
import { capture, hookMeta, postRequest, printContextPack, readHookInput } from "./_capture.mjs";
import { HOOK_EMBEDDING_MODE } from "./_config.mjs";

const { data } = await readHookInput();
const { sessionId, project, cwd } = hookMeta(data);

if (HOOK_EMBEDDING_MODE !== "server") await capture("session_start", data);
else try {
  const response = await postRequest("/retaindb/session/start", { sessionId, project, cwd }, 1500);
  if (response.status === 404) await capture("session_start", data);
  if (process.env.RETAINDB_INJECT_CONTEXT === "true" && response.ok) {
    const body = await response.json();
    if (body.context) process.stdout.write(body.context);
  }
  await printContextPack(data, "session_start", "project decisions workflows open tasks relevant files");
} catch {
  await capture("session_start", data);
}
