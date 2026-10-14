#!/usr/bin/env node
// Generates every CLAUSTRUM key, locally, with no dependencies (Node's own ed25519).
//
//   node bin/keygen.mjs --out <folder>
//
// Writes (refuses to overwrite anything that already exists):
//   admin.json                 the single admin wallet (Solana keypair file)
//   admin.phantom-import.txt   the same key as a base58 private key, for importing into Phantom/Solflare
//   operator.json              signs the charity config (keep offline; never on the server)
//   cranker.json               pays transaction fees, triggers claims and swaps
//   buyback-executor.json      buys $CLAUSTRUM with claimed fees and pays it into holdings
//   alcove-1.json ... alcove-10.json   the ten agents (need no SOL)
//   agents.json                the ten agent public keys, in alcove order (for setup)
//   public-keys.json           every public key, safe to share
//   .env.example               the settings the services read, with placeholders

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) { console.error("usage: node bin/keygen.mjs --out <folder>"); process.exit(2); }

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
function newKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url"), pub = Buffer.from(jwk.x, "base64url");
  const secret = Uint8Array.from([...seed, ...pub]);
  return { secret, pubkey: b58(pub) };
}

const names = ["admin", "operator", "cranker", "buyback-executor", ...Array.from({ length: 10 }, (_, k) => `alcove-${k + 1}`)];
const files = [...names.map((n) => `${n}.json`), "admin.phantom-import.txt", "agents.json", "public-keys.json", ".env.example"];
mkdirSync(values.out, { recursive: true });
const clash = files.filter((f) => existsSync(join(values.out, f)));
if (clash.length) { console.error(`refusing to overwrite: ${clash.join(", ")}`); process.exit(1); }

const keys = Object.fromEntries(names.map((n) => [n, newKey()]));
for (const n of names) writeFileSync(join(values.out, `${n}.json`), JSON.stringify([...keys[n].secret]), { mode: 0o600 });
writeFileSync(join(values.out, "admin.phantom-import.txt"),
  `Admin wallet ${keys.admin.pubkey}\n\nPrivate key (base58) - paste into Phantom: Add wallet > Import private key.\nAnyone with this line controls the admin wallet. Never share it or upload it.\n\n${b58(keys.admin.secret)}\n`, { mode: 0o600 });
const pub = Object.fromEntries(names.map((n) => [n, keys[n].pubkey]));
const agents = Array.from({ length: 10 }, (_, k) => pub[`alcove-${k + 1}`]);
writeFileSync(join(values.out, "agents.json"), JSON.stringify(agents, null, 2) + "\n");
writeFileSync(join(values.out, "public-keys.json"), JSON.stringify(pub, null, 2) + "\n");
writeFileSync(join(values.out, ".env.example"), [
  "# Copy to .env and fill in. Never commit or share .env.",
  "RPC_URL=",
  "JUPITER_API_KEY=",
  "LLM_BASE_URL=https://openrouter.ai/api/v1",
  "LLM_API_KEY=",
  "LLM_MODEL=",
  "PROGRAM_ID=",
  "CLAUSTRUM_MINT=",
  `OPERATOR_PUBKEY=${pub.operator}`,
  "CRANKER_KEYPAIR=./keys/cranker.json",
  "AGENT_KEYS_DIR=./keys",
  "OUT_DIR=./public",
  "PRIVATE_DIR=./private",
  "",
].join("\n"), { mode: 0o600 });

console.log("Generated (public keys only shown):");
for (const n of names) console.log(`  ${n.padEnd(17)} ${pub[n]}`);
console.log(`\nSecrets are in ${values.out}. Back the folder up offline. operator.json should not live on the server.`);
