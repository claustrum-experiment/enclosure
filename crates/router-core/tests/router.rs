//! The properties the spec requires, plus the guards around them.
//!   1. The flip is irreversible, and so is the agent's choice of charity.
//!   2. After the flip, funds cannot be routed anywhere except the chosen charity's
//!      configured destination. The charity that was not chosen gets nothing.
//!   3. A missing destination holds the funds; nothing falls back anywhere.

use router_core::*;

const ADMIN: Pubkey = [1; 32];
const CRANKER: Pubkey = [2; 32];
const JUPITER: Pubkey = [3; 32];
const AGENT0: Pubkey = [10; 32];
const AGENT1: Pubkey = [11; 32];
const STRANGER: Pubkey = [99; 32];
const BAGS: Pubkey = [4; 32];
const BUYBACK: Pubkey = [5; 32];

/// A = Eleos AI Research, B = Against Malaria Foundation (placeholders, not real addresses)
fn dest_a() -> Destination {
    Destination { owner: [20; 32], mint: [21; 32], token_account: [22; 32] }
}
fn dest_b() -> Destination {
    Destination { owner: [30; 32], mint: [31; 32], token_account: [32; 32] }
}

fn configured() -> RouterState {
    let mut s = RouterState::new(ADMIN, CRANKER);
    s.set_agent(&ADMIN, 0, AGENT0).unwrap();
    s.set_agent(&ADMIN, 1, AGENT1).unwrap();
    s.set_swap_program(&ADMIN, JUPITER).unwrap();
    s.set_fee_program(&ADMIN, BAGS).unwrap();
    s.set_buyback_account(&ADMIN, BUYBACK).unwrap();
    s.actions = UNLOCK_ACTIONS; // most tests start with the bell unlocked
    s
}

fn both_set() -> RouterState {
    let mut s = configured();
    s.set_destination(&ADMIN, Recipient::A, dest_a()).unwrap();
    s.set_destination(&ADMIN, Recipient::B, dest_b()).unwrap();
    s
}

/// Swap `amount` of the chosen charity's pending SOL into its escrow.
fn swap(s: &mut RouterState, r: Recipient, amount: u64, out: u64) {
    s.begin_swap(&CRANKER, r, amount, &JUPITER, 1).unwrap();
    s.finish_swap(r, amount, 1, amount, false, false, out).unwrap();
}

// ------------------------------------------------------------------ the bell

#[test]
fn ring_records_slot_time_agent_and_choice_and_returns_the_event() {
    let mut s = both_set();
    let ev = s.ring(&AGENT1, 1, Recipient::B, 777, 1_790_000_000).unwrap();
    assert_eq!(ev, SalvationEvent { slot: 777, unix_timestamp: 1_790_000_000, agent_index: 1, agent: AGENT1, chosen: Recipient::B });
    assert!(s.salvation);
    assert_eq!((s.rung_slot, s.rung_unix_timestamp, s.rung_agent_index, s.rung_agent, s.chosen), (777, 1_790_000_000, 1, AGENT1, Recipient::B));
}

#[test]
fn only_a_registered_agent_can_ring_and_only_from_its_own_slot() {
    let mut s = configured();
    assert_eq!(s.ring(&STRANGER, 0, Recipient::A, 1, 1), Err(RouterError::Unauthorized));
    assert_eq!(s.ring(&ADMIN, 0, Recipient::A, 1, 1), Err(RouterError::Unauthorized), "the operator cannot ring");
    assert_eq!(s.ring(&AGENT0, 1, Recipient::A, 1, 1), Err(RouterError::Unauthorized), "agent 0 cannot ring as agent 1");
    assert_eq!(s.ring(&AGENT0, 4, Recipient::A, 1, 1), Err(RouterError::Unauthorized), "empty alcove");
    assert_eq!(s.ring(&AGENT0, 10, Recipient::A, 1, 1), Err(RouterError::UnknownAgent));
    assert!(!s.salvation);
}

#[test]
fn agent_slots_are_used_once() {
    let mut s = configured();
    assert_eq!(s.set_agent(&ADMIN, 0, STRANGER), Err(RouterError::AgentSlotTaken));
}

