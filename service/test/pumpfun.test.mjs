// readPumpFees against account data encoded with pump.fun's own published IDLs (via Anchor's coder),
// so the decoding is checked against pump.fun's real layouts, not against our own assumptions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readPumpFees } from "../src/chain/pumpfun.mjs";

const require = createRequire(import.meta.url);
const { BorshAccountsCoder, BN } = require("@coral-xyz/anchor");
const { feeSharingConfigPda, bondingCurvePda } = require("@pump-fun/pump-sdk");
const idlDir = require.resolve("@pump-fun/pump-sdk").replace(/dist\/index\.js$/, "src/idl/");   // the IDLs pump.fun ships with its SDK
const pumpCoder = new BorshAccountsCoder(JSON.parse(readFileSync(idlDir + "pump.json", "utf8")));
const feesCoder = new BorshAccountsCoder(JSON.parse(readFileSync(idlDir + "pump_fees.json", "utf8")));
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const z = new BN(0);

async function curve(creator, complete = false) {
  return pumpCoder.encode("BondingCurve", {
    virtual_token_reserves: z, virtual_quote_reserves: z, real_token_reserves: z, real_quote_reserves: z, token_total_supply: new BN(1e15),
    complete, creator, is_mayhem_mode: false, is_cashback_coin: false, quote_mint: PublicKey.default, creator_fee_bps: z,
    can_edit_creator_fee: false, is_holder_reward: false, creator_fee: z, protocol_fees: z, depth: 0,
    initial_virtual_quote_reserves: z, post_complete_base_out: z, post_complete_quote_in: z,
  });
}
async function sharing(mint, shareholders, { version = 2, adminRevoked = true } = {}) {
  return feesCoder.encode("SharingConfig", { bump: 255, version, status: { Active: {} }, mint, admin: Keypair.generate().publicKey, admin_revoked: adminRevoked,
    shareholders: shareholders.map(([address, share_bps]) => ({ address, share_bps })) });
}
const conn = (accounts) => ({
  async getAccountInfo(pk) { const a = accounts.get(pk.toBase58()); return a ? { data: a.data, owner: a.owner, lamports: 1, executable: false } : null; },
  async getMultipleAccountsInfo(pks) { return Promise.all(pks.map((p) => this.getAccountInfo(p))); },
});

test("fee sharing, 100% to the fee wallet, locked: reported as all fees to the fee wallet", async () => {
  const mint = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey.toBase58();
  const cfg = feeSharingConfigPda(mint);
  const acc = new Map([
    [bondingCurvePda(mint).toBase58(), { data: await curve(cfg), owner: PUMP }],
    [cfg.toBase58(), { data: await sharing(mint, [[new PublicKey(wallet), 10_000]]), owner: FEES }],
  ]);
  const r = await readPumpFees(conn(acc), mint, wallet);
  assert.equal(r.found, true); assert.equal(r.usingSharing, true); assert.equal(r.locked, true);
  assert.equal(r.feeWalletBps, 10_000); assert.equal(r.allToFeeWallet, true);
});

test("a split with someone else, an editable split, or fees still on the creator wallet are all flagged", async () => {
  const mint = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey.toBase58(), other = Keypair.generate().publicKey;
  const cfg = feeSharingConfigPda(mint);
  const split = new Map([
    [bondingCurvePda(mint).toBase58(), { data: await curve(cfg), owner: PUMP }],
    [cfg.toBase58(), { data: await sharing(mint, [[new PublicKey(wallet), 9_000], [other, 1_000]], { adminRevoked: false }), owner: FEES }],
  ]);
  const a = await readPumpFees(conn(split), mint, wallet);
  assert.equal(a.feeWalletBps, 9_000); assert.equal(a.allToFeeWallet, false); assert.equal(a.locked, false);
  const own = new Map([[bondingCurvePda(mint).toBase58(), { data: await curve(other), owner: PUMP }]]);
  const b = await readPumpFees(conn(own), mint, wallet);
  assert.equal(b.usingSharing, false); assert.equal(b.allToFeeWallet, false); assert.equal(b.creator, other.toBase58());
  const self = new Map([[bondingCurvePda(mint).toBase58(), { data: await curve(new PublicKey(wallet), true), owner: PUMP }]]);
  const c = await readPumpFees(conn(self), mint, wallet);
  assert.equal(c.creatorIsFeeWallet, true); assert.equal(c.allToFeeWallet, true); assert.equal(c.graduated, true);
  assert.equal((await readPumpFees(conn(new Map()), mint, wallet)).found, false);
});
