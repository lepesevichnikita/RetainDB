/**
 * Stand-in for the native embedding process.
 *
 * The production worker owns the ONNX model; this fixture owns only the IPC
 * contract, so the client can be exercised without loading a model. Each text
 * maps to a tiny vector whose first value is the text length, which makes a
 * mismatched response visible in an assertion.
 */
if (process.env.RETAINDB_FIXTURE_EXIT_IMMEDIATELY === "1") process.exit(1);

process.on("message", (message: any) => {
  if (!message || typeof message.id !== "string") return;
  const { id, texts, query, passages } = message;
  if (Array.isArray(passages) && typeof query === "string") {
    process.send?.({ id, scores: passages.map((passage: string) => passage.length / 100) });
    return;
  }
  if (!Array.isArray(texts)) return;
  if (texts[0] === "explode") {
    process.send?.({ id, error: "fixture inference failed" });
    return;
  }
  if (texts[0] === "hang") return;
  const respond = () => process.send?.({ id, vectors: texts.map((text: string) => [text.length, 1]) });
  if (texts[0] === "slow") setTimeout(respond, 150);
  else respond();
});
