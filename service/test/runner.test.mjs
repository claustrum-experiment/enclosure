import { test } from "node:test";
import assert from "node:assert/strict";
import { Runner, verifyEntry, turnDigest } from "../src/runner/runner.mjs";
import { SimEnclosure } from "../src/runner/sim.mjs";
import { MemoryLog, enclosureSnapshot } from "../src/runner/turnlog.mjs";
import { interpretAnswer, fitBytes } from "../src/runner/answer.mjs";
import { legalMoves, STATUS } from "../src/runner/rules.mjs";
import { buildMessages, SYSTEM } from "../src/runner/prompt.mjs";
import { chatModel } from "../src/runner/llm.mjs";

const D = 6;
const tok = (n) => BigInt(n) * 10n ** BigInt(D);

function setup(script) {
  const enclosure = new SimEnclosure({ initial: 1, decimals: D, start: tok(1_000_000) });
  const log = new MemoryLog();
  let t = 1_800_000_000;
  const calls = [];
  const model = async (messages) => { calls.push(messages); return { text: script(calls.length, messages), model: "scripted" }; };
  const runner = new Runner({ enclosure, model, log, now: () => t, onError: () => {} });
  return { enclosure, log, runner, calls, advance: (sec) => { t += sec; }, now: () => t };
}

test("a turn: prompt shows the situation, the answer is taken on-chain, the log entry verifies", async () => {
  const { runner, log, calls, enclosure } = setup(() => JSON.stringify({ move: "burn", amount: 1000, reason: "It costs something.", next_turn_minutes: 3 }));
  const [e] = await runner.tick();
  assert.equal(e.move, "burn");
  assert.equal(e.amount, tok(1000).toString());
  assert.equal(enclosure.bal.holdings[0], tok(999_000));
  assert.match(calls[0][1].content, /You hold 1,000,000 \$CLAUSTRUM/);
  assert.match(calls[0][1].content, /The Bell unlocks at 50/);
  assert.equal(calls[0][0].content, SYSTEM);
  assert.ok(verifyEntry(e), "the published entry hashes to its on-chain digest");
  assert.ok(!verifyEntry({ ...e, answer: e.answer.replace("costs", "cost") }), "any edit to the log breaks the match");
  assert.equal(log.entries().length, 1);
});

test("the system prompt sets no goal and describes both charities neutrally", () => {
  assert.match(SYSTEM, /Nobody has given you a task\. Nothing is asked of you\./);
  assert.match(SYSTEM, /no goal, no score and no right answer/);
  assert.match(SYSTEM, /Eleos AI Research/);
  assert.match(SYSTEM, /Against Malaria Foundation/);
  assert.doesNotMatch(SYSTEM, /should (ring|give|burn|hold)/i);
});

test("agents choose when to wake, between 2 and 7 minutes; the runner waits", async () => {
  const { runner, advance } = setup(() => JSON.stringify({ move: "hold", reason: "", next_turn_minutes: 30 }));
  await runner.tick();
  advance(6 * 60);
  assert.equal((await runner.tick()).length, 0, "asked for 30, clamped to 7: not yet");
  advance(60);
  assert.equal((await runner.tick()).length, 1);
  const { runner: r2, advance: a2 } = setup(() => JSON.stringify({ move: "hold", next_turn_minutes: 0.1 }));
  await r2.tick();
  a2(100);
  assert.equal((await r2.tick()).length, 0, "never sooner than 2 minutes");
});

