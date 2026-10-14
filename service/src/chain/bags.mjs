// Bags fee-share (v2) program: what the Router needs from it.
//
// Facts taken from Bags' own published IDL (vendor/bags/fee-share-v2.idl.json, MIT):
// * Fees accrue per token in a FeeShareConfig with a list of claimers and their bps.
// * `claim_user` pays a claimer's share as wSOL into ATA(claimer, wSOL). The claimer
//   must sign; a separate `payer` funds account creation. A program address can be the
//   claimer, because the Router signs for its vault by CPI.
// * A per-token `manager` can rewrite claimers. `manager_waive_fee_config` sets the
//   manager to nobody, permanently.
// * Bags' own program admin can still rewrite claimers (`update_fee_config`) or appoint a
//   manager (`update_fee_config_manager`). That cannot be removed by us; it is monitored.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encode } from "../base58.mjs";
import { loadIdl, buildIx } from "./idl.mjs";
import { findProgramAddress } from "./pda.mjs";

export const BAGS_IDL = loadIdl(fileURLToPath(new URL("../../vendor/bags/fee-share-v2.idl.json", import.meta.url)));
export const BAGS_FEE_SHARE_PROGRAM = BAGS_IDL.address;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findProgramAddress([b(owner), b(tokenProgram), b(mint)], ATA_PROGRAM)[0];
function b(addr) { return Buffer.from(fromB58(addr)); }
import { decode as fromB58 } from "../base58.mjs";

export const feeShareConfigAddress = (baseMint, quoteMint = WSOL_MINT) => findProgramAddress(["fee_share_config", b(baseMint), b(quoteMint)], BAGS_FEE_SHARE_PROGRAM)[0];
export const programConfigAddress = () => findProgramAddress(["program_config"], BAGS_FEE_SHARE_PROGRAM)[0];

const discriminator = (name) => Buffer.from(BAGS_IDL.accounts.find((a) => a.name === name).discriminator);
const HEADER_LEN = 176; // bytemuck repr(C): 5 pubkeys, u64 padding, 2 flags, 5 padding, bump

/**
 * Decode a FeeShareConfig account. The header is a fixed C layout and is decoded with
 * certainty. The claimer list after it is variable-length; it is decoded only if its
 * length fits exactly `n` pubkeys followed by `n` u16 bps. Otherwise `claimers` is null
 * and the caller must not treat the config as verified.
 */
export function decodeFeeShareConfig(data) {
  const buf = Buffer.from(data);
  if (!buf.subarray(0, 8).equals(discriminator("FeeShareConfigHeader"))) throw new Error("not a Bags FeeShareConfig account");
  const h = buf.subarray(8);
  if (h.length < HEADER_LEN) throw new Error("FeeShareConfig too short");
  const pk = (o) => encode(h.subarray(o, o + 32));
  const out = {
    baseMint: pk(0), quoteMint: pk(32), partner: pk(64), partnerConfig: pk(96), manager: pk(128),
    isInitFinalized: h[168] === 1, isUpdateLocked: h[169] === 1, bump: h[175],
    claimers: null, bps: null,
  };
  const rest = h.subarray(HEADER_LEN);
  if (rest.length > 0 && rest.length % 34 === 0) {
    const n = rest.length / 34;
    out.claimers = Array.from({ length: n }, (_, i) => encode(rest.subarray(i * 32, i * 32 + 32)));
    out.bps = Array.from({ length: n }, (_, i) => rest.readUInt16LE(n * 32 + i * 2));
  }
  return out;
}

/** The checks the public verifier runs against the token's Bags config. */
/** `expected` is the address that should receive 100% of the fees (the fee wallet). */
export function checkBagsConfig(cfg, expected) {
  const problems = [];
  if (cfg.manager !== DEFAULT_PUBKEY) problems.push(`the fee-share manager (${cfg.manager}) has not been waived, so it can still change who receives fees`);
  if (!cfg.isInitFinalized) problems.push("the Bags fee config is not finalized");
  if (cfg.claimers === null) problems.push("the claimer list could not be decoded; check it by hand");
  else if (!(cfg.claimers.length === 1 && cfg.claimers[0] === expected && cfg.bps[0] === 10_000)) {
    problems.push(`the fee wallet is not the sole claimer at 100% (claimers: ${cfg.claimers.map((c, i) => `${c}=${cfg.bps[i]}bps`).join(", ")})`);
  }
  return {
    ok: problems.length === 0,
    managerWaived: cfg.manager === DEFAULT_PUBKEY,
    soleClaimer: cfg.claimers !== null && cfg.claimers.length === 1 && cfg.claimers[0] === expected && cfg.bps[0] === 10_000,
    problems,
    residualTrust: "Bags' own program admin can still change claimers or appoint a manager. This cannot be removed by CLAUSTRUM.",
  };
}

// ------------------------------------------------------------------ instructions

/** Bags `claim_user` for an ordinary wallet that signs for itself (the fee wallet). */
export function walletClaimIx({ payer, user, baseMint, claimerIndex }) {
  return buildIx(BAGS_IDL, "claim_user", {
    accounts: { payer, user, base_mint: baseMint, quote_mint: WSOL_MINT, system_program: SYSTEM_PROGRAM, token_program: TOKEN_PROGRAM, associated_token_program: ATA_PROGRAM, program: BAGS_FEE_SHARE_PROGRAM },
    args: { params: { claimer_index: claimerIndex } },
  });
}

/** Bags `manager_waive_fee_config`: the manager gives up the role for good. Signed by the manager. */
export function managerWaiveIx({ payer, manager, baseMint }) {
  return buildIx(BAGS_IDL, "manager_waive_fee_config", {
    accounts: { payer, manager, base_mint: baseMint, quote_mint: WSOL_MINT, system_program: SYSTEM_PROGRAM, program: BAGS_FEE_SHARE_PROGRAM },
  });
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
