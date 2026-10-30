#!/usr/bin/env node
// Sweep everything from every address derived from a BIP32/BIP39 seed into one
// destination address: the native coin (ETH, BNB, POL, ...) and, with --tokens,
// every ERC-20 token balance first.
//
// Dry run by default: scans and prints what would be sent. Nothing is
// broadcast unless --send is given AND you type SWEEP at the confirmation.
//
// The seed is read from the SEED_HEX environment variable or a hidden prompt.
// It is never accepted as a command-line argument (would land in shell history).

import { parseArgs } from "node:util";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import {
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  getAddress,
  getBytes,
  parseEther,
} from "ethers";

const PRESET_PATHS = {
  // MetaMask, Trezor, Rabby, most libraries and scripts
  metamask: "m/44'/60'/0'/0/{i}",
  // Ledger Live
  "ledger-live": "m/44'/60'/{i}'/0/0",
  // Ledger legacy / MyEtherWallet
  "ledger-legacy": "m/44'/60'/0'/{i}",
};

const ERC20 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// Headroom on estimated gas limits. On Arbitrum-based chains the limit includes
// an L1 data component that moves with L1 prices; unused gas is refunded.
const GAS_LIMIT_BUFFER_PCT = 20n;

const USAGE = `
Usage:
  node sweep.js --rpc <url> --to <address> [options]

Required:
  --rpc <url>           JSON-RPC endpoint of the chain (or env RPC_URL)
  --to <address>        Destination address that receives everything

Options:
  --tokens              Also sweep ERC-20 tokens (before the native coin). Token
                        wallets get gas topped up from the gas wallet (index 0 of
                        the first path); you are told how much ETH to send there.
  --token <address>     Token contract to sweep; repeatable. Without it, tokens are
                        discovered automatically (needs an Alchemy RPC).
  --count <n>           Indexes to scan per path            (default 250)
  --paths <list>        Comma list of presets to scan        (default all)
                        presets: ${Object.keys(PRESET_PATHS).join(", ")}
  --path <template>     Extra custom path, {i} = index; repeatable
                        e.g. --path "m/44'/60'/1'/0/{i}"
  --min <amount>        Skip native sweeps netting less than this (default 0)
  --fee-bump <pct>      Gas price headroom over current base fee (default 25)
  --concurrency <n>     Parallel RPC requests                (default 5)
  --send                Actually broadcast (otherwise dry run)
  --yes                 Skip the typed SWEEP confirmation (only with --send)
  -h, --help

Seed input:
  Set SEED_HEX in the environment, or you will be prompted (input hidden).
`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      to: { type: "string" },
      tokens: { type: "boolean", default: false },
      token: { type: "string", multiple: true, default: [] },
      count: { type: "string", default: "250" },
      paths: { type: "string" },
      path: { type: "string", multiple: true, default: [] },
      min: { type: "string", default: "0" },
      "fee-bump": { type: "string", default: "25" },
      concurrency: { type: "string", default: "5" },
      send: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const rpc = values.rpc ?? process.env.RPC_URL;
  if (!rpc) fail("--rpc is required (or set RPC_URL)");
  if (!values.to) fail("--to is required");

  let to;
  try {
    to = getAddress(values.to);
  } catch {
    fail(`invalid destination address: ${values.to}`);
  }

  const tokenList = values.token.map((t) => {
    try {
      return getAddress(t);
    } catch {
      fail(`invalid --token address: ${t}`);
    }
  });
  if (tokenList.length && !values.tokens) fail("--token requires --tokens");

  const count = Number.parseInt(values.count, 10);
  if (!Number.isInteger(count) || count < 1) fail("--count must be a positive integer");

  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");

  const feeBump = Number.parseInt(values["fee-bump"], 10);
  if (!Number.isInteger(feeBump) || feeBump < 0) fail("--fee-bump must be a non-negative integer");

  let minWei;
  try {
    minWei = parseEther(values.min);
  } catch {
    fail(`invalid --min amount: ${values.min}`);
  }

  const presetNames = values.paths
    ? values.paths.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(PRESET_PATHS);
  const templates = [];
  for (const name of presetNames) {
    if (!PRESET_PATHS[name]) fail(`unknown path preset "${name}"`);
    templates.push(PRESET_PATHS[name]);
  }
  for (const t of values.path) {
    if (!t.startsWith("m/") || !t.includes("{i}")) fail(`custom path must start with m/ and contain {i}: ${t}`);
    templates.push(t);
  }
  if (templates.length === 0) fail("no derivation paths selected");

  return {
    rpc,
    to,
    tokens: values.tokens,
    tokenList,
    count,
    concurrency,
    feeBump,
    minWei,
    templates,
    send: values.send,
    yes: values.yes,
  };
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(question);
      rl._writeToOutput = () => {};
      rl.question("", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

function parseSeed(raw) {
  const hex = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    fail("seed must be hex (optionally 0x-prefixed)");
  }
  const bytes = getBytes("0x" + hex);
  // BIP32 allows 16..64 byte seeds; a BIP39 seed is 64 bytes (128 hex chars).
  if (bytes.length < 16 || bytes.length > 64) {
    fail(`seed is ${bytes.length} bytes; expected 16-64 (a BIP39 seed is 64 bytes / 128 hex chars)`);
  }
  if (bytes.length !== 64) {
    console.warn(`warning: seed is ${bytes.length} bytes; a BIP39 seed is normally 64 bytes`);
  }
  return bytes;
}

