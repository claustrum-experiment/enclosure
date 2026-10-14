import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeRouter, decodeProgramData } from "../src/chain/decode.mjs";
import { findProgramAddress, routerAddress, vaultAddress, escrowAddress } from "../src/chain/pda.mjs";
import { encode } from "../src/base58.mjs";

const fixture = (f) => new URL(`./fixtures/${f}`, import.meta.url);

test("decodes the Router account exactly as the Rust program serializes it", () => {
  // produced by programs/claustrum-router/tests/layout_fixture.rs
  const s = decodeRouter(Buffer.from(readFileSync(fixture("router-account.hex"), "utf8"), "hex"));
  const k = (b) => encode(new Uint8Array(32).fill(b));
  assert.equal(s.salvation, true);
  assert.equal(s.adminRevoked, true);
  assert.equal(s.chosen, 1);
  assert.equal(s.chosenName, "Against Malaria Foundation");
  assert.equal(s.rungSlot, 123_456_789n);
  assert.equal(s.rungUnixTimestamp, 1_800_000_000n);
  assert.equal(s.rungAgentIndex, 3);
  assert.equal(s.rungAgent, k(13));
  assert.equal(s.cranker, k(2));
  assert.equal(s.swapProgram, k(3));
  assert.deepEqual([s.agents[0], s.agents[1], s.agents[3]], [k(10), null, k(13)]);
  assert.deepEqual(s.destinations, [null, { owner: k(30), mint: k(31), tokenAccount: k(32) }]);
  assert.deepEqual(s.pendingLamports, [0n, 5_000_000_000n]);
  assert.deepEqual(s.totalDelivered, [0n, 598_765_433n]);
  assert.equal(s.deliveries, 7n);
  assert.equal(s.feeProgram, k(4));
  assert.equal(s.buybackAccount, k(5));
  assert.equal(s.actions, 57);
  assert.equal(s.totalClaimed, 21_000_000_000n);
  assert.equal(s.claimedAfterSalvation, 9_000_000_000n);
  assert.equal(s.claustrumMint, k(6));
  assert.deepEqual(s.status.slice(0, 4), ["gone", "empty", "empty", "departed"]);
  assert.equal(s.streak[9], 2);
  assert.equal(s.lastTurnAt[0], 1_799_999_000n);
  assert.deepEqual([s.turns[0], s.turns[3]], [40, 17]);
  assert.equal(s.admitted, 2);
  assert.equal(s.totalBurned, 4_444_444n);
  assert.deepEqual([s.bump, s.vaultBump], [254, 253]);
});

test("rejects accounts that are not a Router", () => {
  assert.throws(() => decodeRouter(Buffer.alloc(900)), /not a CLAUSTRUM Router account/);
});

test("derives the same PDAs as the Rust program", () => {
  const f = JSON.parse(readFileSync(fixture("pdas.json"), "utf8"));
  assert.deepEqual(routerAddress(f.programId), f.router);
  assert.deepEqual(vaultAddress(f.programId), f.vault);
  assert.deepEqual(escrowAddress(f.programId, 1), f.escrow1);
  assert.deepEqual(findProgramAddress(["router"], f.programId), f.router);
});

test("reads the program's upgrade authority, including 'none' for an immutable program", () => {
  const withAuth = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8), Buffer.from([1]), Buffer.alloc(32, 7)]);
  const immutable = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8), Buffer.from([0])]);
  assert.equal(decodeProgramData(withAuth).upgradeAuthority, encode(new Uint8Array(32).fill(7)));
  assert.equal(decodeProgramData(immutable).upgradeAuthority, null);
});
