#!/usr/bin/env node
// Launch tooling. Every command simulates first; nothing is sent without --send.
//
//   setup          Create the Router, register the ten agent wallets and, once the token
//                  exists (--mint), the enclosure, the ten holdings and alcove I's admission.
//                  --renounce adds the permanent renounce_admin step at the end.
//                  With --admin-keypair it signs and sends as the admin wallet; without it,
//                  writes unsigned transactions to --out.
//   waive-manager  The token's Bags fee-share manager gives up the role, permanently.
//
// Examples:
//   RPC_URL=... node bin/launch.mjs setup --program <ID> --admin <ADMIN> --admin-keypair keys/admin.json \
//       --cranker <CRANKER> --agents keys/agents.json --mint <MINT> [--renounce] [--send]
//   RPC_URL=... node bin/launch.mjs waive-manager --mint <MINT> --manager-keypair launcher.json [--send]

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { RouterIx } from "../src/chain/router-ix.mjs";
import { managerWaiveIx } from "../src/chain/bags.mjs";
import { encode } from "../src/base58.mjs";
import { setupPlan } from "../src/launch.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: {
  admin: { type: "string" }, cranker: { type: "string" }, agents: { type: "string" },
  out: { type: "string", default: "setup" },
  program: { type: "string" }, "payer-keypair": { type: "string" }, mint: { type: "string" }, "manager-keypair": { type: "string" },
  "admin-keypair": { type: "string" }, renounce: { type: "boolean", default: false }, send: { type: "boolean", default: false },
} });
const toWeb3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });
const keypair = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

async function simulateAndMaybeSend(ixs, signer, label) {
  const connection = new Connection(process.env.RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: ixs.map(toWeb3) }).compileToV0Message());
  tx.sign([signer]);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) { console.error(`${label}: simulation FAILED ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`); process.exit(1); }
  console.log(`${label}: simulation OK`);
  if (!values.send) { console.log("not sent (pass --send)"); return; }
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`${label}: ${sig}`);
}

if (cmd === "setup") {
  const agents = JSON.parse(readFileSync(values.agents, "utf8"));
  const plan = setupPlan({ programId: values.program, admin: values.admin, cranker: values.cranker, agents, mint: values.mint, renounce: values.renounce });
  for (const w of plan.warnings) console.error(`WARNING: ${w}`);
  if (values["admin-keypair"]) {
    const admin = keypair(values["admin-keypair"]);
    if (admin.publicKey.toBase58() !== values.admin) { console.error(`--admin-keypair is ${admin.publicKey.toBase58()}, not --admin ${values.admin}`); process.exit(1); }
    for (const [i, s] of plan.steps.entries()) await simulateAndMaybeSend(s.ixs, admin, `${i + 1}. ${s.name}: ${s.description}`);
    process.exit(0);
  }
  mkdirSync(values.out, { recursive: true });
  plan.steps.forEach((s, i) => {
    const msg = new TransactionMessage({ payerKey: new PublicKey(values.admin), recentBlockhash: encode(new Uint8Array(32)), instructions: s.ixs.map(toWeb3) }).compileToLegacyMessage();
    writeFileSync(join(values.out, `${String(i + 1).padStart(2, "0")}-${s.name}.json`), JSON.stringify({ step: s.name, description: s.description, base58Transaction: encode(new VersionedTransaction(msg).serialize()) }, null, 2));
    console.log(`${i + 1}. ${s.name}: ${s.description}`);
  });
  console.log(`\nWrote ${plan.steps.length} unsigned transactions to ${values.out}/.`);
} else if (cmd === "waive-manager") {
  const manager = keypair(values["manager-keypair"]);
  const m = manager.publicKey.toBase58();
  await simulateAndMaybeSend([managerWaiveIx({ payer: m, manager: m, baseMint: values.mint })], manager, "waive Bags fee-share manager");
  console.log("Afterwards, check with: node bin/verify.mjs --program <ID> --mint <MINT> --fee-wallet <FEE_WALLET>");
} else {
  console.error("commands: setup | waive-manager");
  process.exit(2);
}
