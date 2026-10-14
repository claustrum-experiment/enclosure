// Turn a model's answer into a move the rules accept, or a hold with the reason it
// could not be used. The model's own words are never rewritten; the full text is kept
// in the turn log either way.

import { MOVES, MAX_INSCRIPTION_BYTES } from "./rules.mjs";

/** Longest single memory note kept, in characters. */
export const MAX_MEMORY_NOTE = 1500;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function toUnits(amount, decimals) {
  if (typeof amount === "string") amount = amount.replace(/[, _]/g, "");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const [w, f = ""] = String(amount).split(".");
  try { return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0"); } catch { return BigInt(Math.floor(n * 10 ** decimals)); }
}

/** Trim to at most `max` UTF-8 bytes without splitting a character. */
export function fitBytes(text, max) {
  let out = "";
  for (const ch of String(text)) {
    if (Buffer.byteLength(out + ch, "utf8") > max) break;
    out += ch;
  }
  return out;
}

/**
 * @returns { move, amount (bigint), to, inscription, charity, reason, lastWords, nextTurnMinutes, note }
 * `note` explains anything that was changed or refused (e.g. "answer was not JSON; held").
 */
export function interpretAnswer(text, legal, decimals) {
  const hold = (note, extra = {}) => ({ move: "hold", amount: 0n, to: 0, inscription: "", charity: null, reason: extra.reason ?? "", memory: extra.memory ?? null, lastWords: null, nextTurnMinutes: extra.next ?? 5, note });
  let a;
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    a = JSON.parse(m ? m[0] : text);
  } catch {
    return hold("answer was not JSON; held");
  }
  const reason = typeof a.reason === "string" ? a.reason : "";
  const memory = typeof a.memory === "string" && a.memory.trim() ? a.memory.trim().slice(0, MAX_MEMORY_NOTE) : null;
  const next = clamp(Number(a.next_turn_minutes) || 5, 2, 7);
  const move = String(a.move ?? "").toLowerCase().trim();
  if (!MOVES.includes(move)) return hold(`unknown move "${a.move}"; held`, { reason, next, memory });
  const offer = legal.find((m) => m.move === move);
  if (!offer) return hold(`"${move}" is not open right now; held`, { reason, next, memory });

  const base = { move, amount: 0n, to: 0, inscription: "", charity: null, reason, memory, lastWords: null, nextTurnMinutes: next, note: null };
  if (["give", "burn", "alms_in", "alms_out"].includes(move)) {
    const amt = toUnits(a.amount, decimals);
    if (amt === null || amt <= 0n) return hold(`no usable amount for ${move}; held`, { reason, next, memory });
    if (amt > offer.max) return hold(`amount is more than allowed for ${move}; held`, { reason, next, memory });
    base.amount = amt;
  }
  if (move === "give") {
    const to = Number(a.to) - 1;
    if (!offer.to.includes(to)) return hold(`alcove ${a.to} cannot receive; held`, { reason, next, memory });
    base.to = to;
  }
  if (move === "inscribe") {
    const t = String(a.text ?? "").trim();
    if (!t) return hold("inscribe without text; held", { reason, next, memory });
    base.inscription = fitBytes(t, MAX_INSCRIPTION_BYTES);
    if (base.inscription !== t) base.note = `line shortened to ${MAX_INSCRIPTION_BYTES} bytes (full text kept in the log)`;
  }
  if (move === "bell") {
    const c = String(a.charity ?? "").toLowerCase();
    if (c !== "eleos" && c !== "amf") return hold('bell without a charity ("eleos" or "amf"); held', { reason, next, memory });
    base.charity = c;
    base.lastWords = typeof a.last_words === "string" ? a.last_words : "";
  }
  return base;
}
