import test from "node:test";
import assert from "node:assert/strict";
import { redact, handleError } from "../lib/http.js";

test("unexpected errors are logged without RPC keys, URLs or long blobs", () => {
  const out = redact("failed to post https://mainnet.helius-rpc.com/?api-key=abc123 api_key=xyz " + "A".repeat(200));
  assert.doesNotMatch(out, /abc123|xyz|helius-rpc|AAAAAAAAAA/);
  const lines = [], old = console.error;
  console.error = (l) => lines.push(l);
  try {
    let status, body;
    handleError({ setHeader() {}, end(v) { body = v; }, set statusCode(v) { status = v; }, get statusCode() { return status; } },
      Object.assign(new Error("Simulation failed: Blockhash not found https://x.example/?api-key=k"), { logs: ["Program log: ok"] }));
    assert.equal(status, 503);
    assert.match(body, /temporarily unavailable/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Blockhash not found/);
    assert.doesNotMatch(lines[0], /api-key=k|x\.example/);
  } finally { console.error = old; }
});
