// Decoders for on-chain accounts, so anyone can verify Salvation from raw chain data
// without trusting our API. Layouts match programs/claustrum-router (Anchor/Borsh);
// test/verify.test.mjs checks this against bytes produced by the Rust program itself.

import { createHash } from "node:crypto";
import { encode } from "../base58.mjs";

export const ROUTER_DISCRIMINATOR = createHash("sha256").update("account:Router").digest().subarray(0, 8);

class Reader {
  constructor(buf) { this.b = Buffer.from(buf); this.o = 0; }
  u8() { return this.b.readUInt8(this.o++); }
  bool() { const v = this.u8(); if (v > 1) throw new Error("bad bool"); return v === 1; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  pubkey() { const v = encode(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  option(f) { const tag = this.u8(); if (tag > 1) throw new Error("bad option tag"); return tag === 1 ? f() : null; }
  arr(n, f) { return Array.from({ length: n }, () => f()); }
}

const CHOICES = ["Eleos AI Research", "Against Malaria Foundation"];
const STATUS = ["empty", "alive", "departed", "gone"];

export function decodeRouter(data) {
  const buf = Buffer.from(data);
  if (!buf.subarray(0, 8).equals(ROUTER_DISCRIMINATOR)) throw new Error("not a CLAUSTRUM Router account");
  const r = new Reader(buf.subarray(8));
  const u64x2 = () => r.arr(2, () => r.u64());
  const out = {
    admin: r.option(() => r.pubkey()),
    cranker: r.pubkey(),
    swapProgram: r.option(() => r.pubkey()),
    feeProgram: r.option(() => r.pubkey()),
    buybackAccount: r.option(() => r.pubkey()),
    agents: r.arr(10, () => r.option(() => r.pubkey())),
    actions: r.u32(),
    destinations: r.arr(2, () => r.option(() => ({ owner: r.pubkey(), mint: r.pubkey(), tokenAccount: r.pubkey() }))),
    salvation: r.bool(),
    rungSlot: r.u64(),
    rungUnixTimestamp: r.i64(),
    rungAgentIndex: r.u8(),
    rungAgent: r.pubkey(),
    chosen: r.u8(),
    pendingLamports: u64x2(),
    escrowAmount: u64x2(),
    totalCreditedLamports: u64x2(),
    totalSwappedLamports: u64x2(),
    totalSwappedOut: u64x2(),
    totalDelivered: u64x2(),
    deliveries: r.u64(),
    totalClaimed: r.u64(),
    claimedAfterSalvation: r.u64(),
    claustrumMint: r.option(() => r.pubkey()),
    status: r.arr(10, () => STATUS[r.u8()] ?? "unknown"),
    streak: r.arr(10, () => r.u8()),
    lastTurnAt: r.arr(10, () => r.i64()),
    turns: r.arr(10, () => r.u32()),
    admitted: r.u8(),
    totalBurned: r.u64(),
    bump: r.u8(),
    vaultBump: r.u8(),
  };
  out.chosenName = out.salvation ? CHOICES[out.chosen] ?? "unknown" : null;
  out.adminRevoked = out.admin === null;
  return out;
}

/**
 * Upgradeable BPF loader accounts.
 * Program account:     u32 tag = 2, programdata address (32)
 * ProgramData account: u32 tag = 3, u64 slot, Option<Pubkey> upgrade authority
 */
export function decodeProgramAccount(data) {
  const r = new Reader(data);
  if (r.u32() !== 2) throw new Error("not an upgradeable program account");
  return { programData: r.pubkey() };
}

export function decodeProgramData(data) {
  const r = new Reader(data);
  if (r.u32() !== 3) throw new Error("not a programdata account");
  const slot = r.u64();
  return { lastDeploySlot: slot, upgradeAuthority: r.option(() => r.pubkey()) };
}
