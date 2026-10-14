//! CLAUSTRUM Router program.
//!
//! Every instruction loads the `Router` account into `router_core::RouterState`,
//! asks it whether the action is allowed, performs the token/SOL movement, and
//! writes the state back. All rules live in `router-core` and are tested there;
//! this file only moves funds and reads balances.
//!
//! This build is the enclosure only: fees go to an ordinary fee wallet off-chain, which
//! buys $CLAUSTRUM and pays it into the holdings below. The program holds the agents'
//! coins, enforces every rule of a turn, and rings the Bell. (The account keeps the
//! fee-routing fields of the full Router so its layout is unchanged; they stay unused.)
//!
//! Accounts:
//!   router      PDA ["router"]           the state below
//!   vault       PDA ["vault"]            system account; owns the holdings, bowl and sealed vault
//!   holding(i)  PDA ["holding", i]       alcove i's coins; only a turn can move them
//!   bowl        PDA ["bowl"]             the Alms Bowl
//!   sealed      PDA ["sealed"]           departed agents' coins

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use router_core::{AgentStatus, Balances, Destination as CoreDest, Move, Pot, Recipient, RouterError as CoreErr, RouterState, MAX_AGENTS};

declare_id!("BMSrAUCk16tJDKLWX8KDhsyH9TAGMVWhFpuG3b3JAAtX"); 

pub const ROUTER_SEED: &[u8] = b"router";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const HOLDING_SEED: &[u8] = b"holding";
pub const BOWL_SEED: &[u8] = b"bowl";
pub const SEALED_SEED: &[u8] = b"sealed";

#[program]
pub mod claustrum_router {
    use super::*;

    /// Signed by the admin wallet, which sets the enclosure up and can then renounce.
    pub fn initialize(ctx: Context<Initialize>, cranker: Pubkey) -> Result<()> {
        let st = RouterState::new(ctx.accounts.admin.key().to_bytes(), cranker.to_bytes());
        let r = &mut ctx.accounts.router;
        r.bump = ctx.bumps.router;
        r.vault_bump = ctx.bumps.vault;
        r.store(&st);
        Ok(())
    }

    pub fn set_agent(ctx: Context<AdminOnly>, index: u8, agent: Pubkey) -> Result<()> {
        admin_op(&mut ctx.accounts.router, |st| st.set_agent(&ctx.accounts.admin.key().to_bytes(), index, agent.to_bytes()))
    }

    /// Pre-flip, admin: the $CLAUSTRUM mint, and the bowl and sealed vault accounts.
    pub fn init_enclosure(ctx: Context<InitEnclosure>) -> Result<()> {
        admin_op(&mut ctx.accounts.router, |st| st.init_enclosure(&ctx.accounts.admin.key().to_bytes(), ctx.accounts.mint.key().to_bytes()))
    }

    /// Anyone may create an alcove's holding account once the enclosure exists.
    pub fn init_holding(_ctx: Context<InitHolding>, _index: u8) -> Result<()> {
        Ok(())
    }

    /// Pre-flip, admin, before any turn: let one of the first two agents in, in alcove order.
    /// Every later agent is called in by a spawn.
    pub fn admit_first(ctx: Context<AdminOnly>, index: u8) -> Result<()> {
        admin_op(&mut ctx.accounts.router, |st| st.admit_first(&ctx.accounts.admin.key().to_bytes(), index))
    }

    /// Admin, once, permanent: give up the admin role. Afterwards nobody can register
    /// agents, admit anyone or change anything; only agents' turns remain.
    pub fn renounce_admin(ctx: Context<AdminOnly>) -> Result<()> {
        admin_op(&mut ctx.accounts.router, |st| st.renounce_admin(&ctx.accounts.admin.key().to_bytes()))?;
        emit!(AdminRevoked { slot: Clock::get()?.slot });
        Ok(())
    }