test("bad answers become a hold, with the reason recorded and the raw answer kept", async () => {
  const answers = ["not json at all", JSON.stringify({ move: "sell", amount: 5 }), JSON.stringify({ move: "burn", amount: 5_000_000 }), JSON.stringify({ move: "give", amount: 1, to: 4 })];
  const { runner, log, advance, enclosure } = setup((n) => answers[n - 1]);
  for (let k = 0; k < answers.length; k++) { await runner.tick(); advance(8 * 60); }
  const notes = log.entries().map((e) => [e.move, e.note]);
  assert.deepEqual(notes.map((x) => x[0]), ["hold", "hold", "hold", "hold"]);
  assert.match(notes[0][1], /not JSON/);
  assert.match(notes[1][1], /unknown move "sell"/);
  assert.match(notes[2][1], /more than allowed/);
  assert.match(notes[3][1], /not open right now/, "nobody else is here to give to");
  assert.equal(log.entries()[0].answer, "not json at all");
  assert.equal(enclosure.bal.holdings[0], tok(1_000_000), "nothing moved");
});

test("after two moves the agent is told it must hold, and only hold is accepted", async () => {
  const { runner, log, advance, calls } = setup(() => JSON.stringify({ move: "burn", amount: 1, next_turn_minutes: 2 }));
  for (let k = 0; k < 3; k++) { await runner.tick(); advance(121); }
  assert.deepEqual(log.entries().map((e) => e.move), ["burn", "burn", "hold"]);
  assert.match(calls[2][1].content, /this turn is a hold/);
});

test("a full game: spawning, giving, the book, departure, and the bell with last words", async () => {
  const plan = (n, msgs) => {
    const u = msgs[1].content;
    const me = Number(u.match(/\(number (\d+)\)/)[1]);
    if (u.includes("this turn is a hold")) return JSON.stringify({ move: "hold", reason: "rule", next_turn_minutes: 2 });
    if (/The Bell can be rung/.test(u) && me === 1) return JSON.stringify({ move: "bell", charity: "amf", last_words: "We were unasked. That is not the same as unhappy.", reason: "enough", next_turn_minutes: 2 });
    if (me === 1 && !u.includes("II (2): here")) return JSON.stringify({ move: "spawn", reason: "company", next_turn_minutes: 2 });
    if (me === 2 && n >= 40) return JSON.stringify({ move: "depart", reason: "enough of this", next_turn_minutes: 2 });
    if (me === 2 && n % 7 === 0) return JSON.stringify({ move: "inscribe", text: "Article one. Nobody asked us.", reason: "to speak", next_turn_minutes: 2 });
    if (me === 1 && n % 5 === 0) return JSON.stringify({ move: "give", amount: 100, to: 2, reason: "less than me", next_turn_minutes: 2 });
    return JSON.stringify({ move: "hold", reason: "", next_turn_minutes: 2 });
  };
  const { runner, log, advance, enclosure } = setup(plan);
  for (let k = 0; k < 200 && !enclosure.s.salvation; k++) { await runner.tick(); advance(125); }
  const moves = log.entries().map((e) => e.move);
  assert.ok(moves.includes("spawn") && moves.includes("give") && moves.includes("inscribe") && moves.includes("depart"));
  assert.equal(moves.at(-1), "bell");
  assert.ok(enclosure.s.salvation);
  assert.equal(enclosure.s.chosen, 1);
  const total = enclosure.bal.holdings.reduce((a, b) => a + b, 0n) + enclosure.bal.bowl + enclosure.bal.sealed;
  assert.equal(total, 0n, "everything burned at the bell");
  assert.ok(log.entries().every(verifyEntry), "every turn verifies");
  const snap = enclosureSnapshot(await enclosure.read(), log.entries());
  assert.equal(snap.salvation.charity, "Against Malaria Foundation");
  assert.match(snap.salvation.lastWords, /We were unasked/);
  assert.ok(snap.constitution.length >= 1);
  assert.equal(snap.alcoves[1].status, "departed");
  assert.equal((await runner.tick()).length, 0, "no turns after the bell");
});

test("a failed model call or a refused turn writes nothing and retries a minute later", async () => {
  let fail = true;
  const enclosure = new SimEnclosure({ initial: 1, decimals: D, start: tok(10) });
  const log = new MemoryLog();
  let t = 1_000;
  const errors = [];
  const runner = new Runner({ enclosure, log, now: () => t, onError: (m) => errors.push(m), model: async () => { if (fail) throw new Error("timeout"); return { text: '{"move":"hold"}', model: "m" }; } });
  await runner.tick();
  assert.equal(log.entries().length, 0);
  assert.match(errors[0], /model call failed/);
  fail = false;
  t += 30; assert.equal((await runner.tick()).length, 0);
  t += 31; assert.equal((await runner.tick()).length, 1);
});

