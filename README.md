# hd-wallet-sweeper

Two command-line tools for recovering funds spread across many addresses derived from one seed or key. Each one derives the addresses, checks their balances, and moves everything to a single destination.

- `sweep.js` handles EVM chains: the native coin (ETH, BNB, POL and so on) and, with `--tokens`, ERC-20 balances.
- `solana-sweep.js` handles Solana: SOL and, with `--tokens`, SPL and Token-2022 balances. It closes the emptied token accounts so their rent comes back as SOL.

Both tools only report what they would do unless you pass `--send`, and even then they ask you to type `SWEEP` before broadcasting (`--yes` skips that prompt).

## How derivation works

**EVM** (`sweep.js`) takes a BIP32 seed as hex (a BIP39 seed is 64 bytes). It expands one or more path templates, replacing `{i}` with 0 to `--count - 1`:

| Preset | Template | Used by |
| --- | --- | --- |
| `metamask` | `m/44'/60'/0'/0/{i}` | MetaMask, Trezor, Rabby, most libraries |
| `ledger-live` | `m/44'/60'/{i}'/0/0` | Ledger Live |
| `ledger-legacy` | `m/44'/60'/0'/{i}` | Ledger legacy, MyEtherWallet |

Add your own with `--path "m/44'/60'/1'/0/{i}"`. Duplicate addresses and the destination itself are skipped. Index 0 of the first path pays gas for token transfers, so tokens are swept before the native coin.

**Solana** (`solana-sweep.js`) derives Ed25519 keys with SLIP-10 (hardened paths only) and tries the input in up to three ways, set with `--modes`:

- `raw`: the hex is the SLIP-10 seed.
- `entropy`: the hex is BIP39 entropy (16 to 32 bytes); it is turned into a mnemonic and then a seed.
- `direct`: the hex is a 32-byte Solana seed or a 64-byte secret key.

Path presets are `phantom` (`m/44'/501'/{i}'/0'`), `ledger` (`m/44'/501'/{i}'`) and `sollet` (`m/44'/501'/0'/{i}'`).

## Getting started

Requires Node.js 20 or newer.

```bash
npm install

# EVM: scan only
RPC_URL=https://your-rpc node sweep.js --to 0xYourDestination --tokens

# Solana: scan only
node solana-sweep.js --to YourDestinationAddress --tokens

# Broadcast after checking the dry-run output
node sweep.js --to 0xYourDestination --tokens --send
```

Run either script with `--help` for every option (`--count`, `--min`, `--fee-bump`, `--concurrency` and others).

Secrets are never accepted as command-line arguments, since those end up in shell history. Set them in the environment or type them at the hidden prompt:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `RPC_URL` | `sweep.js` | EVM JSON-RPC endpoint (or `--rpc`) |
| `SEED_HEX` | `sweep.js` | BIP32 seed in hex |
| `SOLANA_RPC_URL` | `solana-sweep.js` | Solana RPC endpoint, default public mainnet |
| `SOLANA_KEY_HEX` | `solana-sweep.js` | Source key as hex (the prompt also accepts a 64-number JSON keypair) |
| `HELIUS_API_KEY` | `solana-sweep.js` | Only with `--helius`, which uses a Helius RPC endpoint |

After a run that sends anything, each tool writes a JSON report (`sweep-report-<timestamp>.json` or `solana-sweep-report-<timestamp>.json`) listing every transfer and its status. Re-running the same command retries failures; addresses that are already empty are skipped.

## Tests

```bash
npm test
```

The tests check derivation against known vectors (the standard test mnemonic's first MetaMask address and SLIP-10 test vector 1), path template expansion, key input parsing, and that both CLIs reject bad destinations and paths before any network call. They need no RPC access.

## Disclaimer

These tools move real funds. Run a dry run first and check the destination address. Use at your own risk.

## License

MIT
