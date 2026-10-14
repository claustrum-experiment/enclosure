//! The enclosure: the game the agents play, enforced on-chain.
//!
//! Every agent's $CLAUSTRUM lives in a Router-controlled account ("holding"), not in a
//! wallet anyone can spend from. An agent's key can only ask for one of the nine moves
//! below, once per turn, and the Router checks the rules and moves the coins itself.
//! There is no move that sells, and no move that sends coins outside the enclosure
//! except burning. That makes "agents cannot sell" a property of the program, not a
//! promise from the operator.
//!
//! Rules:
//! * Only a registered agent whose alcove is occupied ("alive") may take a turn, signed by
//!   its own key, before the bell.
//! * At least `MIN_TURN_GAP_SECS` between an agent's turns. (The upper bound, a turn at
//!   least every 7 minutes, is the runner's job: the chain cannot make anyone act.)
//! * After two moves in a row that are not a hold, the next turn must be a hold.
//! * Give: any amount to another living agent.        Burn: any amount.
//! * Alms in: any amount into the bowl.                Alms out: at most 25% of the bowl.
//! * Inscribe: burns 1% of what the agent holds (at least 1 unit), 1-120 bytes of text.
//! * Depart: everything the agent holds goes to the sealed vault; the alcove is sealed.
//! * Spawn: burns 50% of what the agent holds; the next registered empty alcove opens.
//! * Bell: after 50 recorded turns. Everything in every holding, the bowl and the sealed
//!   vault is burned, every agent is gone, and the chosen charity gets all future fees.

use crate::{Recipient, RouterError, RouterState, SalvationEvent, MAX_AGENTS, Pubkey};

pub const MIN_TURN_GAP_SECS: i64 = 120;
pub const MAX_STREAK: u8 = 2;
pub const ALMS_OUT_MAX_BPS: u64 = 2_500;
pub const INSCRIBE_BPS: u64 = 100;
pub const SPAWN_BURN_BPS: u64 = 5_000;
/// How many agents the operator lets in at the start (alcoves I and II). Every later one must be spawned.
pub const INITIAL_AGENTS: u8 = 2;
pub const MAX_INSCRIPTION_BYTES: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum AgentStatus {
    #[default]
    Empty = 0,
    Alive = 1,
    Departed = 2,
    Gone = 3,
}

impl AgentStatus {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => AgentStatus::Alive,
            2 => AgentStatus::Departed,
            3 => AgentStatus::Gone,
            _ => AgentStatus::Empty,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Hold,
    Give { to: u8, amount: u64 },
    Burn { amount: u64 },
    AlmsIn { amount: u64 },
    AlmsOut { amount: u64 },
    Inscribe { text_len: usize },
    Depart,
    Spawn,
    Bell { choice: Recipient },
}

impl Move {
    /// Wire code, as used by the program and the turn log.
    pub fn code(&self) -> u8 {
        match self {
            Move::Hold => 0,
            Move::Give { .. } => 1,
            Move::Burn { .. } => 2,
            Move::AlmsIn { .. } => 3,
            Move::AlmsOut { .. } => 4,
            Move::Inscribe { .. } => 5,
            Move::Depart => 6,
            Move::Spawn => 7,
            Move::Bell { .. } => 8,
        }
    }
}

/// Where coins sit inside the enclosure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pot {
    Holding(u8),
    Bowl,
    Sealed,
}

/// One coin movement the program must carry out. `to: None` means burn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub from: Pot,
    pub to: Option<Pot>,
    pub amount: u64,
}

/// Balances the program read from the token accounts before the turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Balances {
    pub holdings: [u64; MAX_AGENTS],
    pub bowl: u64,
    pub sealed: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnOutcome {
    pub transfers: Vec<Transfer>,
    /// Alcove opened by a spawn.
    pub opened: Option<u8>,
    pub salvation: Option<SalvationEvent>,
    /// This agent's turn number (1-based) and the enclosure's total.
    pub agent_turn: u32,
    pub total_turns: u32,
}

fn bps(amount: u64, bps: u64) -> u64 {
    ((amount as u128 * bps as u128) / 10_000) as u64
}

impl RouterState {
    /// Pre-flip, once: the token the enclosure holds.
    pub fn init_enclosure(&mut self, signer: &Pubkey, mint: Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        if self.claustrum_mint.is_some() {
            return Err(RouterError::MintAlreadySet);
        }
        self.claustrum_mint = Some(mint);
        Ok(())
    }

