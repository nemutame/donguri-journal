/**
 * Original-artifact store.
 *
 * The two-layer design keeps originals verbatim and the vector index disposable.
 * When the front-end LLM captures media, it sends the original bytes over MCP and
 * the server persists them here, then points `original_ref` at the saved object.
 * The server never interprets the bytes (no vision/audio models) — it only stores
 * and serves them so the LLM can re-view / re-extract later.
 *
 * The backend is pluggable behind `OriginalStore`. The default is a local
 * content-addressed directory; an Eagle backend can be added as an opt-in later
 * without touching callers.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SaveOriginalInput {
  data: Buffer;
  mime?: string;
  filename?: string;
}

export interface SavedOriginal {
  /** Reference stored in entries.original_ref, e.g. "local:<sha256>.<ext>". */
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

export interface OriginalStore {
  readonly kind: string;
  save(input: SaveOriginalInput): Promise<SavedOriginal>;
  /** Load a previously saved original, or null if the ref is unknown to this store. */
  get(ref: string): Promise<LoadedOriginal | null>;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/webm": "weba",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

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

function sanitizeExt(raw: string): string | null {
  const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext.length > 0 && ext.length <= 8 ? ext : null;
}

/** Pick a file extension from the filename, then the mime type, else "bin". */
function extensionFor(input: SaveOriginalInput): string {
  if (input.filename) {
    const dot = input.filename.lastIndexOf(".");
    if (dot >= 0) {
      const ext = sanitizeExt(input.filename.slice(dot + 1));
      if (ext) return ext;
    }
  }
  if (input.mime) {
    const ext = MIME_TO_EXT[input.mime.toLowerCase()];
    if (ext) return ext;
  }
  return "bin";
}

/** Content-addressed store under a local directory. */
export class LocalDirStore implements OriginalStore {
  readonly kind = "local";
  #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = resolve(baseDir);
  }

  async save(input: SaveOriginalInput): Promise<SavedOriginal> {
    const sha = createHash("sha256").update(input.data).digest("hex");
    const ext = extensionFor(input);
    const name = `${sha}.${ext}`;
    const path = join(this.#baseDir, name);
    if (!existsSync(path)) {
      await mkdir(this.#baseDir, { recursive: true });
      await writeFile(path, input.data);
    }
    return { ref: `local:${name}`, bytes: input.data.length, mime: input.mime ?? EXT_TO_MIME[ext] };
  }

  async get(ref: string): Promise<LoadedOriginal | null> {
    const prefix = "local:";
    if (!ref.startsWith(prefix)) return null;
    const name = ref.slice(prefix.length);
    // Strict shape (sha256 + simple ext) also rules out path traversal.
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name)) return null;
    const path = join(this.#baseDir, name);
    if (!path.startsWith(this.#baseDir) || !existsSync(path)) return null;
    const data = await readFile(path);
    const ext = name.slice(name.lastIndexOf(".") + 1);
    return { data, mime: EXT_TO_MIME[ext], path };
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
