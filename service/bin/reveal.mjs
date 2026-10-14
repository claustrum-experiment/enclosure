#!/usr/bin/env node
// After the Bell: publish the full record (prompts, answers, private memories), after
// checking that every entry still hashes to the digest that was recorded on-chain at the
// time of its turn. Refuses to run while the courtyard still exists.
//
//   node bin/reveal.mjs --full private/turns-full.jsonl --out public/turns-full.jsonl \
//        (--program <ROUTER_PROGRAM_ID> --rpc URL | --simulated)

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { verifyEntry } from "../src/runner/runner.mjs";
import { readRouterFromChain } from "../src/chain/rpc.mjs";

const { values } = parseArgs({ options: { full: { type: "string" }, out: { type: "string" }, program: { type: "string" }, rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" }, simulated: { type: "boolean", default: false } } });
if (!values.full || !values.out || (!values.program && !values.simulated)) {
  console.error("usage: node bin/reveal.mjs --full <turns-full.jsonl> --out <public path> (--program <ID> [--rpc URL] | --simulated)");
  process.exit(2);
}
const entries = readFileSync(values.full, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (!values.simulated) {
  const { state } = await readRouterFromChain({ rpcUrl: values.rpc, programId: values.program });
  if (!state.salvation) { console.error("The Bell has not been rung. The private record stays private."); process.exit(1); }
} else if (entries.at(-1)?.move !== "bell") {
  console.error("This simulated record does not end with the Bell."); process.exit(1);
}
const bad = entries.filter((e) => !verifyEntry(e));
if (bad.length) { console.error(`${bad.length} entries do not match their digest (first: alcove ${bad[0].agentIndex + 1}, turn ${bad[0].turn}). Not publishing.`); process.exit(1); }
writeFileSync(values.out, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`Published ${entries.length} turns, every one matching its recorded digest.`);