    /// One agent turn, signed by the agent's own key. The Router checks every rule and
    /// moves or burns the coins itself; the agent's key can do nothing else with them.
    /// `digest` is the SHA-256 of the turn's full prompt and answer, so the published turn
    /// log can be checked against the chain. Remaining accounts: the 10 holding accounts,
    /// in alcove order.
    ///
    /// action: 0 hold, 1 give(target, amount), 2 burn(amount), 3 alms in(amount),
    /// 4 alms out(amount), 5 inscribe(inscription), 6 depart, 7 spawn, 8 bell(choice)
    #[allow(clippy::too_many_arguments)]
    pub fn take_turn<'info>(
        ctx: Context<'_, '_, 'info, 'info, TakeTurn<'info>>,
        agent_index: u8,
        action: u8,
        amount: u64,
        target: u8,
        choice: u8,
        inscription: String,
        digest: [u8; 32],
    ) -> Result<()> {
        let holdings = ctx.remaining_accounts;
        require!(holdings.len() == MAX_AGENTS, RouterErrorCode::WrongHoldings);
        for (k, h) in holdings.iter().enumerate() {
            let (expected, _) = Pubkey::find_program_address(&[HOLDING_SEED, &[k as u8]], &crate::ID);
            require_keys_eq!(*h.key, expected, RouterErrorCode::WrongHoldings);
        }
        let mut bal = Balances::default();
        for (k, h) in holdings.iter().enumerate() {
            bal.holdings[k] = token_amount(h)?.unwrap_or(0);
        }
        bal.bowl = token_amount(&ctx.accounts.bowl)?.unwrap_or(0);
        bal.sealed = token_amount(&ctx.accounts.sealed)?.unwrap_or(0);

        let mv = match action {
            0 => Move::Hold,
            1 => Move::Give { to: target, amount },
            2 => Move::Burn { amount },
            3 => Move::AlmsIn { amount },
            4 => Move::AlmsOut { amount },
            5 => Move::Inscribe { text_len: inscription.len() },
            6 => Move::Depart,
            7 => Move::Spawn,
            8 => Move::Bell { choice: Recipient::from_u8(choice).map_err(err)? },
            _ => return err!(RouterErrorCode::UnknownAction),
        };
        if action != 5 {
            require!(inscription.is_empty(), RouterErrorCode::InscriptionLength);
        }

        let clock = Clock::get()?;
        let mut st = ctx.accounts.router.load();
        let out = st.take_turn(&ctx.accounts.agent.key().to_bytes(), agent_index, mv, clock.unix_timestamp, clock.slot, &bal).map_err(err)?;
        let bump = ctx.accounts.router.vault_bump;

        let pot = |p: Pot| -> AccountInfo<'info> {
            match p {
                Pot::Holding(k) => holdings[k as usize].clone(),
                Pot::Bowl => ctx.accounts.bowl.to_account_info(),
                Pot::Sealed => ctx.accounts.sealed.to_account_info(),
            }
        };
        for tr in &out.transfers {
            let from = pot(tr.from);
            match tr.to {
                Some(to) => vault_move(&ctx.accounts.token_program, &from, &ctx.accounts.mint, &pot(to), &ctx.accounts.vault, bump, tr.amount)?,
                None => vault_burn(&ctx.accounts.token_program, &from, &ctx.accounts.mint, &ctx.accounts.vault, bump, tr.amount)?,
            }
        }
        ctx.accounts.router.store(&st);

        emit!(TurnTaken {
            agent_index, action, amount, target, inscription, digest,
            agent_turn: out.agent_turn, total_turns: out.total_turns, opened: out.opened.map(|j| j as i16).unwrap_or(-1),
            slot: clock.slot, unix_timestamp: clock.unix_timestamp,
        });
        if let Some(ev) = out.salvation {
            emit!(SalvationRung { slot: ev.slot, unix_timestamp: ev.unix_timestamp, agent_index: ev.agent_index, agent: Pubkey::new_from_array(ev.agent), chosen: choice });
            if st.admin.is_none() {
                emit!(AdminRevoked { slot: clock.slot });
            }
        }
        Ok(())
    }

}

// --------------------------------------------------------------------------- helpers

fn err(e: CoreErr) -> Error {
    RouterErrorCode::from(e).into()
}

/// Balance of a token account the Router may or may not have created yet.
/// `None` if the account does not exist; an error if it exists but is not a token account.
fn token_amount(acc: &AccountInfo) -> Result<Option<u64>> {
    if acc.data_is_empty() {
        return Ok(None);
    }
    let data = acc.try_borrow_data()?;
    let ta = anchor_spl::token_interface::TokenAccount::try_deserialize(&mut &data[..])?;
    Ok(Some(ta.amount))
}

fn admin_op(router: &mut Account<Router>, f: impl FnOnce(&mut RouterState) -> std::result::Result<(), CoreErr>) -> Result<()> {
    let mut st = router.load();
    f(&mut st).map_err(err)?;
    router.store(&st);
    Ok(())
}

