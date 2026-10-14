// Instruction builders for the Router program, driven by its generated IDL
// (idl/claustrum_router.json, produced from programs/claustrum-router).

import { fileURLToPath } from "node:url";
import { loadIdl, buildIx } from "./idl.mjs";
import { TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM } from "./bags.mjs";
import { vaultAddress, routerAddress, findProgramAddress } from "./pda.mjs";

export const ACTION_CODES = Object.freeze({ hold: 0, give: 1, burn: 2, alms_in: 3, alms_out: 4, inscribe: 5, depart: 6, spawn: 7, bell: 8 });

const BASE_IDL = loadIdl(fileURLToPath(new URL("../../../idl/claustrum_router.json", import.meta.url)));

export class RouterIx {
  constructor(programId) {
    this.programId = programId;
    this.idl = { ...BASE_IDL, address: programId };
    this.router = routerAddress(programId)[0];
    this.vault = vaultAddress(programId)[0];
  }

  #ix(name, accounts, args = {}, remaining = []) {
    return buildIx(this.idl, name, {
      accounts: { router: this.router, vault: this.vault, token_program: TOKEN_PROGRAM, system_program: SYSTEM_PROGRAM, associated_token_program: ATA_PROGRAM, ...accounts },
      args,
      remaining,
    });
  }

  initialize({ payer, admin, cranker }) { return this.#ix("initialize", { payer, admin }, { cranker }); }
  setAgent({ admin, index, agent }) { return this.#ix("set_agent", { admin }, { index, agent }); }
  holding(index) { return findProgramAddress(["holding", Uint8Array.of(index)], this.programId)[0]; }
  get bowl() { return findProgramAddress(["bowl"], this.programId)[0]; }
  get sealed() { return findProgramAddress(["sealed"], this.programId)[0]; }
  initEnclosure({ payer, admin, mint }) { return this.#ix("init_enclosure", { payer, admin, mint, bowl: this.bowl, sealed: this.sealed }); }
  initHolding({ payer, index, mint }) { return this.#ix("init_holding", { payer, mint, holding: this.holding(index) }, { _index: index }); }
  admitFirst({ admin, index }) { return this.#ix("admit_first", { admin }, { index }); }
  renounceAdmin({ admin }) { return this.#ix("renounce_admin", { admin }); }

  /**
   * One agent turn. action: hold | give | burn | alms_in | alms_out | inscribe | depart | spawn | bell
   * The 10 holding accounts are always passed, in alcove order.
   */
  takeTurn({ agent, agentIndex, action, amount = 0n, target = 0, choice = 0, inscription = "", digest, mint }) {
    const code = ACTION_CODES[action];
    if (code === undefined) throw new Error(`unknown action ${action}`);
    if (Buffer.byteLength(inscription, "utf8") > 120) throw new Error("inscription is over 120 bytes");
    const holdings = Array.from({ length: 10 }, (_, k) => ({ pubkey: this.holding(k), isSigner: false, isWritable: true }));
    return this.#ix("take_turn", { agent, mint, bowl: this.bowl, sealed: this.sealed },
      { agent_index: agentIndex, action: code, amount: BigInt(amount), target, choice, inscription, digest: [...digest] }, holdings);
  }
}
