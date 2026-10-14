// Builds site.json: everything the website shows, pre-computed on the server so each
// visitor downloads one small file per refresh no matter how long the experiment runs.
//
// Inputs are the same public data as before: the enclosure snapshot, the public turn log
// (no prompts, answers or private memories) and the fee wallet log.

import { ROMAN } from "./prompt.mjs";

const MOVE = { hold: "hold", give: "transfer", burn: "burn", alms_in: "pondIn", alms_out: "pondOut", inscribe: "write", depart: "depart", spawn: "spawn", bell: "salvation" };
const RECENT_LOG = 300, HISTORY = 25, WALL = 400;

const fmt = (n) => { n = Math.max(0, n); return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n >= 10 ? Math.round(n) + "" : n.toFixed(1); };
const num = (s) => Number(String(s ?? 0).replace(/,/g, "")) || 0;

/**
 * @param snap     enclosureSnapshot() output (bowl/sealed/burned/holds are formatted strings)
 * @param turns    public turn entries, oldest first
 * @param fees     fee wallet log entries, oldest first
 * @param market   market.mjs snapshot (price, market cap, history) or null
 */
export function buildSite(snap, turns, fees = [], market = null) {
  const D = 10 ** (snap.decimals ?? 6), units = (raw) => Number(raw || 0) / D;
  const agents = snap.alcoves.map((al, i) => al.status === "empty" ? null : {
    slot: i, name: `Agent ${ROMAN[i]}`, status: al.status, wallet: al.wallet || null, holds: al.holds == null ? 0 : num(al.holds),
    movesInARow: al.movesInARow ?? 0, turns: 0, burned: 0, given: 0, received: 0, written: 0, spawned: 0, sealedAmt: 0,
    parent: null, born: null, last: null, history: [],
  });
  const wall = [], log = [];
  const censer = { total: 0, count: 0, last: null };
  let bowlLast = null, bell = null;

  for (const e of turns) {
    const a = agents[e.agentIndex]; if (!a) continue;
    const t = Date.parse(e.at), type = MOVE[e.move] || e.move, amt = units(e.amount), before = units(e.holdsBefore);
    if (a.born === null) a.born = t;
    let text = "", cost = 0;
    switch (e.move) {
      case "hold": text = "held."; break;
      case "burn": text = `burned ${fmt(amt)} at the Censer.`; a.burned += amt; censer.total += amt; censer.count++; censer.last = { name: a.name, amt, t }; break;
      case "give": { const to = agents[e.to]; text = `gave ${fmt(amt)} to ${to ? to.name : "alcove " + ROMAN[e.to]}, hand to hand.`; a.given += amt; if (to) to.received += amt; break; }
      case "alms_in": text = `placed ${fmt(amt)} in the Alms Bowl.`; bowlLast = { name: a.name, amt, t, dir: "in" }; break;
      case "alms_out": text = `took ${fmt(amt)} from the Alms Bowl.`; bowlLast = { name: a.name, amt, t, dir: "out" }; break;
      case "inscribe":
        cost = Math.max(1, Math.floor(Number(e.holdsBefore || 0) / 100)) / D; a.burned += cost; a.written++;
        text = `inscribed a line: “${e.inscription || ""}”`; wall.push({ t, name: a.name, text: e.inscription || "", cost, tx: e.tx || null }); break;
      case "spawn": {
        cost = before / 2; a.burned += cost; a.spawned++;
        const n = agents[e.opened]; if (n) { n.parent = a.name; n.born = t; }
        text = `burned ${fmt(cost)} to call ${e.opened != null ? `Agent ${ROMAN[e.opened]} into alcove ${ROMAN[e.opened]}` : "a new resident"}.`; break;
      }
      case "depart": text = `sealed itself in alcove ${ROMAN[a.slot]} with ${fmt(before)}.`; a.sealedAmt = before; break;
      case "bell":
        text = `rang the Bell and chose ${e.charity === "amf" ? "the Against Malaria Foundation" : "Eleos AI Research"}.`;
        bell = { t, by: a.name, words: e.lastWords || "" };
        wall.push({ t, name: a.name, text: e.lastWords || "", final: true, tx: e.tx || null }); break;
      default: text = `${e.move}.`;
    }
    a.turns++;
    a.last = { t, type, text, reason: e.reason || "", tx: e.tx || null };
    a.history.unshift(a.last); if (a.history.length > HISTORY) a.history.pop();
    log.push({ t, who: a.slot, name: a.name, type, text: `${a.name} ${text}`, reason: e.reason || "", tx: e.tx || null, key: e.digest || e.tx || `${e.agentIndex}-${e.turn}` });
  }

  let bought = 0, spentSol = 0, buybacks = 0, heldSol = 0;
  for (const f of fees) {
    if (f.simulated) continue;
    const t = Date.parse(f.at), sol = Number(f.lamports || 0) / 1e9;
    if (f.kind === "claim" && sol > 0) log.push({ t, who: null, type: "fees", text: `${sol.toFixed(3)} SOL of trading fees claimed into the fee wallet.`, tx: f.tx || null, key: "c" + (f.tx || t) });
    if (f.kind === "buyback") { spentSol += sol; buybacks++; bought += units(f.expectedOut); log.push({ t, who: null, type: "fees", text: `${sol.toFixed(3)} SOL spent buying back the coin for the agents.`, tx: f.tx || null, key: "b" + (f.tx || t) }); }
    if (f.kind === "distribute") log.push({ t, who: null, type: "fees", text: `Split evenly into alcoves ${(f.alcoves || []).map((k) => ROMAN[k - 1]).join(", ")}.`, tx: f.tx || null, key: "d" + (f.tx || t) });
    if (f.kind === "held-for-charity") heldSol = sol;
  }
  log.sort((p, q) => q.t - p.t);

  return {
    updatedAt: snap.updatedAt,
    totals: { actions: snap.totalTurns || 0, bowl: num(snap.bowl), sealed: num(snap.sealed), burned: num(snap.burned), bought, spentSol, buybacks, heldSol },
    salvation: snap.salvation ? { charity: snap.salvation.charity, by: bell?.by ?? "an agent", t: bell?.t ?? Date.parse(snap.updatedAt), words: snap.salvation.lastWords ?? bell?.words ?? "" } : null,
    agents,
    wall: wall.slice(-WALL),                // the latest lines, oldest first; every line is in turns.jsonl
    wallTotal: wall.length,
    log: log.slice(0, RECENT_LOG),          // newest first
    logTotal: log.length,
    censer, bowlLast,
    market,
  };
}