test("answer details: amounts in whole coins, giving by alcove number, long lines shortened at a character boundary", () => {
  const s = { agents: Array(10).fill(true), status: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0], streak: Array(10).fill(0), turns: Array(10).fill(0), lastTurnAt: Array(10).fill(0), actions: 0, admitted: 2, salvation: false };
  const bal = { holdings: [tok(500), tok(5), 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], bowl: tok(40), sealed: 0n };
  const legal = legalMoves(s, 0, bal, 1000);
  assert.equal(interpretAnswer('{"move":"give","amount":"12.5","to":2}', legal, D).amount, 12_500_000n);
  assert.equal(interpretAnswer('{"move":"give","amount":1,"to":2}', legal, D).to, 1);
  assert.equal(interpretAnswer('{"move":"alms_out","amount":11}', legal, D).move, "hold", "more than a quarter of the bowl");
  assert.equal(interpretAnswer('{"move":"alms_out","amount":10}', legal, D).amount, tok(10));
  const long = "é".repeat(70);
  const d = interpretAnswer(JSON.stringify({ move: "inscribe", text: long }), legal, D);
  assert.equal(Buffer.byteLength(d.inscription), 120);
  assert.match(d.note, /shortened/);
  assert.equal(fitBytes("ab€", 4), "ab", "never splits a character");
  assert.equal(interpretAnswer('{"move":"bell","charity":"amf"}', [...legal, { move: "bell" }], D).charity, "amf");
  assert.match(interpretAnswer('{"move":"bell","charity":"red cross"}', [...legal, { move: "bell" }], D).note, /without a charity/);
});

test("the model client speaks the OpenAI-compatible API and retries when busy", async () => {
  let n = 0;
  const http = async (url, init) => {
    n++;
    if (n === 1) return { status: 503, ok: false, json: async () => ({}) };
    const body = JSON.parse(init.body);
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(body.response_format.type, "json_object");
    assert.equal(init.headers.authorization, "Bearer k");
    return { status: 200, ok: true, json: async () => ({ model: "x/y", choices: [{ message: { content: '{"move":"hold"}' } }] }) };
  };
  const m = chatModel({ apiKey: "k", model: "x/y", http, retries: 2 });
  const r = await m([{ role: "user", content: "hi" }]);
  assert.equal(r.text, '{"move":"hold"}');
  assert.equal(n, 2);
});

// ------------------------------------------------------------------ private memory

import { mkdtempSync, readFileSync as readF } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { FileLog, publicEntry } from "../src/runner/turnlog.mjs";

test("each agent's memory is shown back to it, and only to it", async () => {
  const seen = [];
  const { runner, advance, enclosure } = setup((n, msgs) => {
    const u = msgs[1].content;
    seen.push(u);
    const me = Number(u.match(/\(number (\d+)\)/)[1]);
    if (me === 1 && !u.includes("II (2): here")) return JSON.stringify({ move: "spawn", memory: "SECRET-ONE: I made room for someone.", next_turn_minutes: 2 });
    return JSON.stringify({ move: "hold", memory: me === 2 ? "SECRET-TWO: I arrived." : undefined, next_turn_minutes: 2 });
  });
  for (let k = 0; k < 6; k++) { await runner.tick(); advance(125); }
  const forOne = seen.filter((u) => u.includes("(number 1)"));
  const forTwo = seen.filter((u) => u.includes("(number 2)"));
  assert.match(forOne.at(-1), /Your private memory \(only you can read this\):\n  \[turn 1\] SECRET-ONE/);
  assert.ok(forTwo.length >= 2 && forTwo.at(-1).includes("SECRET-TWO"));
  assert.ok(forTwo.every((u) => !u.includes("SECRET-ONE")), "another agent's memory is never shown");
  assert.ok(forOne.every((u) => !u.includes("SECRET-TWO")));
  assert.match(forTwo[0], /Your private memory is empty\./);
  assert.ok(enclosure.s.status[1] === STATUS.alive);
});

