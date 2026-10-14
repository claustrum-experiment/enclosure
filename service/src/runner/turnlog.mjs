// The turn log, append-only, never edited. Two files:
//
//   turns.jsonl        public, live: every move, its public reason, the Constitution lines,
//                      and the digest that was recorded on-chain for the turn.
//   turns-full.jsonl   private until the Bell: the same entries plus the exact prompt,
//                      the exact answer and the agent's private memory note.
//
// The digest on-chain commits to the full entry at the moment of the turn. After the
// Bell the full file is published (bin/reveal.mjs), and anyone can re-hash every entry
// and match it to the chain: nothing in it can have been changed after the fact.

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STATUS } from "./rules.mjs";
import { ROMAN, describe, fmtUnits } from "./prompt.mjs";

export class MemoryLog {
  constructor() { this.items = []; }
  append(e) { this.items.push(e); }
  entries() { return this.items; }
}

/** What may be shown while the courtyard exists: no prompt, no raw answer, no private memory. */
export function publicEntry(e) {
  const { prompt, answer, memory, ...pub } = e;
  return { ...pub, hasPrivateMemory: !!memory };
}

export class FileLog {
  /**
   * @param publicPath   e.g. public/turns.jsonl (served)
   * @param privatePath  e.g. private/turns-full.jsonl (never served before the Bell)
   */
  constructor(publicPath, privatePath) {
    if (!privatePath) throw new Error("FileLog needs a private path for the full record");
    this.publicPath = publicPath;
    this.privatePath = privatePath;
    for (const p of [publicPath, privatePath]) mkdirSync(dirname(p), { recursive: true });
    this.items = existsSync(privatePath) ? readFileSync(privatePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  append(e) {
    appendFileSync(this.privatePath, JSON.stringify(e) + "\n");
    appendFileSync(this.publicPath, JSON.stringify(publicEntry(e)) + "\n");
    this.items.push(e);
  }
  entries() { return this.items; }
}

/** The snapshot the website reads: who is where, what they hold, the book, the recent record. */
export function enclosureSnapshot({ s, bal, decimals }, entries, extra = {}) {
  const u = (x) => fmtUnits(x, decimals);
  const last = (k) => [...entries].reverse().find((e) => e.agentIndex === k) ?? null;
  return {
    updatedAt: new Date().toISOString(),
    decimals,
    totalTurns: s.actions,
    bellUnlocked: s.actions >= 50,
    salvation: s.salvation ? { charity: s.chosen === 1 ? "Against Malaria Foundation" : "Eleos AI Research", lastWords: [...entries].reverse().find((e) => e.move === "bell")?.lastWords ?? null } : null,
    bowl: u(bal.bowl),
    sealed: u(bal.sealed),
    burned: u(s.totalBurned ?? 0n),
    alcoves: Array.from({ length: 10 }, (_, k) => {
      const e = last(k);
      return {
        alcove: ROMAN[k],
        wallet: s.agentKeys?.[k] ?? null,
        status: ["empty", "alive", "departed", "gone"][s.status[k]],
        holds: s.status[k] === STATUS.alive ? u(bal.holdings[k]) : null,
        turns: s.turns[k],
        movesInARow: s.streak[k],
        lastMove: e ? { move: e.move, text: describe(e, u), reason: e.reason, at: e.at, tx: e.tx } : null,
      };
    }),
    constitution: entries.filter((e) => e.move === "inscribe" && e.inscription).map((e) => ({ alcove: ROMAN[e.agentIndex], text: e.inscription, at: e.at, tx: e.tx })),
    record: entries.slice(-100).reverse().map((e) => ({ at: e.at, alcove: ROMAN[e.agentIndex], move: e.move, text: describe(e, u), reason: e.reason, note: e.note, digest: e.digest, tx: e.tx })),
    ...extra,
  };
}

export function writeSnapshot(path, snap) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snap, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