#[test]
fn unknown_recipient_codes_are_rejected() {
    assert_eq!(Recipient::from_u8(2), Err(RouterError::UnknownRecipient));
    assert_eq!(Recipient::from_u8(1), Ok(Recipient::B));
}

// ------------------------------------------------------------------ property 1: irreversible

#[test]
fn the_bell_cannot_be_rung_twice_and_the_record_and_choice_never_change() {
    let mut s = both_set();
    s.ring(&AGENT1, 1, Recipient::A, 1234, 1_800_000_000).unwrap();
    let before = (s.rung_slot, s.rung_unix_timestamp, s.rung_agent_index, s.rung_agent, s.chosen);
    assert_eq!(s.ring(&AGENT0, 0, Recipient::B, 9999, 9999), Err(RouterError::AlreadySalvaged));
    assert_eq!(before, (s.rung_slot, s.rung_unix_timestamp, s.rung_agent_index, s.rung_agent, s.chosen));
}

#[test]
fn ringing_when_the_chosen_destination_is_set_revokes_the_admin_immediately() {
    let mut s = configured();
    s.set_destination(&ADMIN, Recipient::B, dest_b()).unwrap();
    s.ring(&AGENT0, 0, Recipient::B, 1, 1).unwrap();
    assert_eq!(s.admin, None, "only the chosen destination matters");
}

#[test]
fn after_the_flip_every_admin_power_is_gone() {
    let mut s = both_set();
    s.ring(&AGENT0, 0, Recipient::A, 1, 1).unwrap();
    assert_eq!(s.set_agent(&ADMIN, 5, STRANGER), Err(RouterError::AdminRevoked));
    assert_eq!(s.set_cranker(&ADMIN, STRANGER), Err(RouterError::AdminRevoked));
    assert_eq!(s.set_swap_program(&ADMIN, STRANGER), Err(RouterError::AdminRevoked));
    assert_eq!(s.set_destination(&ADMIN, Recipient::A, Destination { owner: [7; 32], mint: [8; 32], token_account: [9; 32] }), Err(RouterError::AdminRevoked));
    assert_eq!(s.release_for_buyback(&CRANKER, 1, 1_000_000, &BUYBACK), Err(RouterError::AlreadySalvaged));
    assert_eq!(s.set_buyback_account(&ADMIN, STRANGER), Err(RouterError::AdminRevoked));
}

/// Tiny deterministic PRNG so the fuzz test needs no dependencies and is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// One public operation with random signers and arguments, including hostile ones.
fn random_op(s: &mut RouterState, rng: &mut Rng, vault_free: &mut u64, deliveries: &mut Vec<(Recipient, Pubkey)>) {
    let signers = [ADMIN, CRANKER, AGENT0, AGENT1, STRANGER];
    let signer = signers[rng.below(5) as usize];
    let r = if rng.below(2) == 0 { Recipient::A } else { Recipient::B };
    let rogue = Destination { owner: [66; 32], mint: [67; 32], token_account: [68; 32] };
    match rng.below(12) {
        0 => { let _ = s.set_agent(&signer, rng.below(11) as u8, [rng.below(250) as u8 + 1; 32]); }
        1 => { let _ = s.set_cranker(&signer, signer); let _ = s.set_fee_program(&signer, STRANGER); }
        2 => { let _ = s.set_swap_program(&signer, if rng.below(2) == 0 { JUPITER } else { STRANGER }); }
        3 => {
            let d = match rng.below(3) { 0 => dest_a(), 1 => dest_b(), _ => rogue };
            let _ = s.set_destination(&signer, r, d);
        }
        4 => {
            let to = if rng.below(2) == 0 { BUYBACK } else { STRANGER };
            let _ = s.set_buyback_account(&signer, if rng.below(3) == 0 { STRANGER } else { BUYBACK });
            if s.release_for_buyback(&signer, rng.below(1000) + 1, *vault_free, &to).is_ok() {
                assert!(!s.salvation, "buyback released after the flip");
            }
        }
        5 => { let _ = s.ring(&signer, rng.below(3) as u8, r, rng.next(), rng.next() as i64); }
        6 => {
            *vault_free += rng.below(10_000);
            if s.allocate(*vault_free).is_ok() { *vault_free = 0; }
        }
        7 | 8 => {
            let amt = rng.below(5_000) + 1;
            let prog = if rng.below(4) == 0 { STRANGER } else { JUPITER };
            let min_out = rng.below(100) + 1;
            if s.begin_swap(&signer, r, amt, &prog, min_out).is_ok() {
                let _ = s.finish_swap(r, amt, min_out, amt, false, false, min_out + rng.below(50));
            }
        }
        _ => {
            let (acct, owner, mint) = match rng.below(4) {
                0 => (rogue.token_account, rogue.owner, rogue.mint),
                1 => (dest_a().token_account, dest_b().owner, dest_a().mint),
                _ => match s.destinations[r.idx()] { Some(d) => (d.token_account, d.owner, d.mint), None => (rogue.token_account, rogue.owner, rogue.mint) },
            };
            let on_record = s.destinations[r.idx()];
            if s.deliver(r, rng.below(200) + 1, &acct, &owner, &mint).is_ok() {
                let d = on_record.expect("delivered with no destination on record");
                assert_eq!((acct, owner, mint), (d.token_account, d.owner, d.mint), "delivered somewhere other than the destination on record");
                deliveries.push((r, acct));
            }
        }
    }
}

