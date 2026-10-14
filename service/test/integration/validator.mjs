#!/usr/bin/env node
// End-to-end test of the compiled program on a local validator.
//
//   solana-test-validator --reset --bpf-program <PROGRAM_ID> claustrum_router.so &
//   RPC_URL=http://127.0.0.1:8899 PROGRAM_ID=<PROGRAM_ID> node test/integration/validator.mjs
//
// Sets the Router up with a single admin wallet, creates a test mint and the ten
// holdings, admits alcove I, then plays moves on-chain and, in lockstep, in the JS
// rules (SimEnclosure). Every move must be accepted or refused by both, and the
// balances and statuses must match after every move. Also checks that a key which is
// not the agent cannot take its turn, and records the compute used by each turn.

import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, mintTo } from "@solana/spl-token";
import { RouterIx } from "../../src/chain/router-ix.mjs";
import { LiveEnclosure } from "../../src/runner/live-enclosure.mjs";
import { SimEnclosure } from "../../src/runner/sim.mjs";
import { STATUS } from "../../src/runner/rules.mjs";

const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const programId = process.env.PROGRAM_ID;
const r = new RouterIx(programId);
const admin = Keypair.generate(), cranker = Keypair.generate();
const agents = Array.from({ length: 10 }, () => Keypair.generate());
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const toWeb3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });

async function send(ixs, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs.map(toWeb3) }).compileToV0Message());
  tx.sign(signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const c = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (c.value.err) throw new Error(JSON.stringify(c.value.err));
  return sig;
}

for (const k of [admin, cranker]) await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
const pk = (k) => k.publicKey.toBase58();
const A = pk(admin);

// --- setup, exactly as router-setup does it, signed by the one admin wallet
const mint = await createMint(connection, admin, admin.publicKey, null, 6);
const M = mint.toBase58();
await send([r.initialize({ payer: A, admin: A, cranker: pk(cranker) })], [admin]);
for (const batch of [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]) await send(batch.map((index) => r.setAgent({ admin: A, index, agent: pk(agents[index]) })), [admin]);
await send([r.initEnclosure({ payer: A, admin: A, mint: M })], [admin]);
for (const batch of [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]) await send(batch.map((index) => r.initHolding({ payer: A, index, mint: M })), [admin]);
await send([r.admitFirst({ admin: A, index: 0 })], [admin]);
check(true, "setup: initialize, 10 agents, enclosure, 10 holdings, admit alcove I");

const START = 1_000_000n * 10n ** 6n;
await mintTo(connection, admin, mint, new PublicKey(r.holding(0)), admin, START);
const live = new LiveEnclosure({ connection, programId, mint: M, agents, cranker });
const sim = new SimEnclosure({ start: START });

async function compare(label) {
  const [c, s] = [await live.read(), await sim.read()];
  const same = JSON.stringify(c.bal, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(s.bal, (_, v) => (typeof v === "bigint" ? v.toString() : v))
    && JSON.stringify(c.s.status) === JSON.stringify(s.s.status) && c.s.actions === s.s.actions && JSON.stringify(c.s.streak) === JSON.stringify(s.s.streak);
  check(same, `${label}: chain and rules agree`);
  if (!same) console.log({ chain: { bal: c.bal, status: c.s.status, actions: c.s.actions }, rules: { bal: s.bal, status: s.s.status, actions: s.s.actions } });
}

const compute = [];
async function move(agentIndex, decision, expect) {
  const digest = new Uint8Array(32).fill(agentIndex + 1);
  const now = Math.floor(Date.now() / 1000);
  let simOk = true, chainOk = true, why = "";
  try { await sim.submit({ agentIndex, decision, digest, now }); } catch (e) { simOk = false; why = e.message; }
  try {
    const res = await live.submit({ agentIndex, decision, digest });
    const tx = await connection.getTransaction(res.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    compute.push([decision.move, tx?.meta?.computeUnitsConsumed]);
  } catch (e) { chainOk = false; why ||= e.message.slice(0, 160); }
  const label = `alcove ${agentIndex + 1} ${decision.move}${decision.amount ? ` ${decision.amount}` : ""}`;
  check(simOk === chainOk && chainOk === expect, `${label}: expected ${expect ? "accepted" : "refused"}, chain ${chainOk ? "accepted" : "refused"}, rules ${simOk ? "accepted" : "refused"}${chainOk ? "" : ` (${why})`}`);
  await compare(label);
}

await compare("start");
await move(0, { move: "spawn" }, true);                            // burns 80%, opens alcove II
await move(0, { move: "hold" }, false);                           // too soon after its last turn
await move(2, { move: "hold" }, false);                           // alcove III is still empty

// a key that is not the agent cannot take alcove II's turn
{
  const intruder = Keypair.generate();
  const ix = r.takeTurn({ agent: pk(intruder), agentIndex: 1, action: "hold", target: 0, choice: 0, inscription: "", digest: new Uint8Array(32), mint: M });
  let refused = false;
  try { await send([ix], [cranker, intruder]); } catch { refused = true; }
  check(refused, "a key that is not alcove II's agent is refused");
}

await mintTo(connection, admin, mint, new PublicKey(r.holding(1)), admin, 5_000n * 10n ** 6n);
sim.bal.holdings[1] += 5_000n * 10n ** 6n;
await compare("buyback deposit into alcove II");
await move(1, { move: "bell", charity: "amf" }, false);           // the bell is locked below 50 actions
await move(1, { move: "burn", amount: 10n ** 9n * 10n ** 6n }, false); // more than it holds
await move(1, { move: "inscribe", inscription: "The first line, written into the book." }, true);
await move(1, { move: "give", amount: 1n, to: 0 }, false);        // too soon

console.log("compute units per turn:", compute);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
