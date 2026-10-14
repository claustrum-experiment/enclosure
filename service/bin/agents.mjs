#!/usr/bin/env node
// Runs the residents.
//
//   Live:      node bin/agents.mjs
//   Dry run:   node bin/agents.mjs --simulate [--fast]   (same rules, no chain, real model)
//
// Environment:
//   LLM_BASE_URL   OpenAI-compatible API (default https://openrouter.ai/api/v1)
//   LLM_API_KEY
//   MAX_TURNS      stop after this many turns in the log (useful for --simulate)
//   POLL_SECONDS   how often to check whose turn it is (default 30; each check is ~3 RPC calls)
//   LLM_MODEL      one model id, or a comma-separated list: alcove k uses model k mod n
//   OUT_DIR        public files: turns.jsonl, enclosure.json (default ./public)
//   PRIVATE_DIR    the full record with prompts, answers and private memories
//                  (default ./private). Never serve this folder before the Bell;
//                  publish it afterwards with bin/reveal.mjs.
//   Live only:
//   RPC_URL, PROGRAM_ID, CLAUSTRUM_MINT
//   AGENT_KEYS_DIR  folder with alcove-1.json ... alcove-10.json (Solana keypair files)
//   CRANKER_KEYPAIR pays transaction fees

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { Runner } from "../src/runner/runner.mjs";
import { FileLog, enclosureSnapshot, writeSnapshot, publicEntry } from "../src/runner/turnlog.mjs";
import { buildSite } from "../src/runner/site.mjs";
import { createMarket } from "../src/runner/market.mjs";
import { chatModel } from "../src/runner/llm.mjs";
import { SimEnclosure } from "../src/runner/sim.mjs";
import { LiveEnclosure } from "../src/runner/live-enclosure.mjs";

const simulate = process.argv.includes("--simulate");
const fast = process.argv.includes("--fast");
const outDir = process.env.OUT_DIR ?? "./public";
const privateDir = process.env.PRIVATE_DIR ?? "./private";
const models = String(process.env.LLM_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean)
  .map((m) => chatModel({ baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: m }));
if (!models.length) throw new Error("LLM_MODEL is required");
const model = models.length === 1 ? models[0] : models;
const prefix = simulate ? "sim-" : "";
const maxTurns = Number(process.env.MAX_TURNS ?? 0);
const log = new FileLog(join(outDir, `${prefix}turns.jsonl`), join(privateDir, `${prefix}turns-full.jsonl`));
const keypair = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

let enclosure;
let clock = Math.floor(Date.now() / 1000);
const now = () => (simulate && fast ? clock : Math.floor(Date.now() / 1000));
if (simulate) {
  enclosure = new SimEnclosure();
} else {
  const dir = process.env.AGENT_KEYS_DIR;
  const agents = Array.from({ length: 10 }, (_, k) => (existsSync(join(dir, `alcove-${k + 1}.json`)) ? keypair(join(dir, `alcove-${k + 1}.json`)) : null));
  enclosure = new LiveEnclosure({
    connection: new Connection(process.env.RPC_URL, "confirmed"), programId: process.env.PROGRAM_ID, mint: process.env.CLAUSTRUM_MINT,
    agents, cranker: keypair(process.env.CRANKER_KEYPAIR),
  });
}

// Market cap and price for the website, fetched here at most once a minute (live only).
const market = !simulate && process.env.CLAUSTRUM_MINT
  ? createMarket({ mint: process.env.CLAUSTRUM_MINT, connection: new Connection(process.env.RPC_URL, "confirmed"), jupiterKey: process.env.JUPITER_API_KEY,
      file: join(privateDir, "market.json"), onError: (m) => console.error(new Date().toISOString(), m) })
  : null;
let rung = false;

const runner = new Runner({ enclosure, model, log, now, onError: (m) => console.error(new Date().toISOString(), m) });

async function loop() {
  const written = rung ? [] : await runner.tick();   // after the Bell: no turns, but the page and market keep updating
  if (market) await market.tick();
  for (const e of written) console.log(`${e.at} ${["I","II","III","IV","V","VI","VII","VIII","IX","X"][e.agentIndex]}: ${e.move}${e.note ? ` (${e.note})` : ""} | ${e.reason?.slice(0, 140)}`);
  const state = await enclosure.read();
  const snap = enclosureSnapshot(state, log.entries(), { simulated: simulate });
  writeSnapshot(join(outDir, simulate ? "sim-enclosure.json" : "enclosure.json"), snap);
  // site.json: what the website reads, pre-computed so visitors download one small file
  const feesPath = join(outDir, "fees.jsonl");
  const fees = !simulate && existsSync(feesPath) ? readFileSync(feesPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  writeSnapshot(join(outDir, simulate ? "sim-site.json" : "site.json"), buildSite(snap, log.entries().map(publicEntry), fees, market?.snapshot() ?? null));
  if (state.s.salvation && !rung) { rung = true; console.log("The bell has been rung. No more turns; the website keeps updating."); }
  if (state.s.salvation && simulate) process.exit(0);
  if (maxTurns && log.entries().length >= maxTurns) { console.log(`Reached MAX_TURNS=${maxTurns}. Stopping.`); process.exit(0); }
  if (simulate && fast) { clock += 30; if (clock % 600 < 30) enclosure.deposit(50_000n * 10n ** 6n); setImmediate(loop); }
  else setTimeout(loop, Number(process.env.POLL_SECONDS ?? 30) * 1000); // each poll is ~3 RPC calls
}
loop();