async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let n = 0; n < attempts; n++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** n));
    }
  }
  throw lastErr;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function deriveAll(root, templates, count, destination) {
  const byAddress = new Map();
  for (const template of templates) {
    for (let i = 0; i < count; i++) {
      const path = template.replaceAll("{i}", String(i));
      const wallet = root.derivePath(path);
      if (wallet.address === destination) continue;
      if (!byAddress.has(wallet.address)) byAddress.set(wallet.address, { path, wallet });
    }
  }
  return [...byAddress.values()];
}

async function pricing(provider, feeBump) {
  const [block, feeData] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
  if (block?.baseFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
    // EIP-1559: setting maxFeePerGas == maxPriorityFeePerGas makes the effective
    // price exactly `price`, so the fee is known up front and the address ends at 0.
    const base = block.baseFeePerGas;
    const price = (base * BigInt(100 + feeBump)) / 100n + feeData.maxPriorityFeePerGas;
    return { price, txFields: { type: 2, maxFeePerGas: price, maxPriorityFeePerGas: price } };
  }
  if (feeData.gasPrice == null) fail("RPC returned no gas price");
  const price = (feeData.gasPrice * BigInt(100 + feeBump)) / 100n;
  return { price, txFields: { type: 0, gasPrice: price } };
}

const withBuffer = (gas) => (gas * (100n + GAS_LIMIT_BUFFER_PCT)) / 100n;
const errText = (err) => err.shortMessage ?? err.message ?? String(err);

async function confirm(opts, network, summary) {
  if (opts.yes) return true;
  const answer = await ask(`\n${summary} to ${opts.to} on chainId ${network.chainId}? Type SWEEP to continue: `);
  if (answer.trim() === "SWEEP") return true;
  console.log("aborted.");
  return false;
}

// Returns [{ token, amount }] with non-zero balances for `owner`.
async function tokenBalances(provider, owner, tokenList) {
  if (tokenList.length) {
    const out = [];
    for (const token of tokenList) {
      const raw = await provider.call({ to: token, data: ERC20.encodeFunctionData("balanceOf", [owner]) });
      const [amount] = ERC20.decodeFunctionResult("balanceOf", raw);
      if (amount > 0n) out.push({ token, amount });
    }
    return out;
  }
  const out = [];
  let pageKey;
  do {
    const res = await provider.send("alchemy_getTokenBalances", [owner, "erc20", ...(pageKey ? [{ pageKey }] : [])]);
    for (const t of res.tokenBalances) {
      const amount = t.tokenBalance ? BigInt(t.tokenBalance) : 0n;
      if (amount > 0n) out.push({ token: getAddress(t.contractAddress), amount });
    }
    pageKey = res.pageKey;
  } while (pageKey);
  return out;
}

async function tokenMeta(provider, token) {
  const read = async (fn, fallback) => {
    try {
      const raw = await provider.call({ to: token, data: ERC20.encodeFunctionData(fn) });
      return ERC20.decodeFunctionResult(fn, raw)[0];
    } catch {
      return fallback;
    }
  };
  return { symbol: await read("symbol", "?"), decimals: Number(await read("decimals", 18n)) };
}

