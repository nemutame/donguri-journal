/**
 * Original-artifact store.
 *
 * The two-layer design keeps originals verbatim and the vector index disposable.
 * When the front-end LLM captures media, it sends the original bytes over MCP and
 * the server persists them here, then points `original_ref` at the saved object.
 * The server never interprets the bytes (no vision/audio models) — it only stores
 * and serves them so the LLM can re-view / re-extract later.
 *
 * Objects are addressed purely by content hash, so identical bytes always map to
 * the same ref regardless of the supplied filename/MIME. The MIME type is kept as
 * separate sidecar metadata rather than baked into the ref.
 *
 * The backend is pluggable behind `OriginalStore`. The default is a local
 * directory; an Eagle backend can be added as an opt-in later without touching
 * callers.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SaveOriginalInput {
  data: Buffer;
  mime?: string;
  filename?: string;
}

export interface SavedOriginal {
  /** Reference stored in entries.original_ref, e.g. "local:<sha256>". */
  ref: string;
  bytes: number;
  mime?: string;
}

export interface LoadedOriginal {
  data: Buffer;
  mime?: string;
  /** Absolute path on disk (originals live on the same machine as the server). */
  path: string;
}

export interface OriginalsStats {
  count: number;
  bytes: number;
}

export interface OriginalStore {
  readonly kind: string;
  save(input: SaveOriginalInput): Promise<SavedOriginal>;
  /** Load a previously saved original, or null if the ref is unknown to this store. */
  get(ref: string): Promise<LoadedOriginal | null>;
  /** Remove an original (and its sidecar). Returns true if a blob was deleted. */
  delete(ref: string): Promise<boolean>;
  /** Aggregate count + total bytes of stored originals. */
  stats(): Promise<OriginalsStats>;
}

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tiff: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  weba: "audio/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};

/** Resolve a MIME type from the explicit value, else the filename extension. */
function resolveMime(input: SaveOriginalInput): string | undefined {
  if (input.mime && input.mime.length > 0) return input.mime.toLowerCase();
  if (input.filename) {
    const dot = input.filename.lastIndexOf(".");
    if (dot >= 0) {
      const ext = input.filename
        .slice(dot + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const mime = EXT_TO_MIME[ext];
      if (mime) return mime;
    }
  }
  return undefined;
}

interface SidecarMeta {
  mime?: string;
  filename?: string;
}

/**
 * Content-addressed store under a local directory. Each original is stored as a
 * blob named `<sha256>` plus a `<sha256>.json` sidecar holding its MIME type and
 * original filename.
 */
export class LocalDirStore implements OriginalStore {
  readonly kind = "local";
  #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = resolve(baseDir);
  }

  async save(input: SaveOriginalInput): Promise<SavedOriginal> {
    const sha = createHash("sha256").update(input.data).digest("hex");
    const mime = resolveMime(input);
    const blobPath = join(this.#baseDir, sha);
    const metaPath = join(this.#baseDir, `${sha}.json`);
    if (!existsSync(blobPath)) {
      await mkdir(this.#baseDir, { recursive: true });
      await writeFile(blobPath, input.data);
    }

    // Create the sidecar, or backfill fields a previous save left empty (e.g. a
    // first save without a MIME followed by one that knows it).
    let existing: SidecarMeta = {};
    if (existsSync(metaPath)) {
      try {
        existing = JSON.parse(await readFile(metaPath, "utf8")) as SidecarMeta;
      } catch {
        // Corrupt sidecar — rewrite it from the current input.
      }
    }
    const merged: SidecarMeta = {
      mime: existing.mime ?? mime,
      filename: existing.filename ?? input.filename,
    };
    if (
      !existsSync(metaPath) ||
      merged.mime !== existing.mime ||
      merged.filename !== existing.filename
    ) {
      await mkdir(this.#baseDir, { recursive: true });
      await writeFile(metaPath, JSON.stringify(merged));
    }
    return { ref: `local:${sha}`, bytes: input.data.length, mime: merged.mime };
  }

  async get(ref: string): Promise<LoadedOriginal | null> {
    const prefix = "local:";
    if (!ref.startsWith(prefix)) return null;
    const sha = ref.slice(prefix.length);
    // Pure hex sha256: also rules out path traversal.
    if (!/^[a-f0-9]{64}$/.test(sha)) return null;
    const blobPath = join(this.#baseDir, sha);
    if (!blobPath.startsWith(this.#baseDir) || !existsSync(blobPath)) return null;

    const data = await readFile(blobPath);
    let mime: string | undefined;
    const metaPath = join(this.#baseDir, `${sha}.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, "utf8")) as SidecarMeta;
        if (typeof meta.mime === "string") mime = meta.mime;
      } catch {
        // Corrupt sidecar — fall back to no MIME rather than failing the read.
      }
    }
    return { data, mime, path: blobPath };
  }

  async delete(ref: string): Promise<boolean> {
    const prefix = "local:";
    if (!ref.startsWith(prefix)) return false;
    const sha = ref.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/.test(sha)) return false;
    const blobPath = join(this.#baseDir, sha);
    const metaPath = join(this.#baseDir, `${sha}.json`);
    let removed = false;
    if (existsSync(blobPath)) {
      await unlink(blobPath);
      removed = true;
    }
    if (existsSync(metaPath)) {
      await unlink(metaPath);
    }
    return removed;
  }

  async stats(): Promise<OriginalsStats> {
    if (!existsSync(this.#baseDir)) return { count: 0, bytes: 0 };
    const names = await readdir(this.#baseDir);
    let count = 0;
    let bytes = 0;
    for (const name of names) {
      if (name.endsWith(".json")) continue;
      const info = await stat(join(this.#baseDir, name));
      if (info.isFile()) {
        count += 1;
        bytes += info.size;
      }
    }
    return { count, bytes };
  }
}

/**
 * Choose an original store. Today this is always the local directory; an Eagle
 * backend (when JOURNAL_EAGLE_API is set) can be slotted in here later.
 */
export function createOriginalStore(): OriginalStore {
  const fromEnv = process.env.JOURNAL_ORIGINALS_DIR;
  const baseDir =
    fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".journal-mcp", "originals");
  return new LocalDirStore(baseDir);
}
