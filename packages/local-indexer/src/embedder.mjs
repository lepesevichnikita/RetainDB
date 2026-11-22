/**
 * Client-side embeddings: the machine that owns the files computes the vectors and the
 * server only stores them, so indexing no longer spends server CPU.
 *
 * The model must produce exactly the dimension the database column holds, otherwise the
 * vector cannot be written at all. It also has to embed every language the corpus contains
 * into one space, so the default is multilingual rather than English-only.
 */
export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_MODEL = "Xenova/multilingual-e5-large";

export function resolveModel(flagValue) {
  if (flagValue === true) return DEFAULT_MODEL;
  return flagValue || "";
}

export function assertDimensions(vector, model) {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`${model} produces ${vector.length} dimensions; RetainDB stores ${EMBEDDING_DIMENSIONS}`);
  }
  return vector;
}

export async function createEmbedder(model) {
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = false;
  const extract = await pipeline("feature-extraction", model, { quantized: true });
  return async (texts) => {
    const output = await extract(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((vector) => assertDimensions(vector, model));
  };
}