async function sweepTokens(ctx) {
  const { provider, network, opts, accounts, gasWallet } = ctx;

  if (!opts.tokenList.length) {
    try {
      await provider.send("alchemy_getTokenBalances", [gasWallet.address, "erc20"]);
    } catch {
      fail("this RPC cannot discover tokens automatically; use an Alchemy RPC or pass --token <address>");
    }
  }

  console.log(`\n== tokens ==\nchecking token balances of ${accounts.length} addresses...`);
  const perAccount = await mapPool(accounts, opts.concurrency, (a) =>
    withRetry(() => tokenBalances(provider, a.wallet.address, opts.tokenList)),
  );
  const holdings = accounts.flatMap((account, i) => perAccount[i].map((h) => ({ account, ...h })));
  if (holdings.length === 0) {
    console.log("no token balances found.");
    return { results: [], ready: true };
  }

  const meta = new Map();
  for (const token of new Set(holdings.map((h) => h.token))) meta.set(token, await tokenMeta(provider, token));
  const label = (h) => `${formatUnits(h.amount, meta.get(h.token).decimals)} ${meta.get(h.token).symbol}`;

  // Simulating from the holder with no gas price set works even when it has 0 ETH.
  // A revert means the token refuses the transfer (paused, blacklisted, honeypot);
  // returning false means it would "succeed" without moving anything. Tokens that
  // return no data at all (old USDT style) are fine.
  await mapPool(holdings, opts.concurrency, async (h) => {
    h.data = ERC20.encodeFunctionData("transfer", [opts.to, h.amount]);
    const call = { from: h.account.wallet.address, to: h.token, data: h.data };
    try {
      const ret = await withRetry(() => provider.call(call), 2);
      if (ret !== "0x" && !ERC20.decodeFunctionResult("transfer", ret)[0]) {
        h.error = "transfer returns false";
        return;
      }
      h.gasLimit = withBuffer(await withRetry(() => provider.estimateGas(call), 2));
    } catch (err) {
      h.error = errText(err);
    }
  });
  const movable = holdings.filter((h) => h.gasLimit);
  const blocked = holdings.filter((h) => !h.gasLimit);

  const { price, txFields } = await pricing(provider, opts.feeBump);

  const groups = new Map();
  for (const h of movable) {
    const key = h.account.wallet.address;
    if (!groups.has(key)) groups.set(key, { account: h.account, holdings: [], need: 0n });
    const g = groups.get(key);
    g.holdings.push(h);
    g.need += h.gasLimit * price;
  }
  const groupList = [...groups.values()];
  const ethBalances = await mapPool(groupList, opts.concurrency, (g) =>
    withRetry(() => provider.getBalance(g.account.wallet.address)),
  );

  const gasWalletBalance = await withRetry(() => provider.getBalance(gasWallet.address));
  const fundGasLimit = withBuffer(
    await withRetry(() => provider.estimateGas({ from: gasWallet.address, to: opts.to, value: 1n })),
  );
  const topUps = [];
  let gasWalletNeed = 0n;
  groupList.forEach((g, i) => {
    if (g.account.wallet.address === gasWallet.address) {
      gasWalletNeed += g.need;
      return;
    }
    const deficit = g.need - ethBalances[i];
    if (deficit > 0n) topUps.push({ group: g, amount: deficit });
  });
  gasWalletNeed += topUps.reduce((s, t) => s + t.amount + fundGasLimit * price, 0n);

  console.log("\nTOKENS".padEnd(9) + "path".padEnd(24) + "address".padEnd(44) + "amount");
  for (const h of movable) console.log("".padEnd(8) + h.account.path.padEnd(24) + h.account.wallet.address.padEnd(44) + label(h));
  if (blocked.length) {
    console.log(`\nCANNOT MOVE (token rejects the transfer): ${blocked.length}`);
    for (const h of blocked) {
      console.log("".padEnd(8) + h.account.path.padEnd(24) + h.account.wallet.address.padEnd(44) + `${label(h)}  (${h.error})`);
    }
  }
  console.log(`\ntoken transfers: ${movable.length} from ${groupList.length} wallets   gas top-ups: ${topUps.length}`);
  console.log(`gas wallet ${gasWallet.address} (${gasWallet.path})`);
  console.log(`  needs ${formatEther(gasWalletNeed)} ETH, has ${formatEther(gasWalletBalance)} ETH`);

  if (movable.length === 0) return { results: [], ready: true };

  const shortfall = gasWalletNeed - gasWalletBalance;
  if (shortfall > 0n) {
    // 20% margin so a small gas price rise before the re-run doesn't fall short again.
    const required = withBuffer(shortfall);
    console.log(`\n>>> send at least ${formatEther(required)} ETH to ${gasWallet.address} on chainId ${network.chainId}, then re-run.`);
    console.log("    whatever is not used for gas is swept to the destination at the end.");
    return { results: [], ready: false };
  }
  if (!opts.send) {
    console.log("\ndry run only. Re-run with --send to broadcast.");
    return { results: [], ready: true };
  }
  if (!(await confirm(opts, network, `Send ${topUps.length} gas top-ups and ${movable.length} token transfers`))) {
    return { results: [], ready: false, aborted: true };
  }
  opts.yes = true; // one confirmation covers the native sweep that follows

  const gasSigner = gasWallet.wallet.connect(provider);
  if (topUps.length) {
    let nonce = await withRetry(() => provider.getTransactionCount(gasWallet.address, "pending"));
    const sent = [];
    for (const t of topUps) {
      const tx = await gasSigner.sendTransaction({
        to: t.group.account.wallet.address,
        value: t.amount,
        gasLimit: fundGasLimit,
        nonce: nonce++,
        chainId: network.chainId,
        ...txFields,
      });
      sent.push(tx);
    }
    const receipts = await Promise.all(sent.map((tx) => tx.wait()));
    const bad = receipts.filter((r) => r?.status !== 1).length;
    console.log(`gas top-ups confirmed: ${receipts.length - bad}/${receipts.length}`);
    if (bad) fail("some gas top-ups failed; re-run to retry");
  }

  const perGroup = await mapPool(groupList, opts.concurrency, async (g) => {
    const signer = g.account.wallet.connect(provider);
    const address = g.account.wallet.address;
    const out = [];
    let nonce = await withRetry(() => provider.getTransactionCount(address, "pending"));
    for (const h of g.holdings) {
      const base = { path: g.account.path, address, token: h.token, symbol: meta.get(h.token).symbol, amount: h.amount.toString() };
      try {
        const tx = await signer.sendTransaction({
          to: h.token,
          data: h.data,
          gasLimit: h.gasLimit,
          nonce,
          chainId: network.chainId,
          ...txFields,
        });
        nonce++;
        const receipt = await tx.wait();
        const ok = receipt?.status === 1;
        console.log(`${ok ? "mined " : "FAILED"}  ${address}  ${label(h)}  ${tx.hash}`);
        out.push({ ...base, hash: tx.hash, status: ok ? "confirmed" : "reverted" });
      } catch (err) {
        console.log(`ERROR   ${address}  ${label(h)}  ${errText(err)}`);
        out.push({ ...base, status: "error", error: errText(err) });
      }
    }
    return out;
  });
  const results = perGroup.flat();

  // A confirmed transfer() can still move nothing (tokens that return false), so check.
  const remaining = await mapPool(movable, opts.concurrency, async (h) => {
    const raw = await withRetry(() =>
      provider.call({ to: h.token, data: ERC20.encodeFunctionData("balanceOf", [h.account.wallet.address]) }),
    );
    return ERC20.decodeFunctionResult("balanceOf", raw)[0];
  });
  const notMoved = movable.filter((_, i) => remaining[i] > 0n);
  console.log(`\ntoken transfers confirmed: ${results.filter((r) => r.status === "confirmed").length}/${movable.length}`);
  if (notMoved.length) {
    console.log(`still holding tokens after transfer: ${notMoved.length}`);
    for (const h of notMoved) console.log("".padEnd(8) + h.account.wallet.address.padEnd(44) + meta.get(h.token).symbol);
  }
  return { results, ready: true };
}

