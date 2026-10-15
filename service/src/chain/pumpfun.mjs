// Getting pump.fun creator fees into the fee wallet, using pump.fun's official SDK.
//
// Two set-ups work:
//   * Fee sharing (recommended): the creator assigns the coin's creator fees to the fee wallet in
//     pump.fun's fee-sharing config. pump.fun then makes the config the coin's creator, the split
//     can be set only once and is locked for good, and anyone may trigger the payout
//     ("distribute"), which sends the SOL straight to the listed wallets.
//   * The fee wallet is itself the coin's creator: it collects its own creator vault.
// Anything else (fees going to some other wallet) is reported, and only SOL sent to the fee wallet
// by hand gets bought back.

import { PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
// pump.fun's SDK must be loaded through its CommonJS build: its ESM build does not import in Node
// ("Named export 'BN' not found" from @coral-xyz/anchor).
const { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, isSharingConfigEditable } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

const pk = (a) => (a instanceof PublicKey ? a : new PublicKey(a));

/** What pump.fun's chain state says about where this coin's creator fees go. Read-only. */
export async function readPumpFees(connection, mint, feeWallet) {
  const sdk = new OnlinePumpSdk(connection);
  const mintPk = pk(mint), wallet = pk(feeWallet).toBase58();
  let bc;
  try { bc = await sdk.fetchBondingCurve(mintPk); } catch { return { found: false }; }
  const sharingConfig = feeSharingConfigPda(mintPk);
  const creator = bc.creator.toBase58();
  const out = {
    found: true, creator, graduated: !!bc.complete,
    creatorIsFeeWallet: creator === wallet,
    usingSharing: bc.creator.equals(sharingConfig), sharingConfig: sharingConfig.toBase58(),
    shareholders: null, locked: null, feeWalletBps: 0,
  };
  if (out.usingSharing) {
    const info = await connection.getAccountInfo(sharingConfig);
    if (info) {
      const cfg = PUMP_SDK.decodeSharingConfig(info);
      out.shareholders = cfg.shareholders.map((s) => ({ address: s.address.toBase58(), bps: Number(s.shareBps) }));
      out.locked = !isSharingConfigEditable({ sharingConfig: cfg });
      out.feeWalletBps = out.shareholders.filter((s) => s.address === wallet).reduce((t, s) => t + s.bps, 0);
    }
  }
  out.allToFeeWallet = out.creatorIsFeeWallet || out.feeWalletBps === 10_000;
  return out;
}

/**
 * Instructions that move this coin's waiting creator fees into the fee wallet right now,
 * or { kind: "none", reason } when there is nothing to do. The fee wallet signs and pays.
 */
export async function pumpFeeInstructions(connection, mint, feeWallet) {
  const sdk = new OnlinePumpSdk(connection);
  const mintPk = pk(mint), walletPk = pk(feeWallet);
  const status = await readPumpFees(connection, mintPk, walletPk);
  if (!status.found) return { kind: "none", reason: "no pump.fun bonding curve for this mint", status };
  if (status.creatorIsFeeWallet) {
    const ixs = await sdk.collectCoinCreatorFeeInstructions(walletPk, walletPk);
    return { kind: "collect", ixs, status };
  }
  if (status.usingSharing && status.feeWalletBps > 0) {
    const min = await sdk.getMinimumDistributableFee(mintPk, walletPk, { payer: walletPk });
    if (!min.canDistribute) return { kind: "none", reason: `fees below pump.fun's minimum to distribute (${min.distributableFees} of ${min.minimumRequired} lamports)`, status };
    const r = await sdk.buildDistributeCreatorFeesInstructions(mintPk, { payer: walletPk });
    return { kind: "distribute", ixs: r.instructions, status };
  }
  return { kind: "none", reason: `creator fees go to ${status.creator}, not to the fee wallet; set up pump.fun fee sharing with 100% to ${walletPk.toBase58()}`, status };
}
