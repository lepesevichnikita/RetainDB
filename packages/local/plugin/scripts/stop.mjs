#!/usr/bin/env node
import { capture, hookMeta, postRequest, readHookInput } from "./_capture.mjs";
import { HOOK_EMBEDDING_MODE } from "./_config.mjs";

const { data } = await readHookInput();
const { sessionId, project } = hookMeta(data);
await capture("stop", data);

if (HOOK_EMBEDDING_MODE === "server") try {
  await postRequest("/retaindb/summarize", { sessionId, project }, 5000);
  await postRequest("/retaindb/session/end", { sessionId, project }, 2000);
} catch {}
