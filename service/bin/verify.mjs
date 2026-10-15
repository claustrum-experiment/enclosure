#!/usr/bin/env node
// Public, read-only check of CLAUSTRUM, straight from a Solana RPC node.
// Needs no keys and does not use our API or database.
//
//   node bin/verify.mjs --program <PROGRAM_ID> [--mint <CLAUSTRUM_MINT>] [--fee-wallet <ADDRESS>] [--rpc URL] [--json]
//
// With --mint and --fee-wallet it also checks pump.fun's fee sharing: 100% of the coin's creator fees
// to the fee wallet, locked.

import { parseArgs } from "node:util";
import { Connection } from "@solana/web3.js";
import { readRouterFromChain, readTokenBalance, readLamports } from "../src/chain/rpc.mjs";
import { readPumpFees } from "../src/chain/pumpfun.mjs";
import { RouterIx } from "../src/chain/router-ix.mjs";

const { values } = parseArgs({ options: { program: { type: "string" }, mint: { type: "string" }, "fee-wallet": { type: "string" }, rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" }, json: { type: "boolean", default: false } } });
if (!values.program) {
  console.error("usage: node bin/verify.mjs --program <PROGRAM_ID> [--mint <CLAUSTRUM_MINT>] [--fee-wallet <ADDRESS>] [--rpc URL] [--json]");
  process.exit(2);
}

const r = await readRouterFromChain({ rpcUrl: values.rpc, programId: values.program });
const s = r.state;
const ix = new RouterIx(values.program);
const holdings = s.claustrumMint ? await Promise.all(Array.from({ length: 10 }, (_, k) => readTokenBalance(values.rpc, ix.holding(k)))) : [];
const bowl = s.claustrumMint ? await readTokenBalance(values.rpc, ix.bowl) : null;
const sealed = s.claustrumMint ? await readTokenBalance(values.rpc, ix.sealed) : null;
const fee = values["fee-wallet"];
const feeLamports = fee ? await readLamports(values.rpc, fee) : null;
const pump = values.mint && fee ? await readPumpFees(new Connection(values.rpc, "confirmed"), values.mint, fee) : null;

if (values.json) {
  console.log(JSON.stringify({ ...r, holdings, bowl, sealed, feeWallet: fee ?? null, feeLamports, pump }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(0);
}

const sol = (l) => (Number(l) / 1e9).toFixed(4);
const line = (k, v) => console.log(`${k.padEnd(26)} ${v}`);
const R = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
console.log("CLAUSTRUM, read from chain\n");
line("Program", r.programId);
line("Program upgradeable?", r.programImmutable ? "no (upgrade authority is none)" : `YES, by ${r.upgradeAuthority}`);
line("Router account", r.routerAccount);
line("Admin", s.admin ? `${s.admin} (can still register empty alcoves / admit alcove I once)` : "renounced: nobody can change anything");
line("Mint", s.claustrumMint ?? "enclosure not set up");
line("Turns on-chain", `${s.actions}${s.actions < 50 ? ` (the Bell unlocks at 50)` : ""}`);
for (let k = 0; k < 10; k++) {
  if (!s.agents[k]) continue;
  line(`  alcove ${R[k]}`, `${s.status[k].padEnd(9)} ${holdings[k] ?? "-"} units   agent ${s.agents[k]}`);
}
if (s.claustrumMint) {
  line("Alms Bowl", `${bowl ?? 0} units`);
  line("Sealed (departed)", `${sealed ?? 0} units`);
  line("Burned in the enclosure", `${s.totalBurned} units`);
}
if (fee) {
  console.log("");
  line("Fee wallet", `${fee}  (${sol(feeLamports)} SOL)`);
  if (pump) {
    if (!pump.found) line("pump.fun coin", "no pump.fun bonding curve found for this mint");
    else {
      line("pump.fun creator", pump.creator + (pump.usingSharing ? "  (the coin's fee-sharing config)" : ""));
      if (pump.usingSharing) {
        line("  shareholders", (pump.shareholders ?? []).map((h) => `${h.address}=${h.bps / 100}%`).join(", ") || "could not read");
        line("  locked for good?", pump.locked ? "yes (pump.fun allows the split to be set only once)" : "NO, it can still be changed");
      }
      line("  fee wallet gets 100%?", pump.allToFeeWallet ? "yes" : "NO");
    }
  }
}
console.log("");
if (!s.salvation) line("Bell rung?", "no");
else {
  line("Bell rung?", "YES");
  line("  at", `slot ${s.rungSlot}, ${new Date(Number(s.rungUnixTimestamp) * 1000).toISOString()}`);
  line("  by", `alcove ${R[s.rungAgentIndex]} (${s.rungAgent})`);
  line("  chosen charity", s.chosenName);
  console.log("\nFrom here, fees in the fee wallet are donated by the operator to the chosen charity, by hand. Check the published receipts against the fee wallet's outgoing transfers.");
}