async function sweepNative(ctx) {
  const { provider, network, opts, accounts } = ctx;

  console.log(`\n== native coin ==\nchecking ${accounts.length} addresses...`);
  let done = 0;
  const balances = await mapPool(accounts, opts.concurrency, async (a) => {
    const bal = await withRetry(() => provider.getBalance(a.wallet.address));
    if (++done % 50 === 0 || done === accounts.length) process.stdout.write(`  ${done}/${accounts.length}\r`);
    return bal;
  });
  process.stdout.write("\n");

  const funded = accounts.map((a, i) => ({ ...a, balance: balances[i] })).filter((a) => a.balance > 0n);
  if (funded.length === 0) {
    console.log("no funded addresses found. If you expected funds, the wallets likely use a different");
    console.log("derivation path: pass it with --path, or raise --count.");
    return [];
  }

  const gasLimit = await withRetry(() =>
    provider.estimateGas({ from: funded[0].wallet.address, to: opts.to, value: 1n }),
  );
  const { price, txFields } = await pricing(provider, opts.feeBump);
  const fee = gasLimit * price;

  const plan = [];
  const dust = [];
  for (const a of funded) {
    const value = a.balance - fee;
    if (value > 0n && value >= opts.minWei) plan.push({ ...a, value });
    else dust.push(a);
  }

  console.log(`\nfee per transfer: ${formatEther(fee)} (gas ${gasLimit} @ ${price} wei)\n`);
  console.log("SWEEP".padEnd(8) + "path".padEnd(24) + "address".padEnd(44) + "balance -> sends");
  for (const a of plan) {
    console.log(
      "".padEnd(8) + a.path.padEnd(24) + a.wallet.address.padEnd(44) + `${formatEther(a.balance)} -> ${formatEther(a.value)}`,
    );
  }
  if (dust.length) {
    console.log(`\nSKIPPED (balance <= fee or below --min): ${dust.length}`);
    for (const a of dust) console.log("".padEnd(8) + a.path.padEnd(24) + a.wallet.address.padEnd(44) + formatEther(a.balance));
  }

  const totalFound = funded.reduce((s, a) => s + a.balance, 0n);
  const totalSent = plan.reduce((s, a) => s + a.value, 0n);
  console.log(`\nfunded addresses: ${funded.length}   total found: ${formatEther(totalFound)}`);
  console.log(`transfers: ${plan.length}   total fees: ${formatEther(fee * BigInt(plan.length))}   destination receives: ${formatEther(totalSent)}`);

  if (!opts.send) {
    console.log("\ndry run only. Re-run with --send to broadcast.");
    return [];
  }
  if (plan.length === 0) return [];
  if (!(await confirm(opts, network, `Broadcast ${plan.length} transfers`))) return [];

  // Each transfer comes from a different address, so they are independent.
  return mapPool(plan, opts.concurrency, async (a) => {
    const signer = a.wallet.connect(provider);
    try {
      const nonce = await withRetry(() => provider.getTransactionCount(a.wallet.address, "pending"));
      const tx = await signer.sendTransaction({
        to: opts.to,
        value: a.value,
        gasLimit,
        nonce,
        chainId: network.chainId,
        ...txFields,
      });
      console.log(`sent    ${a.wallet.address}  ${formatEther(a.value)}  ${tx.hash}`);
      const receipt = await tx.wait();
      const ok = receipt?.status === 1;
      console.log(`${ok ? "mined " : "FAILED"}  ${a.wallet.address}  ${tx.hash}`);
      return { path: a.path, address: a.wallet.address, value: a.value.toString(), hash: tx.hash, status: ok ? "confirmed" : "reverted" };
    } catch (err) {
      console.log(`ERROR   ${a.wallet.address}  ${errText(err)}`);
      return { path: a.path, address: a.wallet.address, value: a.value.toString(), status: "error", error: errText(err) };
    }
  });
}

