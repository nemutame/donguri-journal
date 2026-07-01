/**
 * Deterministic in-process embedder for tests.
 *
 * The real backend (transformers.js) is heavy and network-dependent on first
 * use. Tests inject this instead via the same EmbeddingProvider seam the server
 * uses, so store tests are fast and reproducible while still exercising the real
 * sqlite-vec KNN path (BigInt rowid, Float32 blob, MATCH/k query).
 *
 * The vector is a tiny bag-of-words hashed into `dim` buckets, then L2
 * normalized — enough that texts sharing words land near each other and recall
 * ordering is meaningful, without any model.
 */
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

export class FakeEmbedder implements EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;

  constructor(modelId = "fake/hash-bow", dim = 64) {
    this.modelId = modelId;
    this.dim = dim;
  }

  #embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const token of tokens) {
      const h = createHash("sha256").update(token).digest();
      const bucket = h.readUInt32BE(0) % this.dim;
      vec[bucket] = (vec[bucket] ?? 0) + 1;
    }
    const norm = Math.hypot(...vec) || 1;
    return vec.map((v) => v / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.#embedOne(t));
  }
}