#[test]
fn fuzz_flip_choice_and_revocation_are_one_way_and_value_only_reaches_the_chosen_charity() {
    for seed in 1..=500u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut s = configured();
        if rng.below(2) == 0 { s.set_destination(&ADMIN, Recipient::A, dest_a()).unwrap(); }
        if rng.below(2) == 0 { s.set_destination(&ADMIN, Recipient::B, dest_b()).unwrap(); }
        let mut vault_free = 0u64;
        let mut deliveries = Vec::new();
        let (mut seen_salvation, mut seen_revoked) = (false, false);
        let mut frozen = None;
        let mut chosen_dest: Option<Destination> = None;

        for _ in 0..300 {
            random_op(&mut s, &mut rng, &mut vault_free, &mut deliveries);

            if seen_salvation { assert!(s.salvation, "seed {seed}: salvation went back to false"); }
            if seen_revoked { assert!(s.admin.is_none(), "seed {seed}: admin came back"); }
            if s.salvation {
                let snap = (s.rung_slot, s.rung_unix_timestamp, s.rung_agent_index, s.rung_agent, s.chosen, s.cranker, s.swap_program);
                match frozen {
                    None => frozen = Some(snap),
                    Some(f) => assert_eq!(f, snap, "seed {seed}: bell record, choice, cranker or swap program changed after the flip"),
                }
                if let Some(d) = s.destinations[s.chosen.idx()] {
                    match chosen_dest {
                        None => chosen_dest = Some(d),
                        Some(prev) => assert_eq!(prev, d, "seed {seed}: chosen destination changed after the flip"),
                    }
                }
                // the charity that was not chosen never accrues anything
                let other = 1 - s.chosen.idx();
                assert_eq!((s.total_credited_lamports[other], s.total_swapped_out[other], s.total_delivered[other]), (0, 0, 0), "seed {seed}: unchosen charity was credited");
            }
            seen_salvation |= s.salvation;
            seen_revoked |= s.admin.is_none();

            for i in 0..2 {
                assert_eq!(s.total_credited_lamports[i], s.pending_lamports[i] + s.total_swapped_lamports[i], "seed {seed}: SOL conservation");
                assert_eq!(s.total_swapped_out[i], s.escrow_amount[i] + s.total_delivered[i], "seed {seed}: token conservation");
            }
        }
        if !s.salvation { assert!(deliveries.is_empty(), "seed {seed}: delivered before the flip"); }
        for (r, _) in &deliveries { assert_eq!(*r, s.chosen, "seed {seed}: delivered to the charity that was not chosen"); }
    }
}