async function main() {
  const opts = parseCli();

  // cacheTimeout -1: ethers otherwise reuses identical reads for 250ms, which returns
  // stale nonces/balances right after our own transactions on fast chains.
  const provider = new JsonRpcProvider(opts.rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const network = await withRetry(() => provider.getNetwork());
  console.log(`chain: ${network.name} (chainId ${network.chainId})`);
  console.log(`destination: ${opts.to}`);

  const seed = parseSeed(process.env.SEED_HEX ?? (await ask("Seed hex (input hidden): ", { hidden: true })));
  const root = HDNodeWallet.fromSeed(seed);

  console.log(`deriving ${opts.count} indexes x ${opts.templates.length} path(s)...`);
  const accounts = deriveAll(root, opts.templates, opts.count, opts.to);
  for (const t of opts.templates) {
    const first = accounts.find((a) => a.path === t.replaceAll("{i}", "0"));
    if (first) console.log(`  ${t.padEnd(22)} index 0 = ${first.wallet.address}`);
  }
  const gasPath = opts.templates[0].replaceAll("{i}", "0");
  const gasWallet = { path: gasPath, wallet: root.derivePath(gasPath), address: root.derivePath(gasPath).address };
  if (gasWallet.address === opts.to) fail("destination is the gas wallet (index 0 of the first path); pick another destination");

  const ctx = { provider, network, opts, accounts, gasWallet };
  const report = { chainId: network.chainId.toString(), destination: opts.to, tokens: [], native: [] };

  if (opts.tokens) {
    const t = await sweepTokens(ctx);
    report.tokens = t.results;
    // Don't drain the native coin while token transfers still need it for gas.
    if (!t.ready) {
      if (t.aborted) return;
      process.exitCode = 1;
      return;
    }
  }
  report.native = await sweepNative(ctx);

  const all = [...report.tokens, ...report.native];
  if (all.length === 0) return;
  const failed = all.filter((r) => r.status !== "confirmed");
  const reportFile = `sweep-report-${Date.now()}.json`;
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nconfirmed: ${all.length - failed.length}   failed: ${failed.length}   report: ${reportFile}`);
  if (failed.length) {
    console.log("re-run the same command to retry; already-emptied addresses are skipped automatically.");
    process.exitCode = 1;
  }
}

export { PRESET_PATHS, parseSeed, deriveAll };

// Run only as a CLI, so tests can import the helpers above.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(errText(err));
    process.exit(1);
  });
}
