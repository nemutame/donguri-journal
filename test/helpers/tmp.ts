/**
 * Per-test filesystem isolation. Each call gets a fresh directory under the OS
 * temp dir; `cleanup` removes it. Store/originals tests use these so nothing
 * touches the real ~/.journal-mcp.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir {
  path: string;
  file(name: string): string;
  cleanup(): void;
}

export function makeTempDir(prefix = "donguri-test-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    file: (name: string) => join(path, name),
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
