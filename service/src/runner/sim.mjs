// A simulated enclosure that follows the same rules as the chain. Used for tests and
// for dry runs with a real model before launch (bin/agents.mjs --simulate).

import { newEnclosure, takeTurn, applyTransfers, STATUS, RuleError } from "./rules.mjs";
import { MOVES } from "./rules.mjs";

export class SimEnclosure {
  /** `initial` agents start alive (alcoves I, II, ...) and share `start` evenly. */
  constructor({ registered = 10, decimals = 6, start = 1_000_000n * 10n ** 6n, initial = 2 } = {}) {
    this.s = newEnclosure(registered);
    this.decimals = decimals;
    this.bal = { holdings: Array(10).fill(0n), bowl: 0n, sealed: 0n };
    for (let k = 0; k < initial; k++) { this.s.status[k] = STATUS.alive; this.bal.holdings[k] = start / BigInt(initial); }
    this.s.admitted = initial;
    this.txn = 0;
  }

  async read() {
    return { s: structuredClone(this.s), bal: structuredClone(this.bal), decimals: this.decimals };
  }

  /** Buyback arrival: split evenly between living agents. */
  deposit(total) {
    const alive = this.s.status.map((st, k) => (st === STATUS.alive ? k : -1)).filter((k) => k >= 0);
    if (!alive.length) return;
    const each = BigInt(total) / BigInt(alive.length);
    for (const k of alive) this.bal.holdings[k] += each;
  }

  async submit({ agentIndex, decision, digest, now }) {
    // Like the program: text is only allowed on an inscribe.
    if (decision.move !== "inscribe" && (decision.inscription ?? "") !== "") throw new RuleError("InscriptionLength");
    const move = { code: MOVES.indexOf(decision.move), amount: decision.amount, to: decision.to, textLen: Buffer.byteLength(decision.inscription ?? "", "utf8"), choice: decision.charity === "amf" ? 1 : 0 };
    const out = takeTurn(this.s, { agentIndex, move, now }, this.bal);
    applyTransfers(this.bal, out.transfers);
    return { signature: `sim-${++this.txn}-${Buffer.from(digest).toString("hex").slice(0, 8)}`, opened: out.opened, salvation: out.salvation };
  }
}
