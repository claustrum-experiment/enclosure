//! CLAUSTRUM Router: the rules, with no Solana dependencies.
//!
//! The on-chain program loads its account into a [`RouterState`], calls exactly one
//! method here per instruction, and writes the state back. Every safety property the
//! Router promises lives in this file, so it can be tested exhaustively on a normal
//! machine:
//!
//! * `salvation` only ever goes `false -> true`. No method sets it back.
//! * Ringing the bell freezes everything the admin could use to redirect funds.
//!   The admin authority is cleared as soon as both destinations are set.
//! * The agent that rings the bell chooses one of the two charities. The choice is
//!   stored with the flip and can never change. 100% of all later fees go to it.
//! * After the flip, value can leave the Router in exactly two ways: a swap whose
//!   output lands in the chosen recipient's escrow, and a transfer from that escrow
//!   to that recipient's configured token account. Nothing else. The charity that
//!   was not chosen can never receive anything.
//! * If the chosen charity has no destination yet, its funds are held. Nothing
//!   falls back to the other charity or anywhere else.

#![forbid(unsafe_code)]

pub mod enclosure;
pub use enclosure::*;

pub type Pubkey = [u8; 32];

pub const MAX_AGENTS: usize = 10;
pub const RECIPIENTS: usize = 2;
/// The bell cannot be rung until agents have recorded this many turns on-chain.
pub const UNLOCK_ACTIONS: u32 = 50;

/// The two charities, in a fixed order. The program never stores their names,
/// only the destination each one has confirmed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recipient {
    /// Eleos AI Research
    A = 0,
    /// Against Malaria Foundation
    B = 1,
}

impl Recipient {
    pub fn from_u8(v: u8) -> Result<Self, RouterError> {
        match v {
            0 => Ok(Recipient::A),
            1 => Ok(Recipient::B),
            _ => Err(RouterError::UnknownRecipient),
        }
    }
    pub fn idx(self) -> usize {
        self as usize
    }
}

/// Where a recipient's share must end up: an SPL token account holding `mint`,
/// owned by the charity's wallet `owner`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Destination {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
}