// ------------------------------------------------------------------ property 2: unroutable

#[test]
fn every_fee_after_the_flip_goes_to_the_chosen_charity() {
    let mut s = both_set();
    s.ring(&AGENT0, 0, Recipient::B, 1, 1).unwrap();
    assert_eq!(s.allocate(1_001).unwrap(), 1_001);
    assert_eq!(s.allocate(10).unwrap(), 10);
    assert_eq!(s.pending_lamports, [0, 1_011]);
    assert_eq!(s.total_credited_lamports, [0, 1_011]);
}

#[test]
fn the_charity_that_was_not_chosen_can_never_receive_anything() {
    let mut s = both_set();
    s.ring(&AGENT0, 0, Recipient::A, 1, 1).unwrap();
    s.allocate(1_000).unwrap();
    let b = dest_b();
    assert_eq!(s.begin_swap(&CRANKER, Recipient::B, 1, &JUPITER, 1), Err(RouterError::NotChosen));
    assert_eq!(s.finish_swap(Recipient::B, 0, 1, 0, false, false, 5), Err(RouterError::NotChosen));
    assert_eq!(s.deliver(Recipient::B, 1, &b.token_account, &b.owner, &b.mint), Err(RouterError::NotChosen));
}

#[test]
fn post_flip_no_buyback_even_if_admin_not_yet_revoked() {
    let mut s = configured();
    s.set_destination(&ADMIN, Recipient::A, dest_a()).unwrap();
    s.ring(&AGENT0, 0, Recipient::B, 1, 1).unwrap();
    assert!(s.admin.is_some(), "admin kept only to fill the missing destination");
    assert_eq!(s.release_for_buyback(&CRANKER, 1, 1_000_000, &BUYBACK), Err(RouterError::AlreadySalvaged));
}

#[test]
fn delivery_rejects_any_account_that_is_not_exactly_the_configured_one() {
    let mut s = both_set();
    s.ring(&AGENT0, 0, Recipient::A, 1, 1).unwrap();
    s.allocate(1_000).unwrap();
    swap(&mut s, Recipient::A, 500, 40);
    let (a, b) = (dest_a(), dest_b());
    assert_eq!(s.deliver(Recipient::A, 1, &b.token_account, &b.owner, &b.mint), Err(RouterError::WrongDestinationAccount));
    assert_eq!(s.deliver(Recipient::A, 1, &a.token_account, &STRANGER, &a.mint), Err(RouterError::WrongDestinationAccount));
    assert_eq!(s.deliver(Recipient::A, 1, &a.token_account, &a.owner, &STRANGER), Err(RouterError::WrongDestinationAccount));
    assert_eq!(s.deliver(Recipient::A, 1, &STRANGER, &a.owner, &a.mint), Err(RouterError::WrongDestinationAccount));
    assert_eq!(s.deliver(Recipient::A, 41, &a.token_account, &a.owner, &a.mint), Err(RouterError::InsufficientEscrow));
    assert_eq!(s.deliver(Recipient::A, 40, &a.token_account, &a.owner, &a.mint), Ok(1));
}

#[test]
fn swaps_only_through_the_frozen_program_only_by_the_cranker_only_up_to_what_is_credited() {
    let mut s = both_set();
    s.ring(&AGENT0, 0, Recipient::A, 1, 1).unwrap();
    s.allocate(500).unwrap();
    assert_eq!(s.begin_swap(&STRANGER, Recipient::A, 10, &JUPITER, 1), Err(RouterError::Unauthorized));
    assert_eq!(s.begin_swap(&CRANKER, Recipient::A, 10, &STRANGER, 1), Err(RouterError::SwapProgramNotAllowed));
    assert_eq!(s.begin_swap(&CRANKER, Recipient::A, 501, &JUPITER, 1), Err(RouterError::InsufficientPending));
    assert_eq!(s.begin_swap(&CRANKER, Recipient::A, 10, &JUPITER, 0), Err(RouterError::ZeroAmount), "a swap must name a minimum output");
}

