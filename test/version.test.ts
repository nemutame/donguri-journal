/**
 * SERVER_VERSION must track package.json — a hardcoded version string goes
 * stale silently (the MCP handshake reported 0.1.0 while 0.1.2 was published).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SERVER_VERSION } from "../src/kernel/version.js";

describe("SERVER_VERSION", () => {
  it("matches the package.json version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    assert.equal(SERVER_VERSION, pkg.version);
    assert.notEqual(SERVER_VERSION, "unknown");
  });
});
