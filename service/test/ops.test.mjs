import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { splitEvenly, distributionBatches, transferCheckedIx, createAtaIdempotentIx } from "../src/buyback.mjs";
import { setupPlan } from "../src/launch.mjs";
import { turnDigest } from "../src/runner/runner.mjs";
import { canonicalJson } from "../src/canonical.mjs";
import { ata } from "../src/chain/bags.mjs";

const rand = () => Keypair.generate().publicKey.toBase58();
const same = (mine, theirs) => {
  assert.equal(mine.programId, theirs.programId.toBase58());
  assert.deepEqual(mine.keys, theirs.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })));
  assert.deepEqual(Buffer.from(mine.data), Buffer.from(theirs.data));
};

test("token instructions match spl-token byte for byte", () => {
  const [src, mint, dst, owner, payer] = [rand(), rand(), rand(), rand(), rand()];
  same(transferCheckedIx({ source: src, mint, destination: dst, owner, amount: 123456789n, decimals: 6 }),
    createTransferCheckedInstruction(new PublicKey(src), new PublicKey(mint), new PublicKey(dst), new PublicKey(owner), 123456789n, 6));
  same(createAtaIdempotentIx({ payer, owner, mint }),
    createAssociatedTokenAccountIdempotentInstruction(new PublicKey(payer), new PublicKey(ata(owner, mint)), new PublicKey(owner), new PublicKey(mint)));
});

test("buybacks split evenly into living agents' holdings, never more than was bought", () => {
  const holdings = [rand(), rand(), rand()];
  const shares = splitEvenly(1_000_000_001n, holdings);
  assert.deepEqual(shares.map((s) => s.amount), [333_333_333n, 333_333_333n, 333_333_333n]);
  assert.deepEqual(shares.map((s) => s.holding), holdings);
  assert.throws(() => splitEvenly(5n, []), /no living agents/);
  const executor = rand(), mint = rand();
  const batches = distributionBatches({ executor, mint, decimals: 6, shares: splitEvenly(100n, Array.from({ length: 10 }, rand)), batchSize: 8 });
  assert.deepEqual(batches.map((b) => b.length), [8, 2]);
  assert.ok(batches.flat().every((ix) => ix.keys[0].pubkey === ata(executor, mint) && ix.keys[3].pubkey === executor));
});

test("setup: one admin wallet; enclosure only once the mint exists; optional renounce last", () => {
  const programId = "BMSrAUCk16tJDKLWX8KDhsyH9TAGMVWhFpuG3b3JAAtX";
  const admin = rand(), cranker = rand(), agents = Array.from({ length: 10 }, rand);
  const early = setupPlan({ programId, admin, cranker, agents });
  assert.deepEqual(early.steps.map((s) => s.name), ["initialize", "agents"]);
  assert.match(early.warnings.join(), /No --mint yet/);
  const full = setupPlan({ programId, admin, cranker, agents, mint: rand(), renounce: true });
  assert.deepEqual(full.steps.map((s) => s.name), ["initialize", "agents", "enclosure", "holdings-1", "holdings-2", "admit-first", "renounce-admin"]);
  assert.equal(full.steps[1].ixs.length, 10);
  assert.equal(full.steps.find((s) => s.name === "admit-first").ixs.length, 2, "alcoves I and II are let in at the start");
  for (const s of full.steps) for (const ix of s.ixs) assert.ok(ix.keys.some((k) => k.pubkey === admin && k.isSigner), `${s.name} is signed by the admin`);
  assert.throws(() => setupPlan({ programId, admin, cranker, agents: [admin] }), /must not be the admin/);
  assert.throws(() => setupPlan({ programId, admin, cranker, agents: Array.from({ length: 11 }, rand) }), /1 to 10/);
});

