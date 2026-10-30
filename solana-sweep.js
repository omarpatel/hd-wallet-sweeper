#!/usr/bin/env node
// Sweep SOL and optionally all SPL / Token-2022 balances from addresses derived
// from a hex key into one Solana address. Dry-run unless --send is supplied.
// The key is accepted only through SOLANA_KEY_HEX or a hidden prompt.

import { createHmac } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { Mnemonic } from "ethers";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const PATHS = {
  phantom: "m/44'/501'/{i}'/0'",
  ledger: "m/44'/501'/{i}'",
  sollet: "m/44'/501'/0'/{i}'",
};

const USAGE = `
Usage:
  node solana-sweep.js --to <solana-address> [options]

Required:
  --to <address>          Destination Solana address

Options:
  --rpc <url>             Solana RPC (or env SOLANA_RPC_URL)
                          default: https://api.mainnet-beta.solana.com
  --helius                Prompt invisibly for a Helius API key
  --tokens                Sweep SPL and Token-2022 balances, then close source
                          token accounts to recover their rent as SOL
  --count <n>             Indexes scanned per path              (default 250)
  --paths <list>          phantom,ledger,sollet                  (default all)
  --path <template>       Extra hardened path with {i}; repeatable
                          e.g. --path "m/44'/501'/2'/{i}'"
  --modes <list>          raw,entropy,direct                     (default all)
                          raw: hex is the BIP32/SLIP-10 seed
                          entropy: hex is BIP39 entropy
                          direct: hex is a 32/64-byte Solana secret key
  --concurrency <n>       Parallel token-account RPC requests   (default 3)
  --send                  Broadcast; otherwise preview only
  --yes                   Skip typed SWEEP confirmation
  -h, --help

Key input:
  Set SOLANA_KEY_HEX, or enter the key at the hidden prompt. The prompt accepts
  hex or a standard 64-number Solana JSON keypair array. Never put a key in a
  command-line argument because command lines are stored in shell history.
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      helius: { type: "boolean", default: false },
      to: { type: "string" },
      tokens: { type: "boolean", default: false },
      count: { type: "string", default: "250" },
      paths: { type: "string" },
      path: { type: "string", multiple: true, default: [] },
      modes: { type: "string", default: "raw,entropy,direct" },
      concurrency: { type: "string", default: "3" },
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
  if (!values.to) fail("--to is required");
  if (values.helius && values.rpc) fail("--helius and --rpc cannot be used together");

  let destination;
  try {
    destination = new PublicKey(values.to);
  } catch {
    fail(`invalid Solana destination address: ${values.to}`);
  }

  const count = Number.parseInt(values.count, 10);
  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!Number.isInteger(count) || count < 1) fail("--count must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");

  const names = values.paths
    ? values.paths.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(PATHS);
  const paths = [];
  for (const name of names) {
    if (!PATHS[name]) fail(`unknown path preset: ${name}`);
    paths.push(PATHS[name]);
  }
  for (const path of values.path) {
    if (!path.startsWith("m/") || !path.includes("{i}")) fail(`custom path must start with m/ and contain {i}: ${path}`);
    paths.push(path);
  }
  if (!paths.length) fail("no paths selected");

  const modes = values.modes.split(",").map((s) => s.trim()).filter(Boolean);
  for (const mode of modes) if (!["raw", "entropy", "direct"].includes(mode)) fail(`unknown key mode: ${mode}`);
  if (!modes.length) fail("no key modes selected");

  return {
    rpc: values.rpc ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    helius: values.helius,
    destination,
    tokens: values.tokens,
    count,
    concurrency,
    paths,
    modes,
    send: values.send,
    yes: values.yes,
  };
}

function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(`${question}\n`);
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

function parseKeyInput(raw) {
  const value = raw.trim();
  if (value.startsWith("[")) {
    let bytes;
    try {
      bytes = JSON.parse(value);
    } catch {
      fail("JSON keypair must be a valid array");
    }
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      fail("JSON keypair must contain exactly 64 integers from 0 to 255");
    }
    return Buffer.from(bytes);
  }

  const hex = value.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) fail("key must be hexadecimal or a 64-number JSON array");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 16 || bytes.length > 64) fail("hex key must be 16-64 bytes (32-128 hex characters)");
  return bytes;
}

function deriveSlip10(seed, path) {
  let digest = createHmac("sha512", "ed25519 seed").update(seed).digest();
  let key = digest.subarray(0, 32);
  let chainCode = digest.subarray(32);
  const parts = path.split("/");
  if (parts.shift() !== "m") throw new Error(`path must start with m/: ${path}`);
  for (const part of parts) {
    if (!/^\d+'$/.test(part)) throw new Error(`ed25519 path components must be hardened: ${path}`);
    const index = Number.parseInt(part, 10);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error(`invalid path index: ${part}`);
    const data = Buffer.allocUnsafe(37);
    data[0] = 0;
    key.copy(data, 1);
    data.writeUInt32BE(index + 0x80000000, 33);
    digest = createHmac("sha512", chainCode).update(data).digest();
    key = digest.subarray(0, 32);
    chainCode = digest.subarray(32);
  }
  return Keypair.fromSeed(key);
}

function deriveAccounts(bytes, opts) {
  const byAddress = new Map();
  const add = (keypair, label) => {
    const address = keypair.publicKey.toBase58();
    if (!byAddress.has(address)) byAddress.set(address, { keypair, label });
  };

  if (opts.modes.includes("direct")) {
    if (bytes.length === 32) add(Keypair.fromSeed(bytes), "direct 32-byte key");
    if (bytes.length === 64) {
      try {
        add(Keypair.fromSecretKey(bytes), "direct 64-byte keypair");
      } catch {
        console.warn("warning: 64-byte value is not a valid Solana secret-key/public-key pair; direct mode skipped");
      }
    }
  }

  const seeds = [];
  if (opts.modes.includes("raw")) seeds.push(["raw", bytes]);
  if (opts.modes.includes("entropy") && [16, 20, 24, 28, 32].includes(bytes.length)) {
    const mnemonicSeed = Mnemonic.fromEntropy(bytes).computeSeed();
    seeds.push(["entropy", Buffer.from(mnemonicSeed.slice(2), "hex")]);
  }
  for (const [mode, seed] of seeds) {
    for (const template of opts.paths) {
      for (let i = 0; i < opts.count; i++) {
        const path = template.replaceAll("{i}", String(i));
        add(deriveSlip10(seed, path), `${mode} ${path}`);
      }
    }
  }
  return [...byAddress.values()];
}

async function retry(fn, attempts = 5) {
  let last;
  for (let n = 0; n < attempts; n++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const wait = Math.min(8000, 500 * 2 ** n);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

async function mapPool(items, concurrency, fn) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

async function getAccountInfos(connection, keys) {
  const output = [];
  for (let i = 0; i < keys.length; i += 100) {
    output.push(...await retry(() => connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  }
  return output;
}

async function findTokenAccounts(connection, account) {
  const query = async (programId) => {
    const response = await retry(() => connection.getTokenAccountsByOwner(account.keypair.publicKey, { programId }, "confirmed"));
    return response.value.map(({ pubkey, account: info }) => {
      const decoded = AccountLayout.decode(info.data);
      return {
        source: pubkey,
        owner: account,
        mint: new PublicKey(decoded.mint),
        amount: BigInt(decoded.amount.toString()),
        programId,
        lamports: info.lamports,
        dataLength: info.data.length,
      };
    });
  };
  const [classic, token2022] = await Promise.all([query(TOKEN_PROGRAM_ID), query(TOKEN_2022_PROGRAM_ID)]);
  return [...classic, ...token2022];
}

function formatSol(lamports) {
  const whole = BigInt(lamports) / BigInt(LAMPORTS_PER_SOL);
  const fraction = (BigInt(lamports) % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function uniqueSigners(signers) {
  return [...new Map(signers.map((signer) => [signer.publicKey.toBase58(), signer])).values()];
}

async function currentFee(connection, destination, oneSigner, secondSigner) {
  const { blockhash } = await retry(() => connection.getLatestBlockhash("confirmed"));
  const one = new Transaction({ recentBlockhash: blockhash, feePayer: oneSigner.publicKey }).add(
    SystemProgram.transfer({ fromPubkey: oneSigner.publicKey, toPubkey: destination, lamports: 0 }),
  );
  const two = new Transaction({ recentBlockhash: blockhash, feePayer: oneSigner.publicKey }).add(
    SystemProgram.transfer({ fromPubkey: secondSigner.publicKey, toPubkey: destination, lamports: 0 }),
  );
  const [fee1, fee2] = await Promise.all([
    retry(() => connection.getFeeForMessage(one.compileMessage(), "confirmed")),
    retry(() => connection.getFeeForMessage(two.compileMessage(), "confirmed")),
  ]);
  if (fee1.value == null || fee2.value == null) fail("RPC did not return transaction fees");
  return { one: fee1.value, two: fee2.value };
}

async function sendTransaction(connection, instructions, feePayer, signers) {
  const latest = await retry(() => connection.getLatestBlockhash("confirmed"));
  const transaction = new Transaction({
    recentBlockhash: latest.blockhash,
    feePayer: feePayer.publicKey,
  });
  transaction.add(...instructions);
  transaction.sign(...uniqueSigners([feePayer, ...signers]));
  const signature = await retry(() => connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  }), 3);
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}

async function confirmSweep(opts, text) {
  if (opts.yes) return true;
  const answer = await prompt(`\n${text} to ${opts.destination.toBase58()}? Type SWEEP to continue: `);
  if (answer.trim() === "SWEEP") return true;
  console.log("aborted.");
  return false;
}

async function main() {
  const opts = parseCli();
  if (opts.helius) {
    const apiKey = (process.env.HELIUS_API_KEY ?? await prompt("Helius API key (input hidden): ", true)).trim();
    if (!apiKey) fail("Helius API key is required");
    opts.rpc = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  }
  const connection = new Connection(opts.rpc, { commitment: "confirmed", disableRetryOnRateLimit: false });
  const genesis = await retry(() => connection.getGenesisHash());
  console.log(`network genesis: ${genesis}`);
  console.log(`destination: ${opts.destination.toBase58()}`);

  const bytes = parseKeyInput(process.env.SOLANA_KEY_HEX ?? await prompt("Solana key (hex or JSON array; input hidden): ", true));
  const derived = deriveAccounts(bytes, opts);
  if (derived.some((account) => account.keypair.publicKey.equals(opts.destination))) {
    fail("destination is controlled by the supplied key; use a destination from a different key");
  }
  const accounts = derived;
  if (!accounts.length) fail("no source accounts derived");
  console.log(`derived ${accounts.length} unique addresses`);
  for (const account of accounts.slice(0, 4)) console.log(`  ${account.label.padEnd(34)} ${account.keypair.publicKey.toBase58()}`);

  console.log("checking SOL balances...");
  const infos = await getAccountInfos(connection, accounts.map((account) => account.keypair.publicKey));
  const funded = accounts.map((account, i) => ({ account, lamports: infos[i]?.lamports ?? 0 })).filter((x) => x.lamports > 0);
  const totalSol = funded.reduce((sum, x) => sum + BigInt(x.lamports), 0n);

  let tokenAccounts = [];
  if (opts.tokens) {
    console.log(`checking SPL and Token-2022 accounts for ${accounts.length} owners...`);
    const perOwner = await mapPool(accounts, opts.concurrency, (account) => findTokenAccounts(connection, account));
    tokenAccounts = perOwner.flat();
  }

  const gasWallet = funded.length
    ? funded.reduce((best, item) => item.lamports > best.lamports ? item : best).account
    : accounts[0];
  const otherSigner = accounts.find((account) => !account.keypair.publicKey.equals(gasWallet.keypair.publicKey)) ?? {
    keypair: Keypair.generate(),
  };
  const fees = await currentFee(connection, opts.destination, gasWallet.keypair, otherSigner.keypair);

  const tokenPlan = [];
  let requiredGas = fees.one;
  let recoverableRent = 0n;
  if (tokenAccounts.length) {
    const destinationAtas = tokenAccounts.map((token) => getAssociatedTokenAddressSync(
      token.mint,
      opts.destination,
      true,
      token.programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
    const ataInfos = await getAccountInfos(connection, destinationAtas);
    const rentBySize = new Map();
    for (const token of tokenAccounts) {
      if (!rentBySize.has(token.dataLength)) {
        rentBySize.set(token.dataLength, await retry(() => connection.getMinimumBalanceForRentExemption(token.dataLength, "confirmed")));
      }
    }
    let maxAtaRent = 0;
    let rentGap = 0;
    let tokenFees = 0;
    tokenAccounts.forEach((token, i) => {
      const destinationAta = destinationAtas[i];
      const createAta = token.amount > 0n && ataInfos[i] == null;
      const ataRent = createAta ? rentBySize.get(token.dataLength) : 0;
      maxAtaRent = Math.max(maxAtaRent, ataRent);
      rentGap += Math.max(0, ataRent - token.lamports);
      tokenFees += token.owner.keypair.publicKey.equals(gasWallet.keypair.publicKey) ? fees.one : fees.two;
      recoverableRent += BigInt(token.lamports);
      tokenPlan.push({ ...token, destinationAta, createAta, ataRent });
    });
    // One destination ATA at a time; successful closes recycle source-account rent.
    // All fees and positive rent-size differences are prepaid so failures cannot strand the run.
    requiredGas += tokenFees + maxAtaRent + rentGap;
  }

  console.log(`\nSOL wallets funded: ${funded.length}   total: ${formatSol(totalSol)} SOL`);
  for (const item of funded) {
    console.log(`  ${item.account.label.padEnd(34)} ${item.account.keypair.publicKey.toBase58()}  ${formatSol(item.lamports)} SOL`);
  }
  if (opts.tokens) {
    console.log(`\ntoken accounts: ${tokenPlan.length}   recoverable source rent: ${formatSol(recoverableRent)} SOL`);
    for (const token of tokenPlan) {
      console.log(`  ${token.owner.keypair.publicKey.toBase58()}  mint ${token.mint.toBase58()}  atomic amount ${token.amount}`);
    }
    console.log(`\ngas wallet: ${gasWallet.keypair.publicKey.toBase58()} (${gasWallet.label})`);
    console.log(`  needs up to ${formatSol(requiredGas)} SOL; has ${formatSol(infos[accounts.indexOf(gasWallet)]?.lamports ?? 0)} SOL`);
  }

  if (!funded.length && !tokenPlan.length) {
    console.log("nothing found. If funds were expected, raise --count or supply the wallet's derivation path with --path.");
    return;
  }
  if (!opts.send) {
    console.log("\ndry run only. Re-run with --send to broadcast.");
    return;
  }

  const gasBalance = infos[accounts.indexOf(gasWallet)]?.lamports ?? 0;
  if (tokenPlan.length && gasBalance < requiredGas) {
    const shortfall = requiredGas - gasBalance;
    const requested = Math.ceil(shortfall * 1.2);
    console.log(`\n>>> send at least ${formatSol(requested)} SOL to ${gasWallet.keypair.publicKey.toBase58()}, then re-run.`);
    console.log("    unused SOL and recovered token-account rent are swept to the destination.");
    process.exitCode = 1;
    return;
  }
  if (!(await confirmSweep(opts, `Sweep ${funded.length} SOL wallets and ${tokenPlan.length} token accounts`))) return;

  const report = {
    genesis,
    destination: opts.destination.toBase58(),
    tokens: [],
    sol: [],
  };

  for (const token of tokenPlan) {
    const instructions = [];
    if (token.amount > 0n) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          gasWallet.keypair.publicKey,
          token.destinationAta,
          opts.destination,
          token.mint,
          token.programId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createTransferInstruction(
          token.source,
          token.destinationAta,
          token.owner.keypair.publicKey,
          token.amount,
          [],
          token.programId,
        ),
      );
    }
    instructions.push(createCloseAccountInstruction(
      token.source,
      gasWallet.keypair.publicKey,
      token.owner.keypair.publicKey,
      [],
      token.programId,
    ));
    const base = {
      owner: token.owner.keypair.publicKey.toBase58(),
      source: token.source.toBase58(),
      mint: token.mint.toBase58(),
      amount: token.amount.toString(),
      program: token.programId.toBase58(),
    };
    try {
      const signature = await sendTransaction(connection, instructions, gasWallet.keypair, [token.owner.keypair]);
      console.log(`token confirmed  ${token.source.toBase58()}  ${signature}`);
      report.tokens.push({ ...base, signature, status: "confirmed" });
    } catch (error) {
      const message = error.message ?? String(error);
      console.log(`token ERROR      ${token.source.toBase58()}  ${message}`);
      report.tokens.push({ ...base, status: "error", error: message });
    }
  }

  // Re-read balances because token-account closures sent rent to the gas wallet.
  const postTokenInfos = await getAccountInfos(connection, accounts.map((account) => account.keypair.publicKey));
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const balance = postTokenInfos[i]?.lamports ?? 0;
    if (balance <= fees.one) continue;
    try {
      const signature = await sendTransaction(connection, [SystemProgram.transfer({
        fromPubkey: account.keypair.publicKey,
        toPubkey: opts.destination,
        lamports: balance - fees.one,
      })], account.keypair, [account.keypair]);
      console.log(`SOL confirmed    ${account.keypair.publicKey.toBase58()}  ${formatSol(balance - fees.one)} SOL  ${signature}`);
      report.sol.push({
        address: account.keypair.publicKey.toBase58(),
        lamports: String(balance - fees.one),
        signature,
        status: "confirmed",
      });
    } catch (error) {
      const message = error.message ?? String(error);
      console.log(`SOL ERROR        ${account.keypair.publicKey.toBase58()}  ${message}`);
      report.sol.push({ address: account.keypair.publicKey.toBase58(), lamports: String(balance - fees.one), status: "error", error: message });
    }
  }

  const remainingInfos = await getAccountInfos(connection, accounts.map((account) => account.keypair.publicKey));
  const remainingSol = remainingInfos.reduce((sum, info) => sum + BigInt(info?.lamports ?? 0), 0n);
  let remainingTokens = 0;
  if (opts.tokens) {
    const perOwner = await mapPool(accounts, opts.concurrency, (account) => findTokenAccounts(connection, account));
    remainingTokens = perOwner.reduce((sum, list) => sum + list.length, 0);
  }

  const all = [...report.tokens, ...report.sol];
  const failed = all.filter((item) => item.status !== "confirmed");
  const reportFile = `solana-sweep-report-${Date.now()}.json`;
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nconfirmed: ${all.length - failed.length}   failed: ${failed.length}`);
  console.log(`remaining: ${formatSol(remainingSol)} SOL and ${remainingTokens} token accounts`);
  console.log(`report: ${reportFile}`);
  if (failed.length || remainingTokens) process.exitCode = 1;
}

export { PATHS, parseKeyInput, deriveSlip10, deriveAccounts };

// Run only as a CLI, so tests can import the helpers above.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