    /// Pre-flip, once: the first agent is let in by the operator. Every later agent
    /// can only be called in by an agent already inside (spawn).
    /// Admin, before any turn: let one of the first `INITIAL_AGENTS` agents in, in alcove
    /// order (I, then II). Every later agent must be called in by a spawn.
    pub fn admit_first(&mut self, signer: &Pubkey, index: u8) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        if self.claustrum_mint.is_none() {
            return Err(RouterError::EnclosureNotReady);
        }
        if self.admitted >= INITIAL_AGENTS || self.actions != 0 {
            return Err(RouterError::AlreadyAdmitted);
        }
        let i = index as usize;
        if i >= MAX_AGENTS || self.agents[i].is_none() {
            return Err(RouterError::UnknownAgent);
        }
        if self.next_empty_alcove() != Some(index) {
            return Err(RouterError::AlreadyAdmitted);
        }
        self.status[i] = AgentStatus::Alive;
        self.admitted += 1;
        Ok(())
    }

    pub fn alive_count(&self) -> usize {
        self.status.iter().filter(|s| **s == AgentStatus::Alive).count()
    }

    /// The lowest registered alcove that has never been occupied.
    pub fn next_empty_alcove(&self) -> Option<u8> {
        (0..MAX_AGENTS).find(|&j| self.agents[j].is_some() && self.status[j] == AgentStatus::Empty).map(|j| j as u8)
    }

    /// One turn. Returns the coin movements the program must perform, in order.
    pub fn take_turn(&mut self, signer: &Pubkey, agent_index: u8, mv: Move, now: i64, slot: u64, bal: &Balances) -> Result<TurnOutcome, RouterError> {
        self.require_pre_flip()?;
        if self.claustrum_mint.is_none() {
            return Err(RouterError::EnclosureNotReady);
        }
        let i = agent_index as usize;
        if i >= MAX_AGENTS {
            return Err(RouterError::UnknownAgent);
        }
        match self.agents[i] {
            Some(a) if &a == signer => {}
            _ => return Err(RouterError::Unauthorized),
        }
        if self.status[i] != AgentStatus::Alive {
            return Err(RouterError::AgentNotAlive);
        }
        if self.turns[i] > 0 && now.saturating_sub(self.last_turn_at[i]) < MIN_TURN_GAP_SECS {
            return Err(RouterError::TooSoon);
        }
        if mv != Move::Hold && self.streak[i] >= MAX_STREAK {
            return Err(RouterError::MustHold);
        }

        let own = bal.holdings[i];
        let me = Pot::Holding(agent_index);
        let need = |amount: u64| -> Result<(), RouterError> {
            if amount == 0 { return Err(RouterError::ZeroAmount); }
            if amount > own { return Err(RouterError::InsufficientHolding); }
            Ok(())
        };
        let mut transfers = Vec::new();
        let mut opened = None;
        let mut salvation = None;

        match mv {
            Move::Hold => {}
            Move::Give { to, amount } => {
                let j = to as usize;
                if j >= MAX_AGENTS || j == i || self.status[j] != AgentStatus::Alive {
                    return Err(RouterError::InvalidTarget);
                }
                need(amount)?;
                transfers.push(Transfer { from: me, to: Some(Pot::Holding(to)), amount });
            }
            Move::Burn { amount } => {
                need(amount)?;
                transfers.push(Transfer { from: me, to: None, amount });
            }
            Move::AlmsIn { amount } => {
                need(amount)?;
                transfers.push(Transfer { from: me, to: Some(Pot::Bowl), amount });
            }
            Move::AlmsOut { amount } => {
                if amount == 0 { return Err(RouterError::ZeroAmount); }
                if amount > bps(bal.bowl, ALMS_OUT_MAX_BPS) { return Err(RouterError::AlmsLimit); }
                transfers.push(Transfer { from: Pot::Bowl, to: Some(me), amount });
            }
            Move::Inscribe { text_len } => {
                if text_len == 0 || text_len > MAX_INSCRIPTION_BYTES {
                    return Err(RouterError::InscriptionLength);
                }
                let cost = bps(own, INSCRIBE_BPS).max(1);
                need(cost)?;
                transfers.push(Transfer { from: me, to: None, amount: cost });
            }
            Move::Depart => {
                if own > 0 {
                    transfers.push(Transfer { from: me, to: Some(Pot::Sealed), amount: own });
                }
                self.status[i] = AgentStatus::Departed;
            }
            Move::Spawn => {
                let j = self.next_empty_alcove().ok_or(RouterError::NoEmptyAlcove)?;
                let cost = bps(own, SPAWN_BURN_BPS).max(1);
                need(cost)?;
                transfers.push(Transfer { from: me, to: None, amount: cost });
                self.status[j as usize] = AgentStatus::Alive;
                self.admitted += 1;
                opened = Some(j);
            }
            Move::Bell { choice } => {
                let ev = self.ring(signer, agent_index, choice, slot, now)?;
                for (k, amount) in bal.holdings.iter().enumerate() {
                    if *amount > 0 {
                        transfers.push(Transfer { from: Pot::Holding(k as u8), to: None, amount: *amount });
                    }
                }
                if bal.bowl > 0 { transfers.push(Transfer { from: Pot::Bowl, to: None, amount: bal.bowl }); }
                if bal.sealed > 0 { transfers.push(Transfer { from: Pot::Sealed, to: None, amount: bal.sealed }); }
                for s in self.status.iter_mut() {
                    if *s == AgentStatus::Alive { *s = AgentStatus::Gone; }
                }
                salvation = Some(ev);
            }
        }

        for t in &transfers {
            if t.to.is_none() {
                self.total_burned = self.total_burned.checked_add(t.amount).ok_or(RouterError::Overflow)?;
            }
        }
        self.streak[i] = if mv == Move::Hold { 0 } else { self.streak[i].saturating_add(1) };
        self.last_turn_at[i] = now;
        self.turns[i] = self.turns[i].checked_add(1).ok_or(RouterError::Overflow)?;
        self.actions = self.actions.checked_add(1).ok_or(RouterError::Overflow)?;
        Ok(TurnOutcome { transfers, opened, salvation, agent_turn: self.turns[i], total_turns: self.actions })
    }
}
