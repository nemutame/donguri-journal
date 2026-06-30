/**
 * Embedding backend abstraction.
 *
 * The default runs fully in-process via transformers.js (no Ollama, no manual
 * model pull) so the server works with a bare `npx`. The interface is swappable
 * so power users can plug in Ollama or a cloud API later — the active model id
 * and dimension are recorded in `embedding_meta` so a backend switch can be
 * detected and trigger a reindex (vectors from different models are not
 * comparable).
 */

export interface EmbeddingProvider {
  /** Stable identifier of the model, e.g. "Xenova/all-MiniLM-L6-v2". */
  readonly modelId: string;
  /** Output dimensionality. Fixed for the lifetime of the provider. */
  readonly dim: number;
  /** Embed a batch of texts. Returns one vector (length `dim`) per input. */
  embed(texts: string[]): Promise<number[][]>;
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIM = 384;

/** Minimal shape of the transformers.js feature-extraction pipeline we use. */
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * Default provider: mean-pooled, L2-normalized sentence embeddings computed
 * locally with transformers.js. The model is downloaded and cached on first
 * use, so the pipeline is created lazily (the server can start, and alternative
 * backends can be used, without ever loading transformers.js).
 */
export class LocalTransformersProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;
  #pipeline: Promise<FeatureExtractionPipeline> | null = null;

  constructor(modelId: string = DEFAULT_MODEL, dim: number = DEFAULT_DIM) {
    this.modelId = modelId;
    this.dim = dim;
  }

  #getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.#pipeline) {
      this.#pipeline = (async () => {
        const { pipeline } = await import("@xenova/transformers");
        const extractor = await pipeline("feature-extraction", this.modelId);
        return extractor as unknown as FeatureExtractionPipeline;
      })();
    }
    return this.#pipeline;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.#getPipeline();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

/**
 * Choose an embedding backend. Today this always returns the in-process default;
 * later it will read an env var (e.g. JOURNAL_EMBEDDING_BACKEND) to select an
 * Ollama or cloud provider.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  return new LocalTransformersProvider();
}