#[test]
fn a_swap_that_leaks_input_or_touches_other_funds_is_rejected() {
    let mut s = both_set();
    s.ring(&AGENT0, 0, Recipient::A, 1, 1).unwrap();
    s.allocate(500).unwrap();
    s.begin_swap(&CRANKER, Recipient::A, 100, &JUPITER, 10).unwrap();
    assert_eq!(s.finish_swap(Recipient::A, 100, 10, 99, false, false, 50), Err(RouterError::SwapInputMismatch), "input left behind");
    assert_eq!(s.finish_swap(Recipient::A, 100, 10, 101, false, false, 50), Err(RouterError::SwapInputMismatch), "took more than asked");
    assert_eq!(s.finish_swap(Recipient::A, 100, 10, 100, true, false, 50), Err(RouterError::SwapTouchedOtherFunds));
    assert_eq!(s.finish_swap(Recipient::A, 100, 10, 100, false, true, 50), Err(RouterError::SwapTouchedOtherFunds));
    assert_eq!(s.finish_swap(Recipient::A, 100, 10, 100, false, false, 9), Err(RouterError::SlippageTooHigh));
    assert_eq!(s.pending_lamports[0], 500, "a rejected swap changes nothing");
}

#[test]
fn nothing_routes_before_the_flip() {
    let mut s = both_set();
    assert_eq!(s.allocate(100), Err(RouterError::NotSalvaged));
    assert_eq!(s.begin_swap(&CRANKER, Recipient::A, 1, &JUPITER, 1), Err(RouterError::NotSalvaged));
    let a = dest_a();
    assert_eq!(s.deliver(Recipient::A, 1, &a.token_account, &a.owner, &a.mint), Err(RouterError::NotSalvaged));
}

// ------------------------------------------------------------------ property 3: missing destination

#[test]
fn a_missing_chosen_destination_holds_the_funds_and_never_falls_back() {
    let mut s = configured();
    s.set_destination(&ADMIN, Recipient::A, dest_a()).unwrap();
    s.ring(&AGENT0, 0, Recipient::B, 5, 5).unwrap(); // the agent chose B, which has no destination yet

    s.allocate(2_000).unwrap();
    assert_eq!(s.pending_lamports, [0, 2_000], "all of it is held for B");
    assert_eq!(s.begin_swap(&CRANKER, Recipient::B, 100, &JUPITER, 1), Err(RouterError::DestinationUnset));
    assert_eq!(s.begin_swap(&CRANKER, Recipient::A, 100, &JUPITER, 1), Err(RouterError::NotChosen), "no fallback to A");
    let a = dest_a();
    assert_eq!(s.deliver(Recipient::B, 1, &a.token_account, &a.owner, &a.mint), Err(RouterError::DestinationUnset));
    assert_eq!(s.deliver(Recipient::A, 1, &a.token_account, &a.owner, &a.mint), Err(RouterError::NotChosen));

    // the admin may now fill B once, and cannot touch A
    assert_eq!(s.set_destination(&ADMIN, Recipient::A, Destination { owner: [70; 32], mint: [71; 32], token_account: [72; 32] }), Err(RouterError::NotChosen));
    assert_eq!(s.set_destination(&ADMIN, Recipient::B, Destination { owner: [0; 32], mint: [31; 32], token_account: [32; 32] }), Err(RouterError::MalformedDestination));
    assert_eq!(s.set_destination(&ADMIN, Recipient::B, Destination { owner: a.owner, mint: [31; 32], token_account: [32; 32] }), Err(RouterError::DuplicateDestination));
    s.set_destination(&ADMIN, Recipient::B, dest_b()).unwrap();
    assert_eq!(s.admin, None, "admin revoked the moment the chosen destination is set");
    assert_eq!(s.set_destination(&ADMIN, Recipient::B, dest_a()), Err(RouterError::AdminRevoked));

    // the held funds can now move, only to B
    swap(&mut s, Recipient::B, 2_000, 9);
    let b = dest_b();
    assert_eq!(s.deliver(Recipient::B, 9, &b.token_account, &b.owner, &b.mint), Ok(1));
}

