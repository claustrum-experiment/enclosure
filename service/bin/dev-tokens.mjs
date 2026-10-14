#!/usr/bin/env node
// The launch ("dev") buy, handled in public: the tokens are sent to the cranker wallet, then this
// burns 80% and gives 20% to the living agents in even shares, straight into their Router-controlled
// holdings. Both steps are recorded in public/fees.jsonl and shown on the website with their transactions.
//
//   node bin/dev-tokens.mjs --program <ID> --mint <MINT> [--send]
//
// Environment: RPC_URL, CRANKER_KEYPAIR, OUT_DIR

import { parseArgs } from "node:util";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { devSplit, burnCheckedIx, distributionBatches } from "../src/buyback.mjs";
import { ata, TOKEN_PROGRAM } from "../src/chain/bags.mjs";
import { RouterIx } from "../src/chain/router-ix.mjs";
import { decodeRouter } from "../src/chain/decode.mjs";

const { values } = parseArgs({ options: { program: { type: "string" }, mint: { type: "string" }, send: { type: "boolean", default: false }, "gift-bps": { type: "string", default: "2000" } } });
if (!values.program || !values.mint) { console.error("usage: node bin/dev-tokens.mjs --program <ID> --mint <MINT> [--send]"); process.exit(2); }

const connection = new Connection(process.env.RPC_URL, "confirmed");
const holder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.CRANKER_KEYPAIR, "utf8"))));
const me = holder.publicKey.toBase58();
const rix = new RouterIx(values.program);
const logPath = join(process.env.OUT_DIR ?? "./public", "fees.jsonl");
const record = (e) => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), wallet: me, simulated: !values.send, ...e }) + "\n");
const toWeb3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });

async function send(ixs, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: holder.publicKey, recentBlockhash: blockhash, instructions: ixs.map(toWeb3) }).compileToV0Message());
  tx.sign([holder]);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  if (!values.send) { console.log(`${label}: simulated OK (not sent; pass --send)`); return null; }
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`${label}: ${sig}`);
  return sig;
}

const mintInfo = await connection.getAccountInfo(new PublicKey(values.mint));
const tokenProgram = mintInfo.owner.toBase58();
const source = ata(me, values.mint, tokenProgram);
const bal = await connection.getTokenAccountBalance(new PublicKey(source)).catch(() => null);
if (!bal || BigInt(bal.value.amount) === 0n) { console.log(`No ${values.mint} tokens in ${me} yet. Send the launch buy there first.`); process.exit(1); }
const decimals = bal.value.decimals;
const state = decodeRouter((await connection.getAccountInfo(new PublicKey(rix.router))).data);
const living = state.status.map((s, k) => (s === "alive" ? k : -1)).filter((k) => k >= 0);
const { burn, gift, each } = devSplit(bal.value.amount, living.length, Number(values["gift-bps"]));
const units = (u) => (Number(u) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 0 });
console.log(`Launch buy: ${units(bal.value.amount)} tokens. Burn ${units(burn)}; give ${units(gift)} (${units(each)} each to alcoves ${living.map((k) => k + 1).join(", ")}).`);

const burnTx = await send([burnCheckedIx({ account: source, mint: values.mint, owner: me, amount: burn, decimals, tokenProgram })], "burn");
record({ kind: "dev-burn", units: String(burn), decimals, tx: burnTx });
const shares = living.map((k) => ({ holding: rix.holding(k), amount: each }));
for (const batch of distributionBatches({ executor: me, mint: values.mint, decimals, shares, tokenProgram })) {
  const tx = await send(batch, "gift to the agents");
  record({ kind: "dev-gift", units: String(gift), eachUnits: String(each), decimals, alcoves: living.map((k) => k + 1), tx });
}
