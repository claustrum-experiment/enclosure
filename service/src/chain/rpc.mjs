// Read-only verification straight from a Solana RPC node. No keys, no writes, no
// dependency on our API or database: this is what anyone can run to check Salvation.

import { decodeRouter, decodeProgramAccount, decodeProgramData } from "./decode.mjs";
import { routerAddress, vaultAddress } from "./pda.mjs";
import { feeShareConfigAddress, decodeFeeShareConfig, checkBagsConfig, ata, WSOL_MINT } from "./bags.mjs";

async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function account(url, address) {
  const r = await rpc(url, "getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]);
  return r.value ? { lamports: r.value.lamports, owner: r.value.owner, data: Buffer.from(r.value.data[0], "base64") } : null;
}

/** Everything a member of the public needs to check the Router, read from chain. */
export async function readRouterFromChain({ rpcUrl, programId }) {
  const [router] = routerAddress(programId);
  const [vault] = vaultAddress(programId);
  const prog = await account(rpcUrl, programId);
  if (!prog) throw new Error(`program ${programId} not found`);
  const { programData } = decodeProgramAccount(prog.data);
  const pd = await account(rpcUrl, programData);
  const { upgradeAuthority, lastDeploySlot } = decodeProgramData(pd.data);
  const ra = await account(rpcUrl, router);
  if (!ra) throw new Error(`router account ${router} not found`);
  if (ra.owner !== programId) throw new Error("router account is not owned by the Router program");
  const state = decodeRouter(ra.data);
  const va = await account(rpcUrl, vault);
  return {
    programId, routerAccount: router, vault, vaultLamports: va ? va.lamports : 0,
    upgradeAuthority, programImmutable: upgradeAuthority === null, lastDeploySlot,
    state,
  };
}

/** Read the token's Bags fee config from chain and check it pays 100% to `feeWallet`. */
export async function readBagsFromChain({ rpcUrl, baseMint, feeWallet }) {
  const address = feeShareConfigAddress(baseMint);
  const acc = await account(rpcUrl, address);
  if (!acc) return { address, found: false, ok: false, problems: [`no Bags fee config found for mint ${baseMint}`] };
  const cfg = decodeFeeShareConfig(acc.data);
  return { address, found: true, config: cfg, ...checkBagsConfig(cfg, feeWallet) };
}

/** A token account's balance, or null if it does not exist. */
export async function readTokenBalance(rpcUrl, address) {
  try {
    const r = await rpc(rpcUrl, "getTokenAccountBalance", [address, { commitment: "finalized" }]);
    return BigInt(r.value.amount);
  } catch { return null; }
}
export { ata, WSOL_MINT };

/** SOL balance of any address, in lamports. */
export async function readLamports(rpcUrl, address) {
  const r = await rpc(rpcUrl, "getBalance", [address, { commitment: "finalized" }]);
  return BigInt(r.value);
}
