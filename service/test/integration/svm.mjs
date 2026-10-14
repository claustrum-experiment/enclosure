#!/usr/bin/env node
// Runs the COMPILED program (the .so that gets deployed) in LiteSVM, an in-process
// Solana runtime, and plays random games against it in lockstep with the JS rules.
//
//   PROGRAM_SO=path/to/claustrum_router.so [GAMES=20] [STEPS=120] node test/integration/svm.mjs
//
// Each game: set the Router up with one admin wallet, create a mint and the ten holdings,
// admit alcove I, then for every step move the clock forward a random amount and have a
// random agent try a move: mostly legal ones, sometimes nonsense. The chain and the rules
// must accept or refuse the same moves, and balances, statuses, streaks, action count,
// burned total and the Bell must match after every step. Strangers must never be able to
// take an agent's turn. Prints the compute used per move type.

import { createRequire } from "node:module";
const native = createRequire(import.meta.url)("litesvm/dist/internal.js");

/** The native LiteSVM, driven with raw bytes so it works with web3.js 1.x objects. */
class LiteSVM {
  constructor() { this.inner = new native.LiteSvm(); }
  addProgramFromFile(id, path) { this.inner.addProgramFromFile(id.toBytes(), path); }
  airdrop(pk, lamports) { this.inner.airdrop(pk.toBytes(), lamports); }
  latestBlockhash() { return this.inner.latestBlockhash(); }
  expireBlockhash() { this.inner.expireBlockhash(); }
  minimumBalanceForRentExemption(n) { return this.inner.minimumBalanceForRentExemption(n); }
  getClock() { return this.inner.getClock(); }
  setClock(c) { this.inner.setClock(c); }
  getAccount(pk) { const a = this.inner.getAccount(pk.toBytes()); return a ? { lamports: a.lamports(), data: Buffer.from(a.data()), owner: new PublicKey(a.owner()), executable: a.executable() } : null; }
  sendTransaction(tx) { return this.inner.sendVersionedTransaction(tx.serialize()); }
  simulateTransaction(tx) { return this.inner.simulateVersionedTransaction(tx.serialize()); }
}
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction, createMintToInstruction } from "@solana/spl-token";
import bs58mod from "bs58";
import { RouterIx } from "../../src/chain/router-ix.mjs";
import { LiveEnclosure } from "../../src/runner/live-enclosure.mjs";
import { SimEnclosure } from "../../src/runner/sim.mjs";
import { STATUS, MOVES, legalMoves } from "../../src/runner/rules.mjs";

const bs58 = bs58mod.default ?? bs58mod;
const PROGRAM_ID = "BMSrAUCk16tJDKLWX8KDhsyH9TAGMVWhFpuG3b3JAAtX";
const SO = process.env.PROGRAM_SO;
const GAMES = Number(process.env.GAMES ?? 20), STEPS = Number(process.env.STEPS ?? 120);
if (!SO) { console.error("set PROGRAM_SO"); process.exit(2); }

/** Just enough of web3.js's Connection for LiveEnclosure, backed by LiteSVM. */
class SvmConnection {
  constructor(svm) { this.svm = svm; this.txs = new Map(); }
  async getMultipleAccountsInfo(keys) { return keys.map((k) => this.svm.getAccount(new PublicKey(k))); }
  async getLatestBlockhash() { return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0 }; }
  async simulateTransaction(tx) {
    const r = this.svm.simulateTransaction(tx);
    const meta = typeof r.meta === "function" ? r.meta() : r;
    const failed = typeof r.err === "function";
    return { value: { err: failed ? String(r.err()) : null, logs: (failed ? r.meta() : meta).logs?.() ?? [] } };
  }
  async sendRawTransaction(raw) {
    const tx = VersionedTransaction.deserialize(raw);
    const r = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    if (typeof r.err === "function") throw new Error(`failed: ${String(r.err())} ${r.meta().logs().filter((l) => /Error|failed/.test(l)).join(" | ")}`);
    const sig = bs58.encode(tx.signatures[0]);
    this.txs.set(sig, r);
    return sig;
  }
  async confirmTransaction() { return { value: { err: null } }; }
}

function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; }; }
const toWeb3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });
const J = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };
const compute = {};
const seen = { accepted: {}, refused: {} };

