// Program-derived addresses without dependencies: sha256 plus an ed25519 on-curve test.
import { createHash } from "node:crypto";
import { decode, encode } from "../base58.mjs";

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; };
const D = mod(-121665n * pow(121666n, P - 2n));

/** True if 32 bytes decode to a point on ed25519 (i.e. could have a private key). */
export function isOnCurve(bytes) {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * pow(mod(D * y2 + 1n), P - 2n));
  if (x2 === 0n) return (bytes[31] & 0x80) === 0;
  return pow(x2, (P - 1n) / 2n) === 1n;
}

export function findProgramAddress(seeds, programId) {
  const pid = typeof programId === "string" ? decode(programId) : Uint8Array.from(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(typeof s === "string" ? Buffer.from(s) : Buffer.from(s));
    h.update(Buffer.from([bump])).update(pid).update(Buffer.from("ProgramDerivedAddress"));
    const out = h.digest();
    if (!isOnCurve(out)) return [encode(out), bump];
  }
  throw new Error("no viable bump");
}

export const routerAddress = (programId) => findProgramAddress(["router"], programId);
export const vaultAddress = (programId) => findProgramAddress(["vault"], programId);
export const escrowAddress = (programId, recipient) => findProgramAddress(["escrow", Uint8Array.of(recipient)], programId);
