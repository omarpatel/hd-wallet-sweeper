import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (script, args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input: "" });

test("--help documents that broadcasting needs --send", () => {
  for (const script of ["sweep.js", "solana-sweep.js"]) {
    const r = run(script, ["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--send/);
  }
});

test("solana-sweep rejects an invalid destination before touching the network", () => {
  const r = run("solana-sweep.js", ["--to", "not-an-address"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid Solana destination/);
});

test("solana-sweep rejects custom paths without {i}", () => {
  const r = run("solana-sweep.js", ["--to", "11111111111111111111111111111111", "--path", "m/44'/501'/0'"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /contain \{i\}/);
});

test("sweep rejects a bad destination and an unknown preset", () => {
  let r = run("sweep.js", ["--rpc", "http://127.0.0.1:1", "--to", "0x123"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid destination/);
  r = run("sweep.js", ["--rpc", "http://127.0.0.1:1", "--to", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", "--paths", "nope"]);
  assert.equal(r.status, 1);
});