async function game(seed) {
  const R = rng(seed);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const svm = new LiteSVM();
  svm.addProgramFromFile(new PublicKey(PROGRAM_ID), SO);
  const conn = new SvmConnection(svm);
  const r = new RouterIx(PROGRAM_ID);
  const admin = Keypair.generate(), cranker = Keypair.generate();
  const agents = Array.from({ length: 10 }, () => Keypair.generate());
  for (const k of [admin, cranker]) svm.airdrop(k.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  const send = (ixs, signers) => {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: svm.latestBlockhash(), instructions: ixs.map((ix) => (ix instanceof TransactionInstruction ? ix : toWeb3(ix))) }).compileToV0Message());
    tx.sign(signers);
    const res = svm.sendTransaction(tx);
    svm.expireBlockhash();
    if (typeof res.err === "function") throw new Error(`${String(res.err())}\n${res.meta().logs().join("\n")}`);
    return res;
  };
  const A = admin.publicKey.toBase58();
  const mintKp = Keypair.generate(), M = mintKp.publicKey.toBase58();
  send([SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mintKp.publicKey, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }), createInitializeMint2Instruction(mintKp.publicKey, 6, admin.publicKey, null)], [admin, mintKp]);
  send([r.initialize({ payer: A, admin: A, cranker: cranker.publicKey.toBase58() })], [admin]);
  for (const b of [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]) send(b.map((index) => r.setAgent({ admin: A, index, agent: agents[index].publicKey.toBase58() })), [admin]);
  send([r.initEnclosure({ payer: A, admin: A, mint: M })], [admin]);
  for (const b of [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]) send(b.map((index) => r.initHolding({ payer: A, index, mint: M })), [admin]);
  send([r.admitFirst({ admin: A, index: 0 })], [admin]);
  send([r.admitFirst({ admin: A, index: 1 })], [admin]);
  // the operator lets in only the first two
  try { send([r.admitFirst({ admin: A, index: 2 })], [admin]); fail(`seed ${seed}: a third agent was admitted by the operator`); } catch {}
  // the admin gives up the role; after that nothing administrative works, but the game goes on
  if (seed % 2) {
    send([r.renounceAdmin({ admin: A })], [admin]);
    try { send([r.renounceAdmin({ admin: A })], [admin]); fail(`seed ${seed}: renounced twice`); } catch {}
    try { send([r.setAgent({ admin: A, index: 0, agent: Keypair.generate().publicKey.toBase58() })], [admin]); fail(`seed ${seed}: set_agent after renounce`); } catch {}
  }
  try { send([r.setAgent({ admin: A, index: 0, agent: Keypair.generate().publicKey.toBase58() })], [admin]); fail(`seed ${seed}: an alcove's agent was replaced`); } catch {}

  const START = 1_000_000n * 10n ** 6n;
  const deposit = (k, amount) => { send([createMintToInstruction(mintKp.publicKey, new PublicKey(r.holding(k)), admin.publicKey, amount)], [admin]); sim.bal.holdings[k] += amount; };
  const sim = new SimEnclosure({ start: 0n });
  sim.bal.holdings[0] = 0n;
  deposit(0, START);
  const live = new LiveEnclosure({ connection: conn, programId: PROGRAM_ID, mint: M, agents, cranker });
  let now = 1_800_000_000;
  const setNow = () => { const c = svm.getClock(); c.unixTimestamp = BigInt(now); svm.setClock(c); };
  setNow();

  for (let step = 0; step < STEPS; step++) {
    now += pick([0, 30, 119, 120, 121, 200, 400]);
    setNow();
    const st = await sim.read();
    if (st.s.salvation) {
      // after the Bell nothing may move
      const k = pick([0, 1, 2]);
      try { await live.submit({ agentIndex: k, decision: { move: "hold" }, digest: new Uint8Array(32) }); fail(`seed ${seed}: a turn was accepted after the Bell`); } catch {}
      break;
    }
    if (R() < 0.08) { const alive = st.s.status.map((x, k) => (x === STATUS.alive ? k : -1)).filter((k) => k >= 0); if (alive.length) deposit(pick(alive), BigInt(Math.floor(R() * 1e6)) * 10n ** 6n); }
    if (R() < 0.05) {
      const intruder = Keypair.generate();
      try { send([r.takeTurn({ agent: intruder.publicKey.toBase58(), agentIndex: Math.floor(R() * 10), action: "burn", amount: 1n, target: 0, choice: 0, inscription: "", digest: new Uint8Array(32), mint: M })], [cranker, intruder]); fail(`seed ${seed}: a stranger took a turn`); } catch {}
    }
    const i = R() < 0.85 ? pick(st.s.status.map((x, k) => (x === STATUS.alive ? k : -1)).filter((k) => k >= 0).concat([0])) : Math.floor(R() * 10);
    const legal = legalMoves(st.s, i, st.bal, now);
    let decision;
    if (legal.length && R() < 0.8) {
      let options = legal.filter((x) => x.move !== "depart" || R() < 0.04);  // departures are rare, so games reach the Bell
      if (!options.length) options = legal;
      const m = pick(options);
      const rand = (max) => 1n + BigInt(Math.floor(R() * Number(max > 9_000_000_000_000_000n ? 9_000_000_000_000_000n : max)));
      decision = { move: m.move, charity: R() < 0.5 ? "eleos" : "amf" };
      if (m.move === "bell" && R() < 0.85) decision = { move: "hold" }; // let games run past 50 before ringing
      else if (m.max !== undefined) decision.amount = R() < 0.1 ? m.max + 1n : rand(m.max);
      if (m.to) decision.to = pick(m.to);
      if (m.move === "inscribe") decision.inscription = "x".repeat(1 + Math.floor(R() * (R() < 0.1 ? 140 : 120)));
    } else {
      decision = { move: pick(MOVES), amount: BigInt(Math.floor(R() * 3)) * BigInt(Math.floor(R() * 1e12)), to: Math.floor(R() * 10), inscription: R() < 0.5 ? "" : "words", charity: "eleos" };
      if (decision.inscription === "" && decision.move === "inscribe") decision.inscription = "";
    }
    if (decision.move === "inscribe" && Buffer.byteLength(decision.inscription ?? "") > 120) decision.inscription = "y".repeat(120); // builder refuses >120 bytes client-side
    const digest = new Uint8Array(32).fill(step & 255);
    let simOk = true, chainOk = true, simErr = "", chainErr = "";
    const before = await sim.read();
    try { await sim.submit({ agentIndex: i, decision, digest, now }); } catch (e) { simOk = false; simErr = e.message; }
    try {
      const res = await live.submit({ agentIndex: i, decision, digest });
      const cu = conn.txs.get(res.signature)?.computeUnitsConsumed?.();
      (compute[decision.move] ??= []).push(Number(cu ?? 0));
    } catch (e) { chainOk = false; chainErr = e.message.slice(0, 200); }
    (simOk ? seen.accepted : seen.refused)[decision.move] = ((simOk ? seen.accepted : seen.refused)[decision.move] ?? 0) + 1;
    if (simOk !== chainOk) { fail(`seed ${seed} step ${step}: alcove ${i + 1} ${J(decision)} rules ${simOk ? "accepted" : `refused (${simErr})`}, chain ${chainOk ? "accepted" : `refused (${chainErr})`} | state ${J({ status: before.s.status, streak: before.s.streak, actions: before.s.actions, bal: before.bal })}`); return; }
    const [c, s] = [await live.read(), await sim.read()];
    const a = { bal: c.bal, status: c.s.status, streak: c.s.streak, actions: c.s.actions, burned: c.s.totalBurned, salvation: c.s.salvation, chosen: c.s.salvation ? c.s.chosen : null };
    const b = { bal: s.bal, status: s.s.status, streak: s.s.streak, actions: s.s.actions, burned: s.s.totalBurned, salvation: s.s.salvation, chosen: s.s.salvation ? s.s.chosen : null };
    if (J(a) !== J(b)) { fail(`seed ${seed} step ${step}: state differs after ${J(decision)}\n chain ${J(a)}\n rules ${J(b)}`); return; }
  }
  const end = await sim.read();
  return { actions: end.s.actions, bell: end.s.salvation, alive: end.s.status.filter((x) => x === STATUS.alive).length };
}

const results = [];
for (let g = 1; g <= GAMES; g++) results.push(await game(g * 7919));
console.log("games:", results.map((x) => (x ? `${x.actions}${x.bell ? "🔔" : ""}` : "✗")).join(" "));
console.log("moves accepted:", J(seen.accepted));
console.log("moves refused: ", J(seen.refused));
console.log("compute units (max per move):", J(Object.fromEntries(Object.entries(compute).map(([k, v]) => [k, Math.max(...v)]))));
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
