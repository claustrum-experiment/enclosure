// The enclosure's setup, as an ordered list of steps signed by the one admin wallet.

import { RouterIx } from "./chain/router-ix.mjs";
import { isPubkey } from "./base58.mjs";

/**
 * @param o.programId  the program
 * @param o.admin      the admin wallet (signs and pays)
 * @param o.cranker    pays transaction fees for agent turns (recorded on the Router)
 * @param o.agents     1 to 10 agent wallet addresses, alcove order
 * @param o.mint       the $CLAUSTRUM mint (optional until the token exists)
 * @param o.renounce   append the permanent renounce_admin step
 */
export function setupPlan({ programId, admin, cranker, agents, mint, renounce = false }) {
  for (const [k, v] of Object.entries({ programId, admin, cranker })) if (!isPubkey(v)) throw new Error(`${k} is not a valid address`);
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > 10 || !agents.every(isPubkey)) throw new Error("agents must be 1 to 10 wallet addresses");
  if (new Set(agents).size !== agents.length) throw new Error("agent wallets must be distinct");
  if (agents.includes(admin) || agents.includes(cranker)) throw new Error("agent wallets must not be the admin or cranker");
  const r = new RouterIx(programId);
  const R = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  const steps = [
    { name: "initialize", description: `create the Router with ${admin} as admin`, ixs: [r.initialize({ payer: admin, admin, cranker })] },
    { name: "agents", description: `register ${agents.length} agent wallet(s) in alcoves I-${R[agents.length - 1]} (each alcove can be set only once)`, ixs: agents.map((agent, index) => r.setAgent({ admin, index, agent })) },
  ];
  const warnings = [];
  if (isPubkey(mint)) {
    steps.push({ name: "enclosure", description: `the enclosure holds ${mint}; create the bowl and sealed vault`, ixs: [r.initEnclosure({ payer: admin, admin, mint })] });
    steps.push({ name: "holdings-1", description: "create holdings for alcoves I-V", ixs: [0, 1, 2, 3, 4].map((index) => r.initHolding({ payer: admin, index, mint })) });
    steps.push({ name: "holdings-2", description: "create holdings for alcoves VI-X", ixs: [5, 6, 7, 8, 9].map((index) => r.initHolding({ payer: admin, index, mint })) });
    const first = agents.slice(0, 2).map((_, index) => index);
    steps.push({ name: "admit-first", description: `let the first ${first.length === 2 ? "two agents into alcoves I and II" : "agent into alcove I"} (every later agent must be called in by a spawn)`, ixs: first.map((index) => r.admitFirst({ admin, index })) });
    if (renounce) steps.push({ name: "renounce-admin", description: "give up the admin role for good: nobody can change anything after this", ixs: [r.renounceAdmin({ admin })] });
  } else {
    warnings.push("No --mint yet: the enclosure, holdings and first admission are left out. Re-run after the token launch.");
    if (renounce) warnings.push("--renounce ignored until the enclosure is set up.");
  }
  return { steps, warnings };
}
