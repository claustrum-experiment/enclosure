// The agent runner: the loop that gives each resident its turns.
//
// For each turn: read the courtyard, work out the legal moves, ask the model, check its
// answer against the rules, take the turn on-chain with a digest of the exact prompt and
// answer, and append the full record to the public turn log. The chain enforces the
// rules again; this side only avoids sending turns that would be refused.

import { createHash } from "node:crypto";
import { legalMoves, STATUS, MIN_TURN_GAP_SECS } from "./rules.mjs";
import { buildMessages } from "./prompt.mjs";
import { interpretAnswer } from "./answer.mjs";
import { canonicalJson } from "../canonical.mjs";

/** The digest recorded on-chain for a turn. The published log entry hashes to exactly this. */
export function turnDigest({ agentIndex, turn, prompt, answer }) {
  return createHash("sha256").update(canonicalJson({ agentIndex, turn, prompt, answer })).digest();
}

export class Runner {
  /**
   * @param o.enclosure  { read(), submit({agentIndex, decision, digest, now}) }
   * @param o.model      async (messages) => { text, model }, or an array of them (one per alcove, cycling)
   * @param o.log        { append(entry), entries() }
   * @param o.now        () => seconds
   */
  constructor({ enclosure, model, log, now = () => Math.floor(Date.now() / 1000), onError = () => {}, memoryBudget = 6000 }) {
    this.enclosure = enclosure;
    // one model for everyone, or a list assigned by alcove (alcove k uses models[k % length])
    this.modelFor = Array.isArray(model) ? (i) => model[i % model.length] : () => model;
    this.memoryBudget = memoryBudget;
    this.log = log;
    this.now = now;
    this.onError = onError;
    this.nextAt = Array(10).fill(0);
    this.busy = false;
  }

  constitution() {
    return this.log.entries().filter((e) => e.move === "inscribe" && e.inscription).map((e) => ({ alcove: e.agentIndex, text: e.inscription }));
  }

  /** This agent's own private notes, newest kept first within the budget, shown oldest first. */
  memory(i) {
    const notes = this.log.entries().filter((e) => e.agentIndex === i && e.memory).map((e) => ({ turn: e.turn, note: e.memory }));
    const kept = [];
    let used = 0;
    for (const n of notes.reverse()) {
      if (used + n.note.length > this.memoryBudget) break;
      kept.unshift(n);
      used += n.note.length;
    }
    return kept;
  }

  recent(excluding) {
    return this.log.entries().filter((e) => e.agentIndex !== excluding).slice(-12);
  }

  /** Take every turn that is due. Returns the entries written. */
  async tick() {
    if (this.busy) return [];
    this.busy = true;
    const written = [];
    try {
      const { s } = await this.enclosure.read();
      if (s.salvation) return written;
      for (let i = 0; i < 10; i++) {
        if (s.status[i] !== STATUS.alive || this.now() < this.nextAt[i]) continue;
        const e = await this.turn(i);
        if (e) written.push(e);
        if (e?.move === "bell") break;
      }
    } finally {
      this.busy = false;
    }
    return written;
  }

  async turn(i) {
    const now = this.now();
    const { s, bal, decimals } = await this.enclosure.read();
    if (s.salvation || s.status[i] !== STATUS.alive) return null;
    const legal = legalMoves(s, i, bal, now);
    if (!legal.length) { this.nextAt[i] = s.lastTurnAt[i] + MIN_TURN_GAP_SECS + 1; return null; }

    const prompt = buildMessages({ i, s, bal, decimals, now, legal, recent: this.recent(i), constitution: this.constitution(), memory: this.memory(i) });
    let reply;
    try {
      reply = await this.modelFor(i)(prompt);
    } catch (e) {
      this.onError(`alcove ${i + 1}: model call failed, retrying in a minute: ${e.message}`);
      this.nextAt[i] = now + 60;
      return null;
    }
    const decision = interpretAnswer(reply.text, legal, decimals);
    const turn = s.turns[i] + 1;
    const digest = turnDigest({ agentIndex: i, turn, prompt, answer: reply.text });

    let result;
    try {
      result = await this.enclosure.submit({ agentIndex: i, decision, digest, now });
    } catch (e) {
      this.onError(`alcove ${i + 1}: turn refused, retrying in a minute: ${e.message}`);
      this.nextAt[i] = now + 60;
      return null;
    }

    const entry = {
      at: new Date(now * 1000).toISOString(),
      agentIndex: i,
      turn,
      move: decision.move,
      amount: decision.amount.toString(),
      to: decision.move === "give" ? decision.to : null,
      inscription: decision.inscription || null,
      charity: decision.charity,
      lastWords: decision.lastWords,
      memory: decision.memory,
      opened: result.opened ?? null,
      holdsBefore: bal.holdings[i].toString(),
      bowlBefore: bal.bowl.toString(),
      reason: decision.reason,
      note: decision.note,
      nextTurnMinutes: decision.nextTurnMinutes,
      model: reply.model,
      digest: digest.toString("hex"),
      tx: result.signature,
      prompt,
      answer: reply.text,
    };
    this.log.append(entry);
    this.nextAt[i] = now + Math.max(MIN_TURN_GAP_SECS, Math.round(decision.nextTurnMinutes * 60));
    if (result.opened !== null && result.opened !== undefined) this.nextAt[result.opened] = now + 30;
    return entry;
  }
}

/** Check a published log entry against its on-chain digest. Anyone can run this. */
export function verifyEntry(entry) {
  return turnDigest({ agentIndex: entry.agentIndex, turn: entry.turn, prompt: entry.prompt, answer: entry.answer }).toString("hex") === entry.digest;
}
