// The enclosure on Solana. Reads the Router account and the token balances of the ten
// holdings, the bowl and the sealed vault; sends take_turn signed by the agent's own key,
// with the cranker paying the transaction fee so agent keys need no SOL.

import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { RouterIx } from "../chain/router-ix.mjs";
import { decodeRouter } from "../chain/decode.mjs";

const STATUS_CODE = { empty: 0, alive: 1, departed: 2, gone: 3 };
const tokenAmount = (acc) => (acc && acc.data.length >= 72 ? acc.data.readBigUInt64LE(64) : 0n);

export class LiveEnclosure {
  /**
   * @param o.connection  web3.js Connection
   * @param o.programId   Router program id
   * @param o.mint        $CLAUSTRUM mint
   * @param o.agents      Keypair[] indexed by alcove (missing entries allowed)
   * @param o.cranker     Keypair paying fees
   */
  constructor({ connection, programId, mint, agents, cranker }) {
    Object.assign(this, { connection, programId, mint, agents, cranker });
    this.r = new RouterIx(programId);
    this.decimals = null;
  }

  async read() {
    const pk = (a) => new PublicKey(a);
    const [routerAcc, mintAcc] = await this.connection.getMultipleAccountsInfo([pk(this.r.router), pk(this.mint)], "confirmed");
    if (!routerAcc) throw new Error("Router account not found");
    const st = decodeRouter(routerAcc.data);
    if (st.claustrumMint !== this.mint) throw new Error(`Router enclosure mint is ${st.claustrumMint}, not ${this.mint}`);
    this.decimals ??= mintAcc.data[44];
    const pots = await this.connection.getMultipleAccountsInfo([...Array.from({ length: 10 }, (_, k) => pk(this.r.holding(k))), pk(this.r.bowl), pk(this.r.sealed)], "confirmed");
    const s = {
      agents: st.agents.map((a) => a !== null),
      status: st.status.map((x) => STATUS_CODE[x] ?? 0),
      streak: st.streak,
      turns: st.turns,
      lastTurnAt: st.lastTurnAt.map(Number),
      actions: st.actions,
      admitted: st.admitted,
      salvation: st.salvation,
      chosen: st.salvation ? st.chosen : null,
      totalBurned: st.totalBurned,
      agentKeys: st.agents,
    };
    const bal = { holdings: pots.slice(0, 10).map(tokenAmount), bowl: tokenAmount(pots[10]), sealed: tokenAmount(pots[11]) };
    return { s, bal, decimals: this.decimals };
  }

  async submit({ agentIndex, decision, digest }) {
    const agent = this.agents[agentIndex];
    if (!agent) throw new Error(`no key for alcove ${agentIndex + 1}`);
    const before = await this.read();
    if (before.s.agentKeys[agentIndex] !== agent.publicKey.toBase58()) throw new Error(`alcove ${agentIndex + 1} key does not match the Router's registry`);
    const ix = this.r.takeTurn({
      agent: agent.publicKey.toBase58(), agentIndex, action: decision.move, amount: decision.amount, target: decision.to ?? 0,
      choice: decision.charity === "amf" ? 1 : 0, inscription: decision.inscription ?? "", digest, mint: this.mint,
    });
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: ix.data }),
    ];
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: this.cranker.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    tx.sign([this.cranker, agent]);
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: true });
    if (sim.value.err) throw new Error(`take_turn refused: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).filter((l) => /Error|failed/.test(l)).join(" | ")}`);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`take_turn failed: ${JSON.stringify(conf.value.err)} (${signature})`);
    const after = await this.read();
    const opened = after.s.status.findIndex((x, k) => x === 1 && before.s.status[k] === 0);
    return { signature, opened: opened >= 0 ? opened : null, salvation: after.s.salvation };
  }
}
