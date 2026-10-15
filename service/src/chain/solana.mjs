// Well-known Solana program ids and the associated-token-account address, with no dependencies.

import { findProgramAddress } from "./pda.mjs";
import { decode as fromB58 } from "../base58.mjs";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const b = (addr) => Buffer.from(fromB58(addr));
/** The associated token account of `owner` for `mint`, under SPL Token (default) or Token-2022. */
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findProgramAddress([b(owner), b(tokenProgram), b(mint)], ATA_PROGRAM)[0];
