/**
 * Single owner of the local embedding contract: the model identity, the vector width and the
 * lazy load. Importing this module loads no model; the runtime is imported on the first embed call,
 * so a process that never embeds never pays for it.
 */

export const EMBEDDING_DIMENSIONS = 1024;
export const LOCAL_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/multilingual-e5-large";

export interface EmbedOptions {
  /** Skip the network and use only an already present model directory. */
  localFilesOnly?: boolean;
  /** Directory that holds `<model>/onnx/model_quantized.onnx`; the runtime's own path is used when absent. */
  modelPath?: string;
  /** Override the model for a caller that must keep its own recorded identity. */
  model?: string;
}

interface Encoder {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<{ data: Float32Array }>;
}

const encoders = new Map<string, Promise<Encoder>>();
let loaded = false;

async function createEncoder(model: string, options: EmbedOptions): Promise<Encoder> {
  const runtime = await import("@huggingface/transformers");
  if (options.modelPath) runtime.env.localModelPath = options.modelPath;
  const pipelineOptions = { dtype: "q8" as const, local_files_only: options.localFilesOnly === true };
  return runtime.pipeline("feature-extraction", model, pipelineOptions) as unknown as Promise<Encoder>;
}

function encoderKey(model: string, options: EmbedOptions): string {
  return `${model}:${options.modelPath ?? "default"}:${options.localFilesOnly === true}`;
}

function encoderFor(model: string, options: EmbedOptions): Promise<Encoder> {
  const key = encoderKey(model, options);
  const cached = encoders.get(key) ?? createEncoder(model, options);
  encoders.set(key, cached);
  return cached;
}

function chunk(flat: Float32Array, width: number): number[][] {
  const rows: number[][] = [];
  for (let index = 0; index < flat.length; index += width) rows.push(Array.from(flat.slice(index, index + width)));
  return rows;
}

export function embeddingCoreStatus(): { model: string; loaded: boolean; dimensions: number } {
  return { model: LOCAL_EMBEDDING_MODEL, loaded, dimensions: EMBEDDING_DIMENSIONS };
}

export async function embedLocal(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  const encoder = await encoderFor(options.model ?? LOCAL_EMBEDDING_MODEL, options);
  loaded = true;
  const output = await encoder(texts, { pooling: "mean", normalize: true });
  return chunk(output.data, EMBEDDING_DIMENSIONS);
}