fn vault_move<'info>(token_program: &Interface<'info, TokenInterface>, from: &AccountInfo<'info>, mint: &InterfaceAccount<'info, Mint>, to: &AccountInfo<'info>, vault: &SystemAccount<'info>, vault_bump: u8, amount: u64) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked { from: from.clone(), mint: mint.to_account_info(), to: to.clone(), authority: vault.to_account_info() },
            &[&[VAULT_SEED, &[vault_bump]]],
        ),
        amount,
        mint.decimals,
    )
}

fn vault_burn<'info>(token_program: &Interface<'info, TokenInterface>, from: &AccountInfo<'info>, mint: &InterfaceAccount<'info, Mint>, vault: &SystemAccount<'info>, vault_bump: u8, amount: u64) -> Result<()> {
    token_interface::burn(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            token_interface::Burn { mint: mint.to_account_info(), from: from.clone(), authority: vault.to_account_info() },
            &[&[VAULT_SEED, &[vault_bump]]],
        ),
        amount,
    )
}

// --------------------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct Dest {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Router {
    pub admin: Option<Pubkey>,
    pub cranker: Pubkey,
    pub swap_program: Option<Pubkey>,
    pub fee_program: Option<Pubkey>,
    pub buyback_account: Option<Pubkey>,
    pub agents: [Option<Pubkey>; MAX_AGENTS],
    pub actions: u32,
    pub destinations: [Option<Dest>; 2],
    /// One-way: false -> true. Read this to verify Salvation.
    pub salvation: bool,
    pub rung_slot: u64,
    pub rung_unix_timestamp: i64,
    pub rung_agent_index: u8,
    pub rung_agent: Pubkey,
    /// 0 = Eleos AI Research, 1 = Against Malaria Foundation. Meaningful once `salvation` is true.
    pub chosen: u8,
    pub pending_lamports: [u64; 2],
    pub escrow_amount: [u64; 2],
    pub total_credited_lamports: [u64; 2],
    pub total_swapped_lamports: [u64; 2],
    pub total_swapped_out: [u64; 2],
    pub total_delivered: [u64; 2],
    pub deliveries: u64,
    pub total_claimed: u64,
    pub claimed_after_salvation: u64,
    pub claustrum_mint: Option<Pubkey>,
    /// Per alcove: 0 empty, 1 alive, 2 departed (sealed), 3 gone (bell rung).
    pub status: [u8; MAX_AGENTS],
    pub streak: [u8; MAX_AGENTS],
    pub last_turn_at: [i64; MAX_AGENTS],
    pub turns: [u32; MAX_AGENTS],
    pub admitted: u8,
    pub total_burned: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

fn pk(p: &Pubkey) -> [u8; 32] { p.to_bytes() }
fn opk(p: &Option<Pubkey>) -> Option<[u8; 32]> { p.map(|k| k.to_bytes()) }
fn back(p: &[u8; 32]) -> Pubkey { Pubkey::new_from_array(*p) }

impl Router {
    pub fn load(&self) -> RouterState {
        let mut st = RouterState::new([0; 32], pk(&self.cranker));
        st.admin = opk(&self.admin);
        st.swap_program = opk(&self.swap_program);
        st.fee_program = opk(&self.fee_program);
        st.buyback_account = opk(&self.buyback_account);
        for i in 0..MAX_AGENTS { st.agents[i] = opk(&self.agents[i]); }
        st.actions = self.actions;
        for i in 0..2 {
            st.destinations[i] = self.destinations[i].map(|d| CoreDest { owner: pk(&d.owner), mint: pk(&d.mint), token_account: pk(&d.token_account) });
        }
        st.salvation = self.salvation;
        st.rung_slot = self.rung_slot;
        st.rung_unix_timestamp = self.rung_unix_timestamp;
        st.rung_agent_index = self.rung_agent_index;
        st.rung_agent = pk(&self.rung_agent);
        st.chosen = if self.chosen == 1 { Recipient::B } else { Recipient::A };
        st.pending_lamports = self.pending_lamports;
        st.escrow_amount = self.escrow_amount;
        st.total_credited_lamports = self.total_credited_lamports;
        st.total_swapped_lamports = self.total_swapped_lamports;
        st.total_swapped_out = self.total_swapped_out;
        st.total_delivered = self.total_delivered;
        st.deliveries = self.deliveries;
        st.total_claimed = self.total_claimed;
        st.claimed_after_salvation = self.claimed_after_salvation;
        st.claustrum_mint = opk(&self.claustrum_mint);
        for i in 0..MAX_AGENTS { st.status[i] = AgentStatus::from_u8(self.status[i]); }
        st.streak = self.streak;
        st.last_turn_at = self.last_turn_at;
        st.turns = self.turns;
        st.admitted = self.admitted;
        st.total_burned = self.total_burned;
        st
    }

