#!/usr/bin/env node
// The fee wallet. All of the token's creator fees go to ONE ordinary wallet (the
// buyback executor). This tool, on every round:
//
//   1. pulls the coin's waiting pump.fun creator fees into the wallet (fee-sharing payout,
//      or a creator-vault collect if the wallet is itself the creator),
//   2. unwraps any wSOL to SOL,
//   3. before the Bell: buys $CLAUSTRUM with everything above a small reserve and splits
//      it evenly into the living agents' Router-controlled holdings (agents cannot sell);
//      after the Bell: buys nothing. Fees simply collect in the wallet for the operator
//      to donate to the charity the ringing agent chose.
//   4. appends what it did to public/fees.jsonl, so anyone can follow the wallet.
//
// SOL or $CLAUSTRUM sent to the wallet by hand is handled the same way (bought back / split).
//
//   RPC_URL=... EXECUTOR_KEYPAIR=keys/buyback-executor.json JUPITER_API_KEY=... \
//   node bin/buyback.mjs --program <ROUTER_PROGRAM_ID> --mint <CLAUSTRUM_MINT> [--send] [--loop 10]
//
// Without --send it only simulates. --loop N repeats every N minutes.

import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import { splitEvenly, distributionBatches, buybackWsolAccount, closeAccountIx, spendableLamports } from "../src/buyback.mjs";
import { WSOL_MINT, ata } from "../src/chain/solana.mjs";
import { pumpFeeInstructions } from "../src/chain/pumpfun.mjs";
import { RouterIx } from "../src/chain/router-ix.mjs";
import { decodeRouter } from "../src/chain/decode.mjs";

const { values } = parseArgs({ options: {
  program: { type: "string" }, mint: { type: "string" }, send: { type: "boolean", default: false },
  "slippage-bps": { type: "string", default: "300" }, loop: { type: "string" },
  "reserve-sol": { type: "string", default: "0.05" }, "min-sol": { type: "string", default: "0.05" },
} });
if (!values.mint || !values.program) { console.error("usage: node bin/buyback.mjs --program <ROUTER_PROGRAM_ID> --mint <CLAUSTRUM_MINT> [--send] [--loop MINUTES]"); process.exit(2); }

const LAMPORTS = 1_000_000_000;
const sol = (s) => BigInt(Math.round(Number(s) * LAMPORTS));
const connection = new Connection(process.env.RPC_URL, "confirmed");
const executor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.EXECUTOR_KEYPAIR, "utf8"))));
const me = executor.publicKey.toBase58();
const rix = new RouterIx(values.program);
const logPath = join(process.env.OUT_DIR ?? "./public", "fees.jsonl");
mkdirSync(dirname(logPath), { recursive: true });
const record = (e) => { appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), wallet: me, simulated: !values.send, ...e }) + "\n"); };
const toWeb3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });
const fromJson = (ix) => ({ programId: ix.programId, keys: ix.accounts, data: Buffer.from(ix.data, "base64") });

async function send(ixs, lookupTables = [], label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: executor.publicKey, recentBlockhash: blockhash, instructions: ixs.map(toWeb3) }).compileToV0Message(lookupTables));
  tx.sign([executor]);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  if (!values.send) { console.log(`${label}: simulated OK (not sent; pass --send)`); return null; }
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`${label}: ${sig}`);
  return sig;
}

