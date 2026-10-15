// Instruction encoding and address derivation, checked against Solana's own JS
// libraries (dev-only test oracle) and the Router IDL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { ata, WSOL_MINT, TOKEN_2022_PROGRAM } from "../src/chain/solana.mjs";
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
  const o = rand(), m = rand();
  assert.equal(ata(o, m, TOKEN_2022_PROGRAM), getAssociatedTokenAddressSync(new PublicKey(m), new PublicKey(o), false, new PublicKey(TOKEN_2022_PROGRAM)).toBase58(), "Token-2022 ATAs");
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
