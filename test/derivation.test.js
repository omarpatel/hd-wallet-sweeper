import test from "node:test";
import assert from "node:assert/strict";
import { HDNodeWallet, Mnemonic } from "ethers";
import { PRESET_PATHS, parseSeed, deriveAll } from "../sweep.js";
import { PATHS, parseKeyInput, deriveSlip10, deriveAccounts } from "../solana-sweep.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = Mnemonic.fromPhrase(MNEMONIC).computeSeed();
const NOWHERE = "0x0000000000000000000000000000000000000000";

test("EVM MetaMask path index 0 matches the well-known test-mnemonic address", () => {
  const root = HDNodeWallet.fromSeed(parseSeed(SEED));
  const [first] = deriveAll(root, [PRESET_PATHS.metamask], 1, NOWHERE);
  assert.equal(first.path, "m/44'/60'/0'/0/0");
  assert.equal(first.wallet.address, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
});

test("deriveAll skips the destination and de-duplicates across paths", () => {
  const root = HDNodeWallet.fromSeed(parseSeed(SEED));
  const dest = root.derivePath("m/44'/60'/0'/0/1").address;
  const accounts = deriveAll(root, [PRESET_PATHS.metamask, PRESET_PATHS.metamask], 3, dest);
  assert.deepEqual(accounts.map((a) => a.path), ["m/44'/60'/0'/0/0", "m/44'/60'/0'/0/2"]);
});

test("ledger-live and ledger-legacy templates put the index in the right component", () => {
  const root = HDNodeWallet.fromSeed(parseSeed(SEED));
  const paths = deriveAll(root, [PRESET_PATHS["ledger-live"], PRESET_PATHS["ledger-legacy"]], 2, NOWHERE).map((a) => a.path);
  assert.deepEqual(paths, ["m/44'/60'/0'/0/0", "m/44'/60'/1'/0/0", "m/44'/60'/0'/0", "m/44'/60'/0'/1"]);
});

test("SLIP-10 ed25519 derivation matches the spec's test vector 1", () => {
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const cases = {
    "m/0'": "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    "m/0'/1'/2'/2'/1000000000'": "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
  };
  for (const [path, priv] of Object.entries(cases)) {
    assert.equal(Buffer.from(deriveSlip10(seed, path).secretKey.subarray(0, 32)).toString("hex"), priv);
  }
});

test("SLIP-10 rejects non-hardened and malformed paths", () => {
  const seed = Buffer.alloc(32, 1);
  assert.throws(() => deriveSlip10(seed, "m/44'/501'/0"), /hardened/);
  assert.throws(() => deriveSlip10(seed, "44'/501'"), /start with m\//);
});

test("parseKeyInput accepts 0x-prefixed hex and 64-number JSON arrays", () => {
  assert.equal(parseKeyInput("0x" + "ab".repeat(32)).toString("hex"), "ab".repeat(32));
  const arr = Array.from({ length: 64 }, (_, i) => i);
  assert.deepEqual([...parseKeyInput(JSON.stringify(arr))], arr);
});

test("deriveAccounts direct mode uses a 32-byte key as the Solana seed", () => {
  const bytes = Buffer.alloc(32, 7);
  const accounts = deriveAccounts(bytes, { modes: ["direct"], paths: [PATHS.phantom], count: 1 });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].label, "direct 32-byte key");
  assert.deepEqual([...accounts[0].keypair.secretKey.subarray(0, 32)], [...bytes]);
});

test("deriveAccounts raw mode expands every template and index", () => {
  const accounts = deriveAccounts(Buffer.alloc(64, 3), { modes: ["raw"], paths: [PATHS.phantom, PATHS.ledger], count: 2 });
  assert.deepEqual(accounts.map((a) => a.label), [
    "raw m/44'/501'/0'/0'",
    "raw m/44'/501'/1'/0'",
    "raw m/44'/501'/0'",
    "raw m/44'/501'/1'",
  ]);
});