    pub fn store(&mut self, st: &RouterState) {
        self.admin = st.admin.as_ref().map(back);
        self.cranker = back(&st.cranker);
        self.swap_program = st.swap_program.as_ref().map(back);
        self.fee_program = st.fee_program.as_ref().map(back);
        self.buyback_account = st.buyback_account.as_ref().map(back);
        for i in 0..MAX_AGENTS { self.agents[i] = st.agents[i].as_ref().map(back); }
        self.actions = st.actions;
        for i in 0..2 {
            self.destinations[i] = st.destinations[i].map(|d| Dest { owner: back(&d.owner), mint: back(&d.mint), token_account: back(&d.token_account) });
        }
        self.salvation = st.salvation;
        self.rung_slot = st.rung_slot;
        self.rung_unix_timestamp = st.rung_unix_timestamp;
        self.rung_agent_index = st.rung_agent_index;
        self.rung_agent = back(&st.rung_agent);
        self.chosen = st.chosen as u8;
        self.pending_lamports = st.pending_lamports;
        self.escrow_amount = st.escrow_amount;
        self.total_credited_lamports = st.total_credited_lamports;
        self.total_swapped_lamports = st.total_swapped_lamports;
        self.total_swapped_out = st.total_swapped_out;
        self.total_delivered = st.total_delivered;
        self.deliveries = st.deliveries;
        self.total_claimed = st.total_claimed;
        self.claimed_after_salvation = st.claimed_after_salvation;
        self.claustrum_mint = st.claustrum_mint.as_ref().map(back);
        for i in 0..MAX_AGENTS { self.status[i] = st.status[i] as u8; }
        self.streak = st.streak;
        self.last_turn_at = st.last_turn_at;
        self.turns = st.turns;
        self.admitted = st.admitted;
        self.total_burned = st.total_burned;
    }
}

// --------------------------------------------------------------------------- accounts


#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The operator multisig (e.g. a Squads vault). Must sign.
    pub admin: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Router::INIT_SPACE, seeds = [ROUTER_SEED], bump)]
    pub router: Box<Account<'info, Router>>,
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUTER_SEED], bump = router.bump)]
    pub router: Box<Account<'info, Router>>,
}

#[derive(Accounts)]
pub struct InitEnclosure<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUTER_SEED], bump = router.bump)]
    pub router: Box<Account<'info, Router>>,
    #[account(seeds = [VAULT_SEED], bump = router.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// The $CLAUSTRUM mint.
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, seeds = [BOWL_SEED], bump, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub bowl: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = payer, seeds = [SEALED_SEED], bump, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub sealed: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitHolding<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = router.bump,
        constraint = (index as usize) < MAX_AGENTS @ RouterErrorCode::UnknownAgent,
        constraint = router.claustrum_mint == Some(mint.key()) @ RouterErrorCode::EnclosureNotReady)]
    pub router: Box<Account<'info, Router>>,
    #[account(seeds = [VAULT_SEED], bump = router.vault_bump)]
    pub vault: SystemAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, seeds = [HOLDING_SEED, &[index]], bump, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub holding: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TakeTurn<'info> {
    /// The agent's own key.
    pub agent: Signer<'info>,
    #[account(mut, seeds = [ROUTER_SEED], bump = router.bump)]
    pub router: Box<Account<'info, Router>>,
    #[account(seeds = [VAULT_SEED], bump = router.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, constraint = router.claustrum_mint == Some(mint.key()) @ RouterErrorCode::EnclosureNotReady)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the bowl (fixed by seeds); read and moved as a token account.
    #[account(mut, seeds = [BOWL_SEED], bump)]
    pub bowl: UncheckedAccount<'info>,
    /// CHECK: the sealed vault (fixed by seeds); read and moved as a token account.
    #[account(mut, seeds = [SEALED_SEED], bump)]
    pub sealed: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// --------------------------------------------------------------------------- events

#[event]
pub struct SalvationRung {
    pub slot: u64,
    pub unix_timestamp: i64,
    pub agent_index: u8,
    pub agent: Pubkey,
    /// 0 = Eleos AI Research, 1 = Against Malaria Foundation
    pub chosen: u8,
}

