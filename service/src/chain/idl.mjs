// Build Anchor instructions from an IDL: discriminator, Borsh-encoded args, and the
// account list in IDL order. PDAs declared in the IDL are derived automatically, so
// account addresses are computed, not typed in.

import { readFileSync } from "node:fs";
import { decode as b58decode } from "../base58.mjs";
import { findProgramAddress } from "./pda.mjs";

export function loadIdl(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ------------------------------------------------------------------ Borsh

function encodeValue(type, value, out, idl) {
  if (typeof type === "string") {
    switch (type) {
      case "u8": out.push(Buffer.from([Number(value)])); return;
      case "bool": out.push(Buffer.from([value ? 1 : 0])); return;
      case "u16": { const b = Buffer.alloc(2); b.writeUInt16LE(Number(value)); out.push(b); return; }
      case "u32": { const b = Buffer.alloc(4); b.writeUInt32LE(Number(value)); out.push(b); return; }
      case "u64": { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); out.push(b); return; }
      case "i64": { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); out.push(b); return; }
      case "pubkey": { const k = b58decode(value); if (k.length !== 32) throw new Error("pubkey arg must be 32 bytes"); out.push(Buffer.from(k)); return; }
      case "bytes": { const v = Buffer.from(value); const l = Buffer.alloc(4); l.writeUInt32LE(v.length); out.push(l, v); return; }
      case "string": { const v = Buffer.from(String(value), "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(v.length); out.push(l, v); return; }
      default: throw new Error(`unsupported IDL type ${type}`);
    }
  }
  if (type.array) {
    const [inner, len] = type.array;
    if (value.length !== len) throw new Error(`array must have ${len} items`);
    for (const v of value) encodeValue(inner, v, out, idl);
    return;
  }
  if (type.vec) {
    const l = Buffer.alloc(4); l.writeUInt32LE(value.length); out.push(l);
    for (const v of value) encodeValue(type.vec, v, out, idl);
    return;
  }
  if (type.option !== undefined) {
    if (value === null || value === undefined) { out.push(Buffer.from([0])); return; }
    out.push(Buffer.from([1])); encodeValue(type.option, value, out, idl); return;
  }
  if (type.defined) {
    const name = typeof type.defined === "string" ? type.defined : type.defined.name;
    const def = idl.types.find((t) => t.name === name);
    if (!def || def.type.kind !== "struct") throw new Error(`unsupported defined type ${name}`);
    for (const f of def.type.fields) encodeValue(f.type, value[f.name], out, idl);
    return;
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}

export function encodeArgs(idl, ix, args) {
  const out = [Buffer.from(ix.discriminator)];
  for (const a of ix.args) {
    if (!(a.name in args)) throw new Error(`${ix.name}: missing arg ${a.name}`);
    encodeValue(a.type, args[a.name], out, idl);
  }
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ accounts

function seedBytes(seed, known, args, ixName) {
  if (seed.kind === "const") return Buffer.from(seed.value);
  if (seed.kind === "account") {
    const v = known[seed.path];
    if (!v) return null;
    return Buffer.from(b58decode(v));
  }
  if (seed.kind === "arg") {
    const v = args[seed.path];
    if (v === undefined) throw new Error(`${ixName}: seed needs arg ${seed.path}`);
    return typeof v === "number" ? Buffer.from([v]) : Buffer.from(v);
  }
  throw new Error(`${ixName}: unsupported seed kind ${seed.kind}`);
}

/** Fill in every account the IDL can derive (fixed addresses and PDAs) from the ones given. */
export function resolveAccounts(idl, ixName, given, args = {}) {
  const ix = idl.instructions.find((i) => i.name === ixName);
  if (!ix) throw new Error(`no instruction ${ixName} in ${idl.metadata?.name}`);
  const known = { ...given };
  let progress = true;
  while (progress) {
    progress = false;
    for (const acc of ix.accounts) {
      if (known[acc.name]) continue;
      if (acc.address) { known[acc.name] = acc.address; progress = true; continue; }
      if (!acc.pda) continue;
      const parts = acc.pda.seeds.map((s) => seedBytes(s, known, args, ixName));
      if (parts.some((p) => p === null)) continue;
      let programId = idl.address;
      if (acc.pda.program) {
        if (acc.pda.program.kind === "const") programId = Buffer.from(acc.pda.program.value);
        else if (acc.pda.program.kind === "account") { programId = known[acc.pda.program.path]; if (!programId) continue; }
      }
      known[acc.name] = findProgramAddress(parts, programId)[0];
      progress = true;
    }
  }
  return { ix, known };
}

/**
 * @returns {{ programId: string, keys: {pubkey: string, isSigner: boolean, isWritable: boolean}[], data: Buffer }}
 * Optional accounts left out are passed as the program id (Anchor's "None").
 * `signers` lets the caller drop the signer flag for PDAs that sign by CPI.
 */
export function buildIx(idl, ixName, { accounts = {}, args = {}, remaining = [], cpiSigners = [] } = {}) {
  const { ix, known } = resolveAccounts(idl, ixName, accounts, args);
  const keys = ix.accounts.map((acc) => {
    const pubkey = known[acc.name];
    if (!pubkey) {
      if (acc.optional) return { pubkey: idl.address, isSigner: false, isWritable: false };
      throw new Error(`${ixName}: account ${acc.name} not provided and not derivable`);
    }
    const isSigner = !!acc.signer && !cpiSigners.includes(acc.name);
    return { pubkey, isSigner, isWritable: !!acc.writable };
  });
  return { programId: idl.address, keys: [...keys, ...remaining], data: encodeArgs(idl, ix, args), named: known };
}