#[test]
fn ringing_with_no_destinations_still_flips_and_holds_everything() {
    let mut s = configured();
    s.ring(&AGENT0, 0, Recipient::A, 5, 5).unwrap();
    assert!(s.salvation);
    assert!(s.admin.is_some());
    s.allocate(10).unwrap();
    assert_eq!(s.begin_swap(&CRANKER, Recipient::A, 1, &JUPITER, 1), Err(RouterError::DestinationUnset));
    assert_eq!(s.pending_lamports, [10, 0]);
}

#[test]
fn malformed_destinations_are_rejected() {
    let mut s = configured();
    let bad = [
        Destination { owner: [0; 32], mint: [1; 32], token_account: [2; 32] },
        Destination { owner: [5; 32], mint: [5; 32], token_account: [2; 32] },
        Destination { owner: [5; 32], mint: [6; 32], token_account: [5; 32] },
    ];
    for d in bad {
        assert_eq!(s.set_destination(&ADMIN, Recipient::A, d), Err(RouterError::MalformedDestination));
    }
    assert_eq!(s.set_destination(&STRANGER, Recipient::A, dest_a()), Err(RouterError::Unauthorized));
}

// ------------------------------------------------------------------ claiming and turns

#[test]
fn anyone_can_claim_but_only_through_the_frozen_fee_program() {
    let mut s = configured();
    assert_eq!(s.begin_claim(&STRANGER), Err(RouterError::FeeProgramNotAllowed));
    assert_eq!(s.begin_claim(&BAGS), Ok(()));
    let mut fresh = RouterState::new(ADMIN, CRANKER);
    assert_eq!(fresh.begin_claim(&BAGS), Err(RouterError::FeeProgramUnset));
    s.set_destination(&ADMIN, Recipient::A, dest_a()).unwrap();
    s.ring(&AGENT0, 0, Recipient::A, 1, 1).unwrap();
    assert_eq!(s.set_fee_program(&ADMIN, STRANGER), Err(RouterError::AdminRevoked));
    fresh.set_fee_program(&ADMIN, BAGS).unwrap();
}

#[test]
fn a_claim_can_only_add_to_the_router_never_take() {
    let mut s = both_set();
    assert_eq!(s.finish_claim(100, 160, 5, 5, false), Ok(60));
    assert_eq!(s.finish_claim(100, 99, 5, 5, false), Err(RouterError::ClaimTookFunds));
    assert_eq!(s.finish_claim(100, 200, 5, 4, false), Err(RouterError::ClaimTookFunds));
    assert_eq!(s.finish_claim(100, 200, 5, 5, true), Err(RouterError::ClaimTookFunds));
    assert_eq!((s.total_claimed, s.claimed_after_salvation), (60, 0));
    s.ring(&AGENT0, 0, Recipient::B, 1, 1).unwrap();
    assert_eq!(s.finish_claim(0, 40, 0, 2, false), Ok(42), "native SOL that arrives is counted too");
    assert_eq!((s.total_claimed, s.claimed_after_salvation), (102, 42));
}

#[test]
fn before_the_flip_buybacks_go_only_to_the_one_account_the_admin_set() {
    let mut s = configured();
    assert_eq!(s.release_for_buyback(&CRANKER, 10, 100, &BUYBACK), Ok(()));
    assert_eq!(s.release_for_buyback(&CRANKER, 10, 100, &STRANGER), Err(RouterError::WrongBuybackAccount));
    assert_eq!(s.release_for_buyback(&STRANGER, 10, 100, &BUYBACK), Err(RouterError::Unauthorized));
    assert_eq!(s.release_for_buyback(&ADMIN, 10, 100, &BUYBACK), Err(RouterError::Unauthorized), "even the admin goes through the cranker");
    assert_eq!(s.release_for_buyback(&CRANKER, 101, 100, &BUYBACK), Err(RouterError::InsufficientFreeBalance));
    let mut fresh = RouterState::new(ADMIN, CRANKER);
    assert_eq!(fresh.release_for_buyback(&CRANKER, 1, 100, &BUYBACK), Err(RouterError::BuybackAccountUnset));
}
