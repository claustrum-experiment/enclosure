// Before the bell: the buyback executor turns released wSOL into $CLAUSTRUM and splits
// it evenly between the living agents, paying into their Router-controlled holdings
// (never into a wallet anyone can spend from). It runs from its own hot wallet, which owns the
// one wSOL account the Router is allowed to release to. After the bell the Router
// refuses to release anything, so this has nothing to do.

import { ata, ATA_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM, WSOL_MINT } from "./chain/bags.mjs";

/** Even split; any remainder of the smallest unit stays with the executor for next time. */
export function splitEvenly(amount, holdings) {
  if (!holdings.length) throw new Error("no living agents to distribute to");
  const each = BigInt(amount) / BigInt(holdings.length);
  return holdings.map((h) => ({ holding: h, amount: each }));
}

export function createAtaIdempotentIx({ payer, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  };
}

export function transferCheckedIx({ source, mint, destination, owner, amount, decimals, tokenProgram = TOKEN_PROGRAM }) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimals;
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/**
 * Instructions that pay each living agent its share into its Router-controlled holding.
 * Holdings already exist (created at setup), so these are plain transfers.
 * `shares` are { holding, amount } with holding = RouterIx.holding(index).
 */
export function distributionBatches({ executor, mint, decimals, shares, batchSize = 8, tokenProgram = TOKEN_PROGRAM }) {
  const source = ata(executor, mint, tokenProgram);
  const ixs = shares.filter((s) => s.amount > 0n).map((s) => transferCheckedIx({ source, mint, destination: s.holding, owner: executor, amount: s.amount, decimals, tokenProgram }));
  const batches = [];
  for (let i = 0; i < ixs.length; i += batchSize) batches.push(ixs.slice(i, i + batchSize));
  return batches;
}

export const buybackWsolAccount = (executor) => ata(executor, WSOL_MINT);

/** SPL Token CloseAccount: unwraps wSOL back into the owner's SOL balance. */
export function closeAccountIx({ account, destination, owner, tokenProgram = TOKEN_PROGRAM }) {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  };
}

/**
 * How many lamports of the fee wallet may be spent on a buyback: everything above the
 * reserve kept for transaction fees and rent, and only if that clears the minimum
 * (tiny swaps waste fees). Returns 0n when nothing should be bought.
 */
export function spendableLamports(balance, { reserve, minimum }) {
  const free = BigInt(balance) - BigInt(reserve);
  return free >= BigInt(minimum) ? free : 0n;
}