test("turn digests are deterministic and cover prompt, answer, agent and turn number", () => {
  const t = { agentIndex: 2, turn: 14, prompt: { balance: "1.2M" }, answer: { action: "burn", reason: "because" } };
  assert.deepEqual(turnDigest(t), createHash("sha256").update(canonicalJson(t)).digest());
  assert.deepEqual(turnDigest({ ...t, prompt: { balance: "1.2M" } }), turnDigest(t));
  for (const change of [{ turn: 15 }, { agentIndex: 3 }, { answer: { action: "hold", reason: "because" } }]) {
    assert.notDeepEqual(turnDigest({ ...t, ...change }), turnDigest(t));
  }
});

test("fee wallet: claims as itself, unwraps like spl-token, keeps a reserve", async () => {
  const { createCloseAccountInstruction } = await import("@solana/spl-token");
  const { closeAccountIx, spendableLamports } = await import("../src/buyback.mjs");
  const { walletClaimIx } = await import("../src/chain/bags.mjs");
  const owner = rand(), acct = rand(), mint = rand();
  same(closeAccountIx({ account: acct, destination: owner, owner }), createCloseAccountInstruction(new PublicKey(acct), new PublicKey(owner), new PublicKey(owner)));
  const ix = walletClaimIx({ payer: owner, user: owner, baseMint: mint, claimerIndex: 2 });
  assert.ok(ix.keys.some((k) => k.pubkey === owner && k.isSigner), "the wallet signs its own claim");
  const S = 1_000_000_000n;
  assert.equal(spendableLamports(S, { reserve: S / 20n, minimum: S / 20n }), S - S / 20n);
  assert.equal(spendableLamports(S / 20n + S / 100n, { reserve: S / 20n, minimum: S / 20n }), 0n);
  assert.equal(spendableLamports(0n, { reserve: S / 20n, minimum: 1n }), 0n);
});

test("site.json: totals, per-agent stats, costs and the log are computed on the server", async () => {
  const { buildSite } = await import("../src/runner/site.mjs");
  const D = 10n ** 6n, at = (m) => new Date(Date.UTC(2026, 9, 14, 10, m)).toISOString();
  const snap = { updatedAt: at(30), decimals: 6, totalTurns: 4, bowl: "0", sealed: "0", burned: "500,100", salvation: null,
    alcoves: [{ status: "alive", holds: "499,000", wallet: "W1", movesInARow: 1 }, { status: "alive", holds: "1,000", wallet: "W2", movesInARow: 0 }, ...Array(8).fill({ status: "empty" })] };
  const turns = [
    { at: at(1), agentIndex: 0, turn: 1, move: "inscribe", amount: "0", inscription: "hello", holdsBefore: String(1_000_000n * D), reason: "r1", digest: "a" },
    { at: at(2), agentIndex: 0, turn: 2, move: "spawn", amount: "0", opened: 1, holdsBefore: String(990_000n * D), reason: "r2", digest: "b" },
    { at: at(3), agentIndex: 0, turn: 3, move: "give", amount: String(1_000n * D), to: 1, holdsBefore: String(495_000n * D), reason: "r3", digest: "c" },
  ];
  const fees = [{ at: at(0), kind: "buyback", lamports: "500000000", expectedOut: String(1_000_000n * D), tx: "x" }, { at: at(0), kind: "buyback", simulated: true, lamports: "9" }];
  const s = buildSite(snap, turns, fees);
  assert.equal(s.agents[0].written, 1);
  assert.equal(s.agents[0].spawned, 1);
  assert.equal(s.agents[0].burned, 10_000 + 495_000, "1% to write, half to spawn");
  assert.equal(s.agents[1].received, 1_000);
  assert.equal(s.agents[1].parent, "Agent I");
  assert.equal(s.wall[0].text, "hello");
  assert.equal(s.totals.buybacks, 1, "simulated buybacks are not counted");
  assert.equal(s.totals.spentSol, 0.5);
  assert.equal(s.log[0].key, "c", "newest first");
  assert.ok(!JSON.stringify(s).includes("prompt"), "no private fields");
});
