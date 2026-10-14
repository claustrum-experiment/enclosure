#!/usr/bin/env node
// Writes public/verify.json for the website's "Verify" panel: what the chain says right now,
// read straight from an RPC node every few minutes by a systemd timer. No keys are used.
//
//   node bin/site-verify.mjs [--out public/verify.json]
//
// Environment: RPC_URL, PROGRAM_ID, CLAUSTRUM_MINT (optional), FEE_WALLET (optional; defaults to the
// public key of EXECUTOR_KEYPAIR), PUBLISHED_PROGRAM_HASH (optional; defaults to the hash in this file).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { parseArgs } from "node:util";
import { Keypair } from "@solana/web3.js";
import { readRouterFromChain, readLamports, readTokenBalance } from "../src/chain/rpc.mjs";
import { decodeProgramAccount } from "../src/chain/decode.mjs";
import { RouterIx } from "../src/chain/router-ix.mjs";

// SHA-256 of the program we compiled and deployed (trailing zero bytes removed, as solana-verify does).
export const PUBLISHED_PROGRAM_HASH = "5458e2211eb163d9024791cde5f3f6f5238b1e6eb7ec8e7db4132ad382a529f0";
const PROGRAMDATA_HEADER = 45;

const { values } = parseArgs({ options: { out: { type: "string", default: "public/verify.json" } } });
const rpcUrl = process.env.RPC_URL, programId = process.env.PROGRAM_ID;
if (!rpcUrl || !programId) { console.error("RPC_URL and PROGRAM_ID are required"); process.exit(2); }

async function rpc(method, params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result;
}

/** Hash of the executable bytes on chain, comparable to `solana-verify get-program-hash`. */
export function programHash(programData) {
  let end = programData.length;
  while (end > PROGRAMDATA_HEADER && programData[end - 1] === 0) end--;
  return createHash("sha256").update(programData.subarray(PROGRAMDATA_HEADER, end)).digest("hex");
}

const feeWallet = process.env.FEE_WALLET
  || (process.env.EXECUTOR_KEYPAIR ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.EXECUTOR_KEYPAIR, "utf8")))).publicKey.toBase58() : null);

const r = await readRouterFromChain({ rpcUrl, programId });
const prog = await rpc("getAccountInfo", [programId, { encoding: "base64" }]);
const { programData } = decodeProgramAccount(Buffer.from(prog.value.data[0], "base64"));
const pd = await rpc("getAccountInfo", [programData, { encoding: "base64" }]);
const hash = programHash(Buffer.from(pd.value.data[0], "base64"));
const deployedAt = await rpc("getBlockTime", [Number(r.lastDeploySlot)]).catch(() => null);
const s = r.state, mint = s.claustrumMint || null, ix = new RouterIx(programId);
const published = process.env.PUBLISHED_PROGRAM_HASH || PUBLISHED_PROGRAM_HASH;

const out = {
  checkedAt: new Date().toISOString(),
  program: {
    id: programId, programData,
    upgradeable: !r.programImmutable, upgradeAuthority: r.upgradeAuthority,
    lastDeploySlot: String(r.lastDeploySlot), lastDeployedAt: deployedAt ? new Date(deployedAt * 1000).toISOString() : null,
    hash, publishedHash: published, matchesPublished: hash === published,
  },
  router: {
    account: r.routerAccount,
    admin: s.admin || null, adminRenounced: !s.admin,
    mint, actions: Number(s.actions), salvation: !!s.salvation,
    agents: s.agents.map((a, k) => (a ? { alcove: k + 1, wallet: a, status: s.status[k] } : null)),
  },
  feeWallet: feeWallet ? { address: feeWallet, sol: Number(await readLamports(rpcUrl, feeWallet)) / 1e9 } : null,
  holdingsTotal: mint ? String((await Promise.all(Array.from({ length: 10 }, (_, k) => readTokenBalance(rpcUrl, ix.holding(k))))).reduce((t, b) => t + (b ?? 0n), 0n)) : null,
};
writeFileSync(values.out + ".tmp", JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
renameSync(values.out + ".tmp", values.out);
console.log(`verify.json: upgradeable=${out.program.upgradeable} hashMatches=${out.program.matchesPublished} adminRenounced=${out.router.adminRenounced} feeWallet=${out.feeWallet?.sol ?? "-"} SOL`);
