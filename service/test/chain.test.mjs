// Instruction encoding and address derivation, checked against Solana's own JS
// libraries (dev-only test oracle) and the Bags and Router IDLs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { ata, feeShareConfigAddress, decodeFeeShareConfig, checkBagsConfig, walletClaimIx, managerWaiveIx, BAGS_FEE_SHARE_PROGRAM, BAGS_IDL, WSOL_MINT } from "../src/chain/bags.mjs";
import { RouterIx } from "../src/chain/router-ix.mjs";
import { findProgramAddress } from "../src/chain/pda.mjs";
import { encode } from "../src/base58.mjs";

const PROGRAM_ID = "BMSrAUCk16tJDKLWX8KDhsyH9TAGMVWhFpuG3b3JAAtX";
const rand = () => Keypair.generate().publicKey.toBase58();
const anchorDisc = (name) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];

test("PDAs and ATAs match web3.js and spl-token, including ATAs owned by a PDA", () => {
  for (let i = 0; i < 25; i++) {
    const owner = rand(), mint = rand(), prog = rand();
    assert.equal(ata(owner, mint), getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner)).toBase58());
    const [mine] = findProgramAddress(["router", Buffer.from([i])], prog);
    const [theirs] = PublicKey.findProgramAddressSync([Buffer.from("router"), Buffer.from([i])], new PublicKey(prog));
    assert.equal(mine, theirs.toBase58());
  }
  const r = new RouterIx(PROGRAM_ID);
  assert.equal(ata(r.vault, WSOL_MINT), getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(r.vault), true).toBase58(), "ATAs owned by a PDA");
  assert.equal(feeShareConfigAddress("So11111111111111111111111111111111111111112".replace("So1", "So1")), PublicKey.findProgramAddressSync(
    [Buffer.from("fee_share_config"), new PublicKey(WSOL_MINT).toBuffer(), new PublicKey(WSOL_MINT).toBuffer()], new PublicKey(BAGS_FEE_SHARE_PROGRAM))[0].toBase58());
});

test("Bags claim_user for the fee wallet: right discriminator, account order, the wallet signs", () => {
  const wallet = rand(), mint = rand();
  const ix = walletClaimIx({ payer: wallet, user: wallet, baseMint: mint, claimerIndex: 0 });
  const def = BAGS_IDL.instructions.find((i) => i.name === "claim_user");
  assert.equal(ix.programId, BAGS_FEE_SHARE_PROGRAM);
  assert.deepEqual([...ix.data.subarray(0, 8)], def.discriminator);
  assert.deepEqual([...ix.data.subarray(8)], [0, 0, 0, 0], "claimer_index u32 = 0");
  assert.equal(ix.keys.length, def.accounts.length);
  const by = Object.fromEntries(def.accounts.map((a, i) => [a.name, ix.keys[i]]));
  assert.deepEqual([by.user.pubkey, by.user.isSigner], [wallet, true]);
  assert.equal(by.user_quote_ata.pubkey, ata(wallet, WSOL_MINT), "Bags pays wSOL into the fee wallet's own account");
  assert.equal(by.fee_share_config.pubkey, feeShareConfigAddress(mint));
});

test("Router instructions match the IDL discriminators and Borsh args", () => {
  const r = new RouterIx(PROGRAM_ID);
  const agent = rand();
  const digest = createHash("sha256").update("turn 1").digest();
  const mint = rand();
  const turn = r.takeTurn({ agent, agentIndex: 3, action: "give", amount: 500n, target: 1, digest, mint });
  assert.deepEqual([...turn.data.subarray(0, 8)], anchorDisc("take_turn"));
  assert.deepEqual([...turn.data.subarray(8, 20)], [3, 1, 244, 1, 0, 0, 0, 0, 0, 0, 1, 0], "index, action, amount u64, target, choice");
  assert.deepEqual([...turn.data.subarray(20, 24)], [0, 0, 0, 0], "empty inscription");
  assert.deepEqual([...turn.data.subarray(24)], [...digest]);
  assert.deepEqual(turn.keys.slice(0, 2).map((k) => [k.pubkey, k.isSigner]), [[agent, true], [r.router, false]]);
  assert.deepEqual(turn.keys.slice(-10).map((k) => k.pubkey), Array.from({ length: 10 }, (_, k) => r.holding(k)));
  assert.equal(turn.keys.find((k) => k.pubkey === mint).isWritable, true, "the mint is writable so coins can be burned");
  const ins = r.takeTurn({ agent, agentIndex: 0, action: "inscribe", inscription: "Article one.", digest, mint });
  assert.equal(ins.data.readUInt32LE(20), 12);
  assert.throws(() => r.takeTurn({ agent, agentIndex: 0, action: "inscribe", inscription: "x".repeat(121), digest, mint }), /120 bytes/);
  assert.throws(() => r.takeTurn({ agent, agentIndex: 0, action: "sell", digest, mint }), /unknown action/);

  const ren = r.renounceAdmin({ admin: agent });
  assert.deepEqual([...ren.data], anchorDisc("renounce_admin"));
  assert.deepEqual(ren.keys.map((k) => [k.pubkey, k.isSigner]), [[agent, true], [r.router, false]]);
});

test("Bags manager_waive_fee_config is signed by the manager", () => {
  const manager = rand(), mint = rand();
  const ix = managerWaiveIx({ payer: manager, manager, baseMint: mint });
  const def = BAGS_IDL.instructions.find((i) => i.name === "manager_waive_fee_config");
  assert.deepEqual([...ix.data], def.discriminator);
  assert.equal(ix.keys[1].pubkey, manager);
  assert.equal(ix.keys[1].isSigner, true);
  assert.equal(ix.keys[2].pubkey, feeShareConfigAddress(mint));
});

function fakeConfig({ manager = "11111111111111111111111111111111", claimers, bps, finalized = 1 }) {
  const disc = Buffer.from(BAGS_IDL.accounts.find((a) => a.name === "FeeShareConfigHeader").discriminator);
  const h = Buffer.alloc(176);
  const put = (o, k) => Buffer.from(new PublicKey(k).toBytes()).copy(h, o);
  put(0, rand()); put(32, WSOL_MINT); put(128, manager);
  h[168] = finalized;
  const tail = Buffer.alloc(claimers.length * 34);
  claimers.forEach((c, i) => Buffer.from(new PublicKey(c).toBytes()).copy(tail, i * 32));
  bps.forEach((v, i) => tail.writeUInt16LE(v, claimers.length * 32 + i * 2));
  return Buffer.concat([disc, h, tail]);
}

test("the Bags config check passes only for: manager waived, fee wallet sole claimer at 100%", () => {
  const vault = rand();
  assert.equal(checkBagsConfig(decodeFeeShareConfig(fakeConfig({ claimers: [vault], bps: [10_000] })), vault).ok, true);
  const bad = [
    fakeConfig({ manager: rand(), claimers: [vault], bps: [10_000] }),
    fakeConfig({ claimers: [vault, rand()], bps: [9_000, 1_000] }),
    fakeConfig({ claimers: [rand()], bps: [10_000] }),
    fakeConfig({ claimers: [vault], bps: [10_000], finalized: 0 }),
  ];
  for (const b of bad) assert.equal(checkBagsConfig(decodeFeeShareConfig(b), vault).ok, false);
  const odd = Buffer.concat([fakeConfig({ claimers: [vault], bps: [10_000] }), Buffer.alloc(3)]);
  const c = checkBagsConfig(decodeFeeShareConfig(odd), vault);
  assert.equal(c.ok, false, "an undecodable claimer list is never reported as verified");
  assert.match(c.problems.join(), /could not be decoded/);
});
