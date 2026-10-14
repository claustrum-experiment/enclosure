// Market data for the website: price, market cap, liquidity, 24h change and volume.
// Fetched on the server at most once a minute and published inside site.json, so visitors
// never call DexScreener or Jupiter themselves.
//
// Source 1: DexScreener (has market cap, liquidity, volume, change).
// Source 2 (fallback while DexScreener hasn't indexed the pool yet): Jupiter price x on-chain supply.
// The on-chain supply shrinks with every burn, so the market cap reflects the agents' burns.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const EVERY_MS = 60_000, HISTORY_MAX = 4_000;

async function getJson(url, headers = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8_000);
  try {
    const r = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export function pickPair(pairs, mint) {
  const ours = (pairs || []).filter((p) => p?.chainId === "solana" && p.baseToken?.address === mint);
  ours.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return ours[0] || null;
}

export function createMarket({ mint, connection, jupiterKey, file = null, now = () => Date.now(), onError = () => {} }) {
  let last = null, lastAt = -Infinity;
  let history = [];     // [t, marketCapUsd], one point a minute, for the simple chart; kept across restarts in `file`
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.mint === mint) { history = Array.isArray(saved.history) ? saved.history : []; last = saved.last || null; }
    } catch { /* first run */ }
  }
  const save = () => { if (file) try { writeFileSync(file + ".tmp", JSON.stringify({ mint, last, history })); renameSync(file + ".tmp", file); } catch (e) { onError(`market save: ${e.message}`); } };

  async function supplyUi() {
    if (!connection) return null;
    const s = await connection.getTokenSupply(new PublicKey(mint));
    return s?.value?.uiAmount ?? null;
  }

  async function refresh() {
    let m = null;
    try {
      const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const p = pickPair(d.pairs, mint);
      if (p) m = {
        source: "dexscreener", priceUsd: Number(p.priceUsd) || null, marketCap: p.marketCap ?? p.fdv ?? null,
        liquidityUsd: p.liquidity?.usd ?? null, volume24h: p.volume?.h24 ?? null, change24h: p.priceChange?.h24 ?? null,
        dex: p.dexId || null, pairUrl: p.url || null,
      };
    } catch (e) { onError(`market (dexscreener): ${e.message}`); }
    if (!m) {
      try {
        const d = await getJson(`https://api.jup.ag/price/v3?ids=${mint}`, jupiterKey ? { "x-api-key": jupiterKey } : {});
        const price = Number(d?.[mint]?.usdPrice);
        if (price > 0) {
          const supply = await supplyUi().catch(() => null);
          m = { source: "jupiter", priceUsd: price, marketCap: supply ? price * supply : null, liquidityUsd: null, volume24h: null,
                change24h: d[mint].priceChange24h ?? null, dex: null, pairUrl: null };
        }
      } catch (e) { onError(`market (jupiter): ${e.message}`); }
    }
    if (m) {
      last = { ...m, updatedAt: new Date(now()).toISOString() };
      if (m.marketCap > 0) { history.push([now(), Math.round(m.marketCap)]); if (history.length > HISTORY_MAX) history = thin(history, HISTORY_MAX / 2); }
      save();
    }
  }

  return {
    /** Refreshes at most once a minute; never throws. */
    async tick() { if (now() - lastAt < EVERY_MS) return; lastAt = now(); await refresh().catch((e) => onError(`market: ${e.message}`)); },
    snapshot() {
      return { mint, ...(last || {}), history: thin(history, 240) };
    },
    get _history() { return history; },
  };
}

// Keep the chart small: at most n points, evenly spread, always including the latest.
export function thin(points, n) {
  if (points.length <= n) return points.slice();
  const out = [], step = (points.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
  return out;
}