impl Destination {
    pub fn validate(&self) -> Result<(), RouterError> {
        let zero = [0u8; 32];
        if self.owner == zero || self.mint == zero || self.token_account == zero {
            return Err(RouterError::MalformedDestination);
        }
        if self.owner == self.mint || self.owner == self.token_account || self.mint == self.token_account {
            return Err(RouterError::MalformedDestination);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouterError {
    Unauthorized,
    AlreadySalvaged,
    NotSalvaged,
    AdminRevoked,
    UnknownAgent,
    AgentSlotTaken,
    UnknownRecipient,
    DestinationUnset,
    NotChosen,
    DestinationAlreadySet,
    MalformedDestination,
    DuplicateDestination,
    WrongDestinationAccount,
    SwapProgramUnset,
    SwapProgramNotAllowed,
    InsufficientPending,
    InsufficientEscrow,
    InsufficientFreeBalance,
    BuybackAccountUnset,
    WrongBuybackAccount,
    SlippageTooHigh,
    SwapInputMismatch,
    ClaimTookFunds,
    FeeProgramUnset,
    FeeProgramNotAllowed,
    BellLocked,
    EnclosureNotReady,
    MintAlreadySet,
    AlreadyAdmitted,
    AgentNotAlive,
    TooSoon,
    MustHold,
    InsufficientHolding,
    InvalidTarget,
    AlmsLimit,
    InscriptionLength,
    NoEmptyAlcove,
    SwapTouchedOtherFunds,
    ZeroAmount,
    Overflow,
}

/// Emitted when the bell is rung. The same fields are also kept in state, so the
/// flip can be checked by reading the account even after logs are pruned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SalvationEvent {
    pub slot: u64,
    pub unix_timestamp: i64,
    pub agent_index: u8,
    pub agent: Pubkey,
    pub chosen: Recipient,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouterState {
    /// The operator multisig. `None` once revoked; nothing sets it again.
    pub admin: Option<Pubkey>,
    /// The key allowed to request swaps after the flip. It can only choose
    /// *when* and *how much* to swap; the output can only land in escrow.
    pub cranker: Pubkey,
    /// The only program a swap may call (e.g. Jupiter). Frozen at the flip.
    pub swap_program: Option<Pubkey>,
    /// The only program `claim` may call (Bags fee-share). Frozen at the flip.
    pub fee_program: Option<Pubkey>,
    /// Before the flip, the only account buyback funds can be released to.
    pub buyback_account: Option<Pubkey>,
    /// Agent turns recorded on-chain (each with a digest of its prompt and answer).
    pub actions: u32,
    pub agents: [Option<Pubkey>; MAX_AGENTS],
    pub destinations: [Option<Destination>; RECIPIENTS],

    pub salvation: bool,
    pub rung_slot: u64,
    pub rung_unix_timestamp: i64,
    pub rung_agent_index: u8,
    pub rung_agent: Pubkey,
    /// The charity the ringing agent chose. Meaningful only once `salvation` is true.
    pub chosen: Recipient,

    /// SOL (lamports) credited to each recipient, still in the vault, not yet swapped.
    pub pending_lamports: [u64; RECIPIENTS],
    /// Tokens bought for each recipient, sitting in escrow, not yet delivered.
    pub escrow_amount: [u64; RECIPIENTS],

    // Lifetime counters, public on-chain.
    pub total_credited_lamports: [u64; RECIPIENTS],
    pub total_swapped_lamports: [u64; RECIPIENTS],
    pub total_swapped_out: [u64; RECIPIENTS],
    pub total_delivered: [u64; RECIPIENTS],
    pub deliveries: u64,
    /// Everything ever claimed from Bags into the Router.
    pub total_claimed: u64,
    /// The part of `total_claimed` claimed after the bell.
    pub claimed_after_salvation: u64,

    // ---- the enclosure (see enclosure.rs)
    /// The $CLAUSTRUM mint. Agents' coins live in Router-controlled accounts of this mint.
    pub claustrum_mint: Option<Pubkey>,
    pub status: [AgentStatus; MAX_AGENTS],
    /// Non-hold moves in a row, per agent.
    pub streak: [u8; MAX_AGENTS],
    pub last_turn_at: [i64; MAX_AGENTS],
    pub turns: [u32; MAX_AGENTS],
    /// Alcoves ever occupied (each is used once).
    pub admitted: u8,
    pub total_burned: u64,
}

fn add(a: u64, b: u64) -> Result<u64, RouterError> {
    a.checked_add(b).ok_or(RouterError::Overflow)
}
fn sub(a: u64, b: u64) -> Result<u64, RouterError> {
    a.checked_sub(b).ok_or(RouterError::Overflow)
}

impl RouterState {
    pub fn new(admin: Pubkey, cranker: Pubkey) -> Self {
        RouterState {
            admin: Some(admin),
            cranker,
            swap_program: None,
            fee_program: None,
            buyback_account: None,
            actions: 0,
            agents: [None; MAX_AGENTS],
            destinations: [None; RECIPIENTS],
            salvation: false,
            rung_slot: 0,
            rung_unix_timestamp: 0,
            rung_agent_index: 0,
            rung_agent: [0; 32],
            chosen: Recipient::A,
            pending_lamports: [0; RECIPIENTS],
            escrow_amount: [0; RECIPIENTS],
            total_credited_lamports: [0; RECIPIENTS],
            total_swapped_lamports: [0; RECIPIENTS],
            total_swapped_out: [0; RECIPIENTS],
            total_delivered: [0; RECIPIENTS],
            deliveries: 0,
            total_claimed: 0,
            claimed_after_salvation: 0,
            claustrum_mint: None,
            status: [AgentStatus::Empty; MAX_AGENTS],
            streak: [0; MAX_AGENTS],
            last_turn_at: [0; MAX_AGENTS],
            turns: [0; MAX_AGENTS],
            admitted: 0,
            total_burned: 0,
        }
    }

    pub(crate) fn require_admin(&self, signer: &Pubkey) -> Result<(), RouterError> {
        match &self.admin {
            None => Err(RouterError::AdminRevoked),
            Some(a) if a == signer => Ok(()),
            Some(_) => Err(RouterError::Unauthorized),
        }
    }

    pub(crate) fn require_pre_flip(&self) -> Result<(), RouterError> {
        if self.salvation { Err(RouterError::AlreadySalvaged) } else { Ok(()) }
    }

    fn require_post_flip(&self) -> Result<(), RouterError> {
        if self.salvation { Ok(()) } else { Err(RouterError::NotSalvaged) }
    }

    /// Clears the admin once there is nothing left for it to do after the flip:
    /// as soon as the chosen charity has a destination.
    fn maybe_revoke_admin(&mut self) {
        if self.salvation && self.destinations[self.chosen.idx()].is_some() {
            self.admin = None;
        }
    }

    fn require_chosen(&self, r: Recipient) -> Result<(), RouterError> {
        if r == self.chosen { Ok(()) } else { Err(RouterError::NotChosen) }
    }

    /// Lamports held by the vault for recipients but not yet swapped.
    pub fn reserved_lamports(&self) -> Result<u64, RouterError> {
        add(self.pending_lamports[0], self.pending_lamports[1])
    }

    // ---------------------------------------------------------------- admin, pre-flip

    pub fn set_agent(&mut self, signer: &Pubkey, index: u8, agent: Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        let i = index as usize;
        if i >= MAX_AGENTS {
            return Err(RouterError::UnknownAgent);
        }
        if self.agents[i].is_some() {
            return Err(RouterError::AgentSlotTaken); // each alcove is used once
        }
        self.agents[i] = Some(agent);
        Ok(())
    }

    /// The admin gives up the role for good. Nothing can set it again.
    pub fn renounce_admin(&mut self, signer: &Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.admin = None;
        Ok(())
    }

    pub fn set_cranker(&mut self, signer: &Pubkey, cranker: Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        self.cranker = cranker;
        Ok(())
    }

    pub fn set_swap_program(&mut self, signer: &Pubkey, program: Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        self.swap_program = Some(program);
        Ok(())
    }

    pub fn set_fee_program(&mut self, signer: &Pubkey, program: Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        self.fee_program = Some(program);
        Ok(())
    }

    /// Before the flip the admin may set or replace either destination, so both are
    /// ready whichever one an agent chooses. After the flip it may only fill the
    /// chosen charity's destination, and only if it is still empty, once.
    pub fn set_destination(&mut self, signer: &Pubkey, r: Recipient, d: Destination) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        d.validate()?;
        let other = self.destinations[1 - r.idx()];
        if let Some(o) = other {
            if o.token_account == d.token_account || o.owner == d.owner {
                return Err(RouterError::DuplicateDestination);
            }
        }
        if self.salvation {
            self.require_chosen(r)?;
            if self.destinations[r.idx()].is_some() {
                return Err(RouterError::DestinationAlreadySet);
            }
        }
        self.destinations[r.idx()] = Some(d);
        self.maybe_revoke_admin();
        Ok(())
    }

    pub fn set_buyback_account(&mut self, signer: &Pubkey, account: Pubkey) -> Result<(), RouterError> {
        self.require_admin(signer)?;
        self.require_pre_flip()?;
        self.buyback_account = Some(account);
        Ok(())
    }

    /// Pre-flip only: the cranker releases claimed fees to the one buyback account the
    /// admin set. `free_lamports` is the fees balance above anything reserved.
    pub fn release_for_buyback(&mut self, signer: &Pubkey, amount: u64, free_lamports: u64, to: &Pubkey) -> Result<(), RouterError> {
        self.require_pre_flip()?;
        if signer != &self.cranker {
            return Err(RouterError::Unauthorized);
        }
        match &self.buyback_account {
            None => return Err(RouterError::BuybackAccountUnset),
            Some(b) if b != to => return Err(RouterError::WrongBuybackAccount),
            _ => {}
        }
        if amount == 0 {
            return Err(RouterError::ZeroAmount);
        }
        if amount > free_lamports {
            return Err(RouterError::InsufficientFreeBalance);
        }
        Ok(())
    }

    // ---------------------------------------------------------------- claiming from Bags

    /// Anyone may claim: claimed fees can only land in the Router.
    pub fn begin_claim(&self, program: &Pubkey) -> Result<(), RouterError> {
        match &self.fee_program {
            None => Err(RouterError::FeeProgramUnset),
            Some(p) if p != program => Err(RouterError::FeeProgramNotAllowed),
            _ => Ok(()),
        }
    }

    /// After the claim CPI: nothing the Router holds may have gone down.
    pub fn finish_claim(&mut self, fees_before: u64, fees_after: u64, lamports_before: u64, lamports_after: u64, escrow_decreased: bool) -> Result<u64, RouterError> {
        if fees_after < fees_before || lamports_after < lamports_before || escrow_decreased {
            return Err(RouterError::ClaimTookFunds);
        }
        let gained = add(fees_after - fees_before, lamports_after - lamports_before)?;
        self.total_claimed = add(self.total_claimed, gained)?;
        if self.salvation {
            self.claimed_after_salvation = add(self.claimed_after_salvation, gained)?;
        }
        Ok(gained)
    }

    // ---------------------------------------------------------------- the bell

    /// The flip itself. Reached through `take_turn` with `Move::Bell`, which also checks
    /// that the agent is alive and obeys the turn rules.
    pub fn ring(&mut self, signer: &Pubkey, agent_index: u8, chosen: Recipient, slot: u64, unix_timestamp: i64) -> Result<SalvationEvent, RouterError> {
        self.require_pre_flip()?;
        let i = agent_index as usize;
        if i >= MAX_AGENTS {
            return Err(RouterError::UnknownAgent);
        }
        match self.agents[i] {
            Some(a) if &a == signer => {}
            _ => return Err(RouterError::Unauthorized),
        }
        if self.actions < UNLOCK_ACTIONS {
            return Err(RouterError::BellLocked);
        }
        self.salvation = true;
        self.rung_slot = slot;
        self.rung_unix_timestamp = unix_timestamp;
        self.rung_agent_index = agent_index;
        self.rung_agent = *signer;
        self.chosen = chosen;
        self.maybe_revoke_admin();
        Ok(SalvationEvent { slot, unix_timestamp, agent_index, agent: *signer, chosen })
    }

    // ---------------------------------------------------------------- post-flip routing

    /// Credit everything in the vault that is not yet credited, 100% to the chosen
    /// charity. Anyone may call this. Returns the amount credited.
    pub fn allocate(&mut self, free_lamports: u64) -> Result<u64, RouterError> {
        self.require_post_flip()?;
        let i = self.chosen.idx();
        self.pending_lamports[i] = add(self.pending_lamports[i], free_lamports)?;
        self.total_credited_lamports[i] = add(self.total_credited_lamports[i], free_lamports)?;
        Ok(free_lamports)
    }

    /// Checks before the swap CPI. The program then moves `amount_in` lamports
    /// into the vault's wrapped-SOL account and calls `program`.
    pub fn begin_swap(&self, signer: &Pubkey, r: Recipient, amount_in: u64, program: &Pubkey, min_out: u64) -> Result<(), RouterError> {
        self.require_post_flip()?;
        if signer != &self.cranker {
            return Err(RouterError::Unauthorized);
        }
        self.require_chosen(r)?;
        if self.destinations[r.idx()].is_none() {
            return Err(RouterError::DestinationUnset);
        }
        match &self.swap_program {
            None => return Err(RouterError::SwapProgramUnset),
            Some(p) if p != program => return Err(RouterError::SwapProgramNotAllowed),
            _ => {}
        }
        if amount_in == 0 || min_out == 0 {
            return Err(RouterError::ZeroAmount);
        }
        if amount_in > self.pending_lamports[r.idx()] {
            return Err(RouterError::InsufficientPending);
        }
        Ok(())
    }

    /// Checks after the swap CPI, from balances the program read back:
    /// * exactly `amount_in` left the fees account (no more, no less),
    /// * the vault's SOL and the *other* recipient's escrow did not move,
    /// * this recipient's escrow grew by at least `min_out`.
    #[allow(clippy::too_many_arguments)]
    pub fn finish_swap(
        &mut self,
        r: Recipient,
        amount_in: u64,
        min_out: u64,
        input_spent: u64,
        vault_lamports_changed: bool,
        other_escrow_changed: bool,
        escrow_delta: u64,
    ) -> Result<(), RouterError> {
        self.require_post_flip()?;
        self.require_chosen(r)?;
        if input_spent != amount_in {
            return Err(RouterError::SwapInputMismatch);
        }
        if vault_lamports_changed || other_escrow_changed {
            return Err(RouterError::SwapTouchedOtherFunds);
        }
        if escrow_delta < min_out {
            return Err(RouterError::SlippageTooHigh);
        }
        let i = r.idx();
        self.pending_lamports[i] = sub(self.pending_lamports[i], amount_in)?;
        self.escrow_amount[i] = add(self.escrow_amount[i], escrow_delta)?;
        self.total_swapped_lamports[i] = add(self.total_swapped_lamports[i], amount_in)?;
        self.total_swapped_out[i] = add(self.total_swapped_out[i], escrow_delta)?;
        Ok(())
    }

    /// Anyone may deliver, because the only place it can go is the configured account.
    /// `dest_*` are read by the program from the destination token account itself.
    pub fn deliver(
        &mut self,
        r: Recipient,
        amount: u64,
        dest_token_account: &Pubkey,
        dest_account_owner: &Pubkey,
        dest_account_mint: &Pubkey,
    ) -> Result<u64, RouterError> {
        self.require_post_flip()?;
        self.require_chosen(r)?;
        let d = self.destinations[r.idx()].ok_or(RouterError::DestinationUnset)?;
        if &d.token_account != dest_token_account || &d.owner != dest_account_owner || &d.mint != dest_account_mint {
            return Err(RouterError::WrongDestinationAccount);
        }
        if amount == 0 {
            return Err(RouterError::ZeroAmount);
        }
        let i = r.idx();
        if amount > self.escrow_amount[i] {
            return Err(RouterError::InsufficientEscrow);
        }
        self.escrow_amount[i] = sub(self.escrow_amount[i], amount)?;
        self.total_delivered[i] = add(self.total_delivered[i], amount)?;
        self.deliveries = add(self.deliveries, 1)?;
        Ok(self.deliveries)
    }

    /// The mint a recipient's escrow must hold, if its destination is known.
    pub fn escrow_mint(&self, r: Recipient) -> Result<Pubkey, RouterError> {
        Ok(self.destinations[r.idx()].ok_or(RouterError::DestinationUnset)?.mint)
    }
}