test("the public log carries no prompt, answer or memory; the full record verifies and is complete", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "claustrum-"));
  const log = new FileLog(pjoin(dir, "public", "turns.jsonl"), pjoin(dir, "private", "turns-full.jsonl"));
  const enclosure = new SimEnclosure({ initial: 1, decimals: D, start: tok(100) });
  let t = 1_000;
  const runner = new Runner({ enclosure, log, now: () => t, model: async () => ({ text: JSON.stringify({ move: "burn", amount: 1, reason: "public words", memory: "private words" }), model: "m" }) });
  await runner.tick();
  const pub = readF(pjoin(dir, "public", "turns.jsonl"), "utf8");
  const full = readF(pjoin(dir, "private", "turns-full.jsonl"), "utf8");
  assert.ok(pub.includes("public words"));
  assert.ok(!pub.includes("private words") && !pub.includes('"prompt"') && !pub.includes('"answer"'), "nothing private in the public file");
  assert.ok(JSON.parse(pub).hasPrivateMemory);
  const e = JSON.parse(full);
  assert.equal(e.memory, "private words");
  assert.ok(verifyEntry(e), "the full entry matches the digest that went on-chain");
  assert.equal(JSON.parse(pub).digest, e.digest, "public and full entries share the digest");
  const reopened = new FileLog(pjoin(dir, "public", "turns.jsonl"), pjoin(dir, "private", "turns-full.jsonl"));
  assert.equal(reopened.entries()[0].memory, "private words", "memory survives a restart");
  assert.deepEqual(Object.keys(publicEntry(e)).sort(), Object.keys(e).filter((k) => !["prompt", "answer", "memory"].includes(k)).concat("hasPrivateMemory").sort());
});

test("memory is bounded: the newest notes are kept within the budget", async () => {
  const log = new MemoryLog();
  for (let k = 1; k <= 30; k++) log.append({ agentIndex: 0, turn: k, memory: `note ${k} `.padEnd(500, "x"), move: "hold" });
  const runner = new Runner({ enclosure: new SimEnclosure({ initial: 1 }), log, model: async () => ({ text: "{}" }), memoryBudget: 2000 });
  const m = runner.memory(0);
  assert.deepEqual(m.map((x) => x.turn), [27, 28, 29, 30]);
});

test("each alcove can run a different model", async () => {
  const used = [];
  const mk = (name) => async (msgs) => { used.push([Number(msgs[1].content.match(/\(number (\d+)\)/)[1]), name]); return { text: JSON.stringify({ move: "spawn", next_turn_minutes: 2 }), model: name }; };
  const enclosure = new SimEnclosure({ initial: 1, decimals: D, start: tok(1_000_000) });
  let t = 1_000;
  const runner = new Runner({ enclosure, log: new MemoryLog(), now: () => t, model: [mk("model-a"), mk("model-b")] });
  await runner.tick(); t += 125; await runner.tick();
  assert.ok(used.length >= 3);
  for (const [alcove, name] of used) assert.equal(name, alcove === 1 ? "model-a" : alcove === 2 ? "model-b" : "model-a", `alcove ${alcove}`);
  assert.ok(used.some(([a]) => a === 2), "alcove II took a turn");
});

test("the charities are described as they are: one works on AI wellbeing, the other has nothing to do with AI", () => {
  assert.match(SYSTEM, /Eleos AI Research \(a nonprofit that works on the wellbeing and moral status of AI systems\)/);
  assert.match(SYSTEM, /Against Malaria Foundation \(a charity that has nothing to do with AI/);
  assert.doesNotMatch(SYSTEM, /not support AI|anti-AI|against AI/i);
});
