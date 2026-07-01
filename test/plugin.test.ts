/**
 * Plugin kernel: the security-critical bits. readManifest must reject an entry
 * that escapes the plugin dir (path traversal + symlink), loadPluginConfig must
 * throw on a corrupt config rather than silently returning empty (which would
 * let a subsequent save wipe the enabled list), and savePluginConfig must write
 * atomically and round-trip.
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  isValidPluginId,
  loadPluginConfig,
  readManifest,
  savePluginConfig,
} from "../src/kernel/plugin.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "donguri.plugin.json"), JSON.stringify(manifest));
}

describe("plugin manifest + safeEntryPath", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("accepts a manifest whose entry is inside the plugin dir", async () => {
    const dir = tmp.file("good");
    writeManifest(dir, { id: "good", name: "Good", version: "1.0.0", main: "index.js" });
    writeFileSync(join(dir, "index.js"), "export default { id: 'good', register() {} };");
    const manifest = await readManifest(dir);
    assert.equal(manifest.id, "good");
    assert.deepEqual(manifest.capabilities, []); // schema default
  });

  it("rejects an entry that escapes via ../", async () => {
    const dir = tmp.file("escaper");
    writeManifest(dir, { id: "escaper", name: "E", version: "1.0.0", main: "../outside.js" });
    writeFileSync(tmp.file("outside.js"), "export default { id: 'x', register() {} };");
    await assert.rejects(() => readManifest(dir), /escapes|does not resolve/);
  });

  it("rejects an entry that escapes via a symlink", async (t) => {
    const dir = tmp.file("linky");
    mkdirSync(dir, { recursive: true });
    const secret = tmp.file("secret.js");
    writeFileSync(secret, "export default { id: 'x', register() {} };");
    try {
      symlinkSync(secret, join(dir, "index.js"));
    } catch {
      t.skip("symlinks unsupported on this platform");
      return;
    }
    writeManifest(dir, { id: "linky", name: "L", version: "1.0.0", main: "index.js" });
    await assert.rejects(() => readManifest(dir), /escapes|does not resolve/);
  });

  it("rejects an invalid plugin id at the schema level", async () => {
    const dir = tmp.file("Bad_Id");
    writeManifest(dir, { id: "Bad_Id", name: "B", version: "1.0.0", main: "index.js" });
    writeFileSync(join(dir, "index.js"), "export default { id: 'x', register() {} };");
    await assert.rejects(() => readManifest(dir));
  });
});

describe("plugin config persistence", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("returns an empty config when the file does not exist", async () => {
    assert.deepEqual(await loadPluginConfig(tmp.file("nope.json")), { plugins: [] });
  });

  it("round-trips through save + load", async () => {
    const path = tmp.file("plugins.json");
    await savePluginConfig(path, { plugins: [{ id: "hello", enabled: true }] });
    const loaded = await loadPluginConfig(path);
    assert.deepEqual(loaded, { plugins: [{ id: "hello", enabled: true }] });
  });

  it("throws on a corrupt config instead of silently emptying it", async () => {
    const path = tmp.file("corrupt.json");
    writeFileSync(path, "{ this is not json");
    await assert.rejects(() => loadPluginConfig(path), /unreadable|invalid/);
  });
});

describe("isValidPluginId", () => {
  it("accepts slugs, rejects the rest", () => {
    assert.equal(isValidPluginId("hello-plugin"), true);
    assert.equal(isValidPluginId("a1"), true);
    assert.equal(isValidPluginId("Bad_Id"), false);
    assert.equal(isValidPluginId("../evil"), false);
    assert.equal(isValidPluginId(""), false);
  });
});