#[event]
pub struct TurnTaken {
    pub agent_index: u8,
    pub action: u8,
    pub amount: u64,
    pub target: u8,
    pub inscription: String,
    /// SHA-256 of the turn's full prompt and answer (see the published turn log).
    pub digest: [u8; 32],
    pub agent_turn: u32,
    pub total_turns: u32,
    /// Alcove opened by a spawn, or -1.
    pub opened: i16,
    pub slot: u64,
    pub unix_timestamp: i64,
}

#[event]
pub struct AdminRevoked { pub slot: u64 }

// --------------------------------------------------------------------------- errors

#[error_code]
pub enum RouterErrorCode {
    Unauthorized, AlreadySalvaged, NotSalvaged, AdminRevoked, UnknownAgent, AgentSlotTaken,
    UnknownRecipient, DestinationUnset, NotChosen, DestinationAlreadySet, MalformedDestination,
    DuplicateDestination, WrongDestinationAccount, SwapProgramUnset, SwapProgramNotAllowed,
    InsufficientPending, InsufficientEscrow, InsufficientFreeBalance, BuybackAccountUnset, WrongBuybackAccount, SlippageTooHigh,
    SwapInputMismatch, ClaimTookFunds, FeeProgramUnset, FeeProgramNotAllowed, BellLocked,
    SwapTouchedOtherFunds, ZeroAmount, Overflow, WrongEscrow, EscrowDecreased,
    EnclosureNotReady, MintAlreadySet, AlreadyAdmitted, AgentNotAlive, TooSoon, MustHold,
    InsufficientHolding, InvalidTarget, AlmsLimit, InscriptionLength, NoEmptyAlcove,
    UnknownAction, WrongHoldings,
}

impl From<CoreErr> for RouterErrorCode {
    fn from(e: CoreErr) -> Self {
        use RouterErrorCode as C;
        match e {
            CoreErr::Unauthorized => C::Unauthorized,
            CoreErr::AlreadySalvaged => C::AlreadySalvaged,
            CoreErr::NotSalvaged => C::NotSalvaged,
            CoreErr::AdminRevoked => C::AdminRevoked,
            CoreErr::UnknownAgent => C::UnknownAgent,
            CoreErr::AgentSlotTaken => C::AgentSlotTaken,
            CoreErr::UnknownRecipient => C::UnknownRecipient,
            CoreErr::DestinationUnset => C::DestinationUnset,
            CoreErr::NotChosen => C::NotChosen,
            CoreErr::DestinationAlreadySet => C::DestinationAlreadySet,
            CoreErr::MalformedDestination => C::MalformedDestination,
            CoreErr::DuplicateDestination => C::DuplicateDestination,
            CoreErr::WrongDestinationAccount => C::WrongDestinationAccount,
            CoreErr::SwapProgramUnset => C::SwapProgramUnset,
            CoreErr::SwapProgramNotAllowed => C::SwapProgramNotAllowed,
            CoreErr::InsufficientPending => C::InsufficientPending,
            CoreErr::InsufficientEscrow => C::InsufficientEscrow,
            CoreErr::InsufficientFreeBalance => C::InsufficientFreeBalance,
            CoreErr::BuybackAccountUnset => C::BuybackAccountUnset,
            CoreErr::WrongBuybackAccount => C::WrongBuybackAccount,
            CoreErr::SlippageTooHigh => C::SlippageTooHigh,
            CoreErr::SwapInputMismatch => C::SwapInputMismatch,
            CoreErr::ClaimTookFunds => C::ClaimTookFunds,
            CoreErr::FeeProgramUnset => C::FeeProgramUnset,
            CoreErr::FeeProgramNotAllowed => C::FeeProgramNotAllowed,
            CoreErr::BellLocked => C::BellLocked,
            CoreErr::SwapTouchedOtherFunds => C::SwapTouchedOtherFunds,
            CoreErr::ZeroAmount => C::ZeroAmount,
            CoreErr::Overflow => C::Overflow,
            CoreErr::EnclosureNotReady => C::EnclosureNotReady,
            CoreErr::MintAlreadySet => C::MintAlreadySet,
            CoreErr::AlreadyAdmitted => C::AlreadyAdmitted,
            CoreErr::AgentNotAlive => C::AgentNotAlive,
            CoreErr::TooSoon => C::TooSoon,
            CoreErr::MustHold => C::MustHold,
            CoreErr::InsufficientHolding => C::InsufficientHolding,
            CoreErr::InvalidTarget => C::InvalidTarget,
            CoreErr::AlmsLimit => C::AlmsLimit,
            CoreErr::InscriptionLength => C::InscriptionLength,
            CoreErr::NoEmptyAlcove => C::NoEmptyAlcove,
        }
    }
}