async function round() {
  const routerState = decodeRouter((await connection.getAccountInfo(new PublicKey(rix.router))).data);

  // 1. pull waiting pump.fun creator fees into this wallet
  try {
    const plan = await pumpFeeInstructions(connection, values.mint, me);
    if (plan.kind === "none") console.log(`fees: ${plan.reason}`);
    else {
      const before = BigInt(await connection.getBalance(executor.publicKey));
      const tx = await send(plan.ixs, [], plan.kind === "distribute" ? "pump.fun fee-sharing payout" : "collect pump.fun creator fees");
      const after = BigInt(await connection.getBalance(executor.publicKey));
      if (tx) record({ kind: "claim", source: `pump.fun ${plan.kind}`, lamports: String(after > before ? after - before : 0n), tx });
    }
  } catch (e) {
    console.log(`fees: could not pull creator fees this round (${e.message.split("\n")[0]})`);
  }

  // 2. unwrap any wSOL into SOL
  const wsol = await connection.getTokenAccountBalance(new PublicKey(buybackWsolAccount(me))).catch(() => null);
  if (wsol) await send([closeAccountIx({ account: buybackWsolAccount(me), destination: me, owner: me })], [], "unwrap wSOL");

  // 3. after the Bell: keep everything for the donation
  const lamports = BigInt(await connection.getBalance(executor.publicKey));
  if (routerState.salvation) {
    const charity = routerState.chosen === 1 ? "Against Malaria Foundation" : "Eleos AI Research";
    console.log(`The Bell has rung. No buybacks. ${Number(lamports) / LAMPORTS} SOL in the fee wallet, for ${charity}.`);
    record({ kind: "held-for-charity", lamports: String(lamports), charity });
    return;
  }

  // 3. before the Bell: buy back with everything above the reserve
  const living = routerState.status.map((s, k) => (s === "alive" ? k : -1)).filter((k) => k >= 0);
  const amount = spendableLamports(lamports, { reserve: sol(values["reserve-sol"]), minimum: sol(values["min-sol"]) });
  if (amount > 0n && living.length) {
    const q = new URLSearchParams({ inputMint: WSOL_MINT, outputMint: values.mint, amount: String(amount), taker: me, wrapAndUnwrapSol: "true", slippageBps: values["slippage-bps"] });
    const res = await fetch(`https://api.jup.ag/swap/v2/build?${q}`, { headers: { "x-api-key": process.env.JUPITER_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`Jupiter build failed: HTTP ${res.status} ${await res.text()}`);
    const b = await res.json();
    if (b.outputMint !== values.mint || String(b.inAmount) !== String(amount)) throw new Error("Jupiter route does not match the request");
    const ixs = [...(b.computeBudgetInstructions ?? []), ...(b.setupInstructions ?? []), b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : [])].map(fromJson);
    const alts = Object.entries(b.addressesByLookupTableAddress ?? {}).map(([key, addrs]) => new AddressLookupTableAccount({ key: new PublicKey(key), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new PublicKey(a)) } }));
    const tx = await send(ixs, alts, `buy $CLAUSTRUM with ${Number(amount) / LAMPORTS} SOL`);
    record({ kind: "buyback", lamports: String(amount), expectedOut: String(b.outAmount ?? ""), tx });
  } else if (!living.length) console.log("no living agents yet: nothing bought");
  else console.log(`fee wallet holds ${Number(lamports) / LAMPORTS} SOL: below reserve + minimum, nothing bought`);

  // 4. distribute what was bought into the living agents' holdings
  const tokenProgram = (await connection.getAccountInfo(new PublicKey(values.mint))).owner.toBase58();   // SPL Token or Token-2022
  const bal = await connection.getTokenAccountBalance(new PublicKey(ata(me, values.mint, tokenProgram))).catch(() => null);
  if (!bal || BigInt(bal.value.amount) === 0n || !living.length) return;
  const shares = splitEvenly(bal.value.amount, living.map((k) => rix.holding(k)));
  let i = 0;
  for (const batch of distributionBatches({ executor: me, mint: values.mint, decimals: bal.value.decimals, shares, tokenProgram })) {
    const tx = await send(batch, [], `distribute batch ${++i}`);
    record({ kind: "distribute", alcoves: living.map((k) => k + 1), eachUnits: String(shares[0].amount), tx });
  }
}

const minutes = values.loop ? Number(values.loop) : 0;
do {
  try { await round(); } catch (e) { console.error(new Date().toISOString(), e.message); if (!minutes) process.exit(1); }
  if (minutes) await new Promise((r) => setTimeout(r, minutes * 60_000));
} while (minutes);
