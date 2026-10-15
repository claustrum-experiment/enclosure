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
 * @param o.tokenProgram the program that owns the mint (SPL Token or Token-2022); read it from chain
 * @param o.onChain    what already exists (from readSetupState), so finished steps are skipped:
 *                     { routerExists, agents: (address|null)[10], mint, holdings: boolean[10], status: string[10], admin }
 */
export function setupPlan({ programId, admin, cranker, agents, mint, renounce = false, tokenProgram, onChain = null }) {
  for (const [k, v] of Object.entries({ programId, admin, cranker })) if (!isPubkey(v)) throw new Error(`${k} is not a valid address`);
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > 10 || !agents.every(isPubkey)) throw new Error("agents must be 1 to 10 wallet addresses");
  if (new Set(agents).size !== agents.length) throw new Error("agent wallets must be distinct");
  if (agents.includes(admin) || agents.includes(cranker)) throw new Error("agent wallets must not be the admin or cranker");
  const r = new RouterIx(programId, tokenProgram ? { tokenProgram } : {});
  const R = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  const c = onChain;
  const steps = [];
  const warnings = [];
  if (!c?.routerExists) steps.push({ name: "initialize", description: `create the Router with ${admin} as admin`, ixs: [r.initialize({ payer: admin, admin, cranker })] });
  const toSet = agents.map((agent, index) => ({ agent, index })).filter(({ agent, index }) => {
    const have = c?.agents?.[index];
    if (have && have !== agent) throw new Error(`alcove ${R[index]} is already registered to ${have}, not ${agent}`);
    return !have;
  });
  if (toSet.length) steps.push({ name: "agents", description: `register agent wallet(s) in alcove(s) ${toSet.map((a) => R[a.index]).join(", ")} (each alcove can be set only once)`, ixs: toSet.map(({ agent, index }) => r.setAgent({ admin, index, agent })) });
  if (isPubkey(mint)) {
    if (c?.mint && c.mint !== mint) throw new Error(`the enclosure already holds ${c.mint}, not ${mint}`);
    if (!c?.mint) steps.push({ name: "enclosure", description: `the enclosure holds ${mint}; create the bowl and sealed vault`, ixs: [r.initEnclosure({ payer: admin, admin, mint })] });
    const missing = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((k) => !c?.holdings?.[k]);
    for (const [name, group] of [["holdings-1", missing.filter((k) => k < 5)], ["holdings-2", missing.filter((k) => k >= 5)]]) {
      if (group.length) steps.push({ name, description: `create holdings for alcoves ${group.map((k) => R[k]).join(", ")}`, ixs: group.map((index) => r.initHolding({ payer: admin, index, mint })) });
    }
    const first = agents.slice(0, 2).map((_, index) => index).filter((k) => !c?.status || c.status[k] === "empty");
    if (first.length) steps.push({ name: "admit-first", description: `let ${first.map((k) => `agent ${R[k]}`).join(" and ")} into the courtyard (every later agent must be called in by a spawn)`, ixs: first.map((index) => r.admitFirst({ admin, index })) });
    if (renounce && (!c || c.admin)) steps.push({ name: "renounce-admin", description: "give up the admin role for good: nobody can change anything after this", ixs: [r.renounceAdmin({ admin })] });
  } else {
    warnings.push("No --mint yet: the enclosure, holdings and first admission are left out. Re-run after the token launch.");
    if (renounce) warnings.push("--renounce ignored until the enclosure is set up.");
  }
  return { steps, warnings };
}
