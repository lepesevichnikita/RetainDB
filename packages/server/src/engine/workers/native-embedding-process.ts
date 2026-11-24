import { embed } from "../embeddings.js";
import { crossEncoderScore } from "../embeddings-local.js";

/**
 * The only process that loads the local ONNX models.
 *
 * It answers two message shapes from ../embedding-process.ts:
 *   { id, texts }            → { id, vectors }
 *   { id, query, passages }  → { id, scores }
 * A failed request rejects only itself; the process stays alive so the next
 * caller does not pay for a model reload.
 */
function isTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text => typeof text === "string");
}

process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object" || !("id" in message)) return;
  const { id, texts, query, passages } = message as { id?: unknown; texts?: unknown; query?: unknown; passages?: unknown };
  if (typeof id !== "string") return;
  try {
    if (isTexts(passages) && typeof query === "string") {
      process.send?.({ id, scores: await crossEncoderScore(query, passages) });
      return;
    }
    if (!isTexts(texts)) return;
    process.send?.({ id, vectors: await embed(texts) });
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : "Embedding process failed" });
  }
});

process.once("disconnect", () => process.exit(0));
