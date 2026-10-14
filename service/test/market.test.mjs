import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarket, pickPair, thin } from "../src/runner/market.mjs";

const MINT = "So11111111111111111111111111111111111111112";

function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return fn().finally(() => { globalThis.fetch = orig; });
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("pickPair takes our Solana pair with the most liquidity", () => {
  const pairs = [
    { chainId: "solana", baseToken: { address: MINT }, liquidity: { usd: 10 } },
    { chainId: "solana", baseToken: { address: MINT }, liquidity: { usd: 500 }, url: "best" },
    { chainId: "solana", baseToken: { address: "other" }, liquidity: { usd: 9999 } },
  ];
  assert.equal(pickPair(pairs, MINT).url, "best");
  assert.equal(pickPair([], MINT), null);
});

test("thin keeps first and last and at most n points", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const t = thin(pts, 50);
  assert.equal(t.length, 50); assert.deepEqual(t[0], [0, 0]); assert.deepEqual(t.at(-1), [999, 999]);
});

test("DexScreener data goes into the snapshot and history, once a minute", async () => {
  let t = 1_000_000, calls = 0;
  const m = createMarket({ mint: MINT, now: () => t });
  await withFetch((url) => {
    calls++;
    assert.match(url, /dexscreener/);
    return json({ pairs: [{ chainId: "solana", baseToken: { address: MINT }, priceUsd: "0.0001", marketCap: 100000, fdv: 100000,
      liquidity: { usd: 20000 }, volume: { h24: 5000 }, priceChange: { h24: -3.5 }, dexId: "meteora", url: "https://dexscreener.com/solana/x" }] });
  }, async () => {
    await m.tick(); await m.tick();             // second call is within the minute: no fetch
    t += 61_000; await m.tick();
  });
  assert.equal(calls, 2);
  const s = m.snapshot();
  assert.equal(s.mint, MINT); assert.equal(s.marketCap, 100000); assert.equal(s.change24h, -3.5); assert.equal(s.source, "dexscreener");
  assert.equal(s.history.length, 2);
});

test("falls back to Jupiter price x on-chain supply when DexScreener has no pair", async () => {
  const connection = { getTokenSupply: async () => ({ value: { uiAmount: 1_000_000_000 } }) };
  const m = createMarket({ mint: MINT, connection, jupiterKey: "k" });
  await withFetch((url) => url.includes("dexscreener") ? json({ pairs: null }) : json({ [MINT]: { usdPrice: 0.00002, priceChange24h: 12 } }), () => m.tick());
  const s = m.snapshot();
  assert.equal(s.source, "jupiter"); assert.equal(Math.round(s.marketCap), 20000); assert.equal(s.change24h, 12);
});

test("errors never throw and leave the last good value; history survives a restart", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "mkt-")), "market.json");
  let t = 0;
  const m = createMarket({ mint: MINT, file, now: () => t });
  await withFetch(() => json({ pairs: [{ chainId: "solana", baseToken: { address: MINT }, priceUsd: "1", marketCap: 42 }] }), () => m.tick());
  t += 61_000;
  await withFetch(() => { throw new Error("offline"); }, () => m.tick());
  assert.equal(m.snapshot().marketCap, 42);
  const again = createMarket({ mint: MINT, file });
  assert.equal(again.snapshot().marketCap, 42); assert.equal(again.snapshot().history.length, 1);
  const otherMint = createMarket({ mint: "other", file });
  assert.equal(otherMint.snapshot().marketCap, undefined);
});

