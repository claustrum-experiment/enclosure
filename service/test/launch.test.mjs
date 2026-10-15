import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createTransferCheckedInstruction } from "@solana/spl-token";
import { setupPlan } from "../src/launch.mjs";
import { distributionBatches, splitEvenly, transferCheckedIx } from "../src/buyback.mjs";
import { ata } from "../src/chain/solana.mjs";

const rand = () => Keypair.generate().publicKey.toBase58();
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const programId = "BMSrAUCk16tJDKLWX8KDhsyH9TAGMVWhFpuG3b3JAAtX";

test("setup re-run after part 1 on mainnet: only the enclosure, holdings, admissions (and renounce) remain", () => {
  const admin = rand(), cranker = rand(), agents = Array.from({ length: 10 }, rand), mint = rand();
  const onChain = { routerExists: true, agents: [...agents], mint: null, holdings: Array(10).fill(false), status: Array(10).fill("empty"), admin };
  const plan = setupPlan({ programId, admin, cranker, agents, mint, renounce: true, tokenProgram: TOKEN_2022, onChain });
  assert.deepEqual(plan.steps.map((s) => s.name), ["enclosure", "holdings-1", "holdings-2", "admit-first", "renounce-admin"]);
  // every instruction that touches tokens names Token-2022, never classic SPL Token
  for (const s of plan.steps) for (const ix of s.ixs) {
    assert.ok(!ix.keys.some((k) => k.pubkey === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), `${s.name} must not use SPL Token`);
  }
  assert.ok(plan.steps.find((s) => s.name === "enclosure").ixs[0].keys.some((k) => k.pubkey === TOKEN_2022));
});

test("setup half-finished: skips what exists, refuses a different mint or a swapped agent", () => {
  const admin = rand(), cranker = rand(), agents = Array.from({ length: 10 }, rand), mint = rand();
  const holdings = Array(10).fill(false); holdings[0] = holdings[1] = holdings[2] = true;
  const status = Array(10).fill("empty"); status[0] = "alive";
  const plan = setupPlan({ programId, admin, cranker, agents, mint, onChain: { routerExists: true, agents, mint, holdings, status, admin } });
  assert.deepEqual(plan.steps.map((s) => s.name), ["holdings-1", "holdings-2", "admit-first"]);
  assert.equal(plan.steps[0].ixs.length, 2);
  assert.equal(plan.steps.find((s) => s.name === "admit-first").ixs.length, 1, "only agent II still needs letting in");
  assert.throws(() => setupPlan({ programId, admin, cranker, agents, mint: rand(), onChain: { routerExists: true, agents, mint, holdings, status } }), /already holds/);
  const swapped = [...agents]; swapped[3] = rand();
  assert.throws(() => setupPlan({ programId, admin, cranker, agents, onChain: { routerExists: true, agents: swapped } }), /already registered/);
  const done = setupPlan({ programId, admin, cranker, agents, mint, renounce: true, onChain: { routerExists: true, agents, mint, holdings: Array(10).fill(true), status: ["alive", "alive", ...Array(8).fill("empty")], admin: null } });
  assert.equal(done.steps.length, 0, "nothing left once everything is done and admin is renounced");
});

test("Token-2022 transfers match spl-token and use the Token-2022 token accounts", () => {
  const [src, mint, dst, owner] = [rand(), rand(), rand(), rand()];
  const mine = transferCheckedIx({ source: src, mint, destination: dst, owner, amount: 42n, decimals: 6, tokenProgram: TOKEN_2022 });
  const theirs = createTransferCheckedInstruction(new PublicKey(src), new PublicKey(mint), new PublicKey(dst), new PublicKey(owner), 42n, 6, [], new PublicKey(TOKEN_2022));
  assert.equal(mine.programId, theirs.programId.toBase58());
  assert.deepEqual(Buffer.from(mine.data), Buffer.from(theirs.data));
  const executor = rand();
  const batches = distributionBatches({ executor, mint, decimals: 6, shares: splitEvenly(10n, [rand(), rand()]), tokenProgram: TOKEN_2022 });
  assert.ok(batches.flat().every((ix) => ix.programId === TOKEN_2022 && ix.keys[0].pubkey === ata(executor, mint, TOKEN_2022)));
  assert.notEqual(ata(executor, mint, TOKEN_2022), ata(executor, mint));
});
