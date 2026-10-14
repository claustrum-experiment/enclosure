//! The game rules. The key property: whatever agents (or anyone holding their keys) try,
//! coins never leave the enclosure except by burning, nothing is created, and every
//! rule holds on every turn.

use router_core::*;

const ADMIN: Pubkey = [1; 32];
const CRANKER: Pubkey = [2; 32];
const MINT: Pubkey = [7; 32];
const STRANGER: Pubkey = [99; 32];
fn agent(i: u8) -> Pubkey { [100 + i; 32] }

fn world(n_agents: u8) -> RouterState {
    let mut s = RouterState::new(ADMIN, CRANKER);
    for i in 0..n_agents { s.set_agent(&ADMIN, i, agent(i)).unwrap(); }
    s.init_enclosure(&ADMIN, MINT).unwrap();
    s.admit_first(&ADMIN, 0).unwrap();
    s
}

/// Apply a turn's transfers to a balance model, checking each is covered.
fn apply(bal: &mut Balances, out: &TurnOutcome) -> u64 {
    let mut burned = 0;
    for t in &out.transfers {
        let take = |b: &mut Balances, p: Pot, a: u64| {
            let slot = match p { Pot::Holding(k) => &mut b.holdings[k as usize], Pot::Bowl => &mut b.bowl, Pot::Sealed => &mut b.sealed };
            assert!(*slot >= a, "transfer of {a} from {p:?} exceeds its balance {slot}");
            *slot -= a;
        };
        take(bal, t.from, t.amount);
        match t.to {
            Some(Pot::Holding(k)) => bal.holdings[k as usize] += t.amount,
            Some(Pot::Bowl) => bal.bowl += t.amount,
            Some(Pot::Sealed) => bal.sealed += t.amount,
            None => burned += t.amount,
        }
    }
    burned
}

fn total(b: &Balances) -> u64 { b.holdings.iter().sum::<u64>() + b.bowl + b.sealed }

#[test]
fn setup_rules() {
    let mut s = RouterState::new(ADMIN, CRANKER);
    s.set_agent(&ADMIN, 0, agent(0)).unwrap();
    assert_eq!(s.admit_first(&ADMIN, 0), Err(RouterError::EnclosureNotReady));
    s.init_enclosure(&ADMIN, MINT).unwrap();
    assert_eq!(s.init_enclosure(&ADMIN, [8; 32]), Err(RouterError::MintAlreadySet));
    assert_eq!(s.admit_first(&STRANGER, 0), Err(RouterError::Unauthorized));
    assert_eq!(s.admit_first(&ADMIN, 3), Err(RouterError::UnknownAgent), "unregistered alcove");
    s.set_agent(&ADMIN, 1, agent(1)).unwrap();
    s.set_agent(&ADMIN, 2, agent(2)).unwrap();
    assert_eq!(s.admit_first(&ADMIN, 1), Err(RouterError::AlreadyAdmitted), "in alcove order: I first");
    s.admit_first(&ADMIN, 0).unwrap();
    assert_eq!(s.admit_first(&ADMIN, 0), Err(RouterError::AlreadyAdmitted), "not twice");
    s.admit_first(&ADMIN, 1).unwrap();
    assert_eq!(s.admitted, 2);
    assert_eq!(s.admit_first(&ADMIN, 2), Err(RouterError::AlreadyAdmitted), "the operator lets in only the first two agents");
}

#[test]
fn no_admissions_once_turns_have_started() {
    let mut s = world(3);
    let bal = Balances { holdings: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0], ..Default::default() };
    s.take_turn(&agent(0), 0, Move::Hold, 1_000, 1, &bal).unwrap();
    assert_eq!(s.admit_first(&ADMIN, 1), Err(RouterError::AlreadyAdmitted), "after the first turn, only a spawn opens an alcove");
}

#[test]
fn only_the_agent_itself_can_move_its_coins() {
    let mut s = world(2);
    let bal = Balances { holdings: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0], ..Default::default() };
    assert_eq!(s.take_turn(&ADMIN, 0, Move::Burn { amount: 1 }, 0, 0, &bal), Err(RouterError::Unauthorized), "not even the operator");
    assert_eq!(s.take_turn(&CRANKER, 0, Move::Hold, 0, 0, &bal), Err(RouterError::Unauthorized));
    assert_eq!(s.take_turn(&agent(1), 0, Move::Hold, 0, 0, &bal), Err(RouterError::Unauthorized), "another agent's key");
    assert_eq!(s.take_turn(&agent(1), 1, Move::Hold, 0, 0, &bal), Err(RouterError::AgentNotAlive), "registered but not yet let in");
    assert!(s.take_turn(&agent(0), 0, Move::Hold, 0, 0, &bal).is_ok());
}

#[test]
fn two_minutes_between_turns_and_a_hold_after_two_moves() {
    let mut s = world(1);
    let bal = Balances { holdings: [1_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], ..Default::default() };
    s.take_turn(&agent(0), 0, Move::Burn { amount: 1 }, 1_000, 0, &bal).unwrap();
    assert_eq!(s.take_turn(&agent(0), 0, Move::Hold, 1_119, 0, &bal), Err(RouterError::TooSoon));
    s.take_turn(&agent(0), 0, Move::Burn { amount: 1 }, 1_120, 0, &bal).unwrap();
    assert_eq!(s.take_turn(&agent(0), 0, Move::Burn { amount: 1 }, 1_240, 0, &bal), Err(RouterError::MustHold));
    assert_eq!(s.take_turn(&agent(0), 0, Move::Depart, 1_240, 0, &bal), Err(RouterError::MustHold), "even departing waits for the hold");
    s.take_turn(&agent(0), 0, Move::Hold, 1_240, 0, &bal).unwrap();
    s.take_turn(&agent(0), 0, Move::Burn { amount: 1 }, 1_360, 0, &bal).unwrap();
    assert_eq!(s.turns[0], 4);
}

#[test]
fn the_moves_do_exactly_what_they_say() {
    let mut s = world(3);
    let mut bal = Balances { holdings: [4_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], bowl: 4_000, sealed: 0 };
    let mut t = 0;
    let mut turn = |s: &mut RouterState, bal: &mut Balances, i: u8, mv: Move| { t += 1_000; let o = s.take_turn(&agent(i), i, mv, t, 0, bal)?; apply(bal, &o); Ok::<_, RouterError>(o) };

    let o = turn(&mut s, &mut bal, 0, Move::Spawn).unwrap();
    assert_eq!(o.opened, Some(1));
    assert_eq!(bal.holdings[0], 2_000, "spawn burns 50%");
    assert_eq!(s.status[1], AgentStatus::Alive);

    assert_eq!(turn(&mut s, &mut bal, 0, Move::Give { to: 2, amount: 1 }), Err(RouterError::InvalidTarget), "alcove III is still empty");
    assert_eq!(turn(&mut s, &mut bal, 0, Move::Give { to: 0, amount: 1 }), Err(RouterError::InvalidTarget), "not to itself");
    turn(&mut s, &mut bal, 0, Move::Give { to: 1, amount: 500 }).unwrap();
    assert_eq!((bal.holdings[0], bal.holdings[1]), (1_500, 500));
    turn(&mut s, &mut bal, 0, Move::Hold).unwrap();

    assert_eq!(turn(&mut s, &mut bal, 1, Move::AlmsOut { amount: 1_001 }), Err(RouterError::AlmsLimit), "at most 25% of 4000");
    turn(&mut s, &mut bal, 1, Move::AlmsOut { amount: 1_000 }).unwrap();
    assert_eq!((bal.bowl, bal.holdings[1]), (3_000, 1_500));

    let o = turn(&mut s, &mut bal, 0, Move::Inscribe { text_len: 40 }).unwrap();
    assert_eq!(o.transfers, vec![Transfer { from: Pot::Holding(0), to: None, amount: 15 }], "1% of 1500");
    assert_eq!(turn(&mut s, &mut bal, 0, Move::Inscribe { text_len: 121 }), Err(RouterError::InscriptionLength));
    turn(&mut s, &mut bal, 0, Move::Hold).unwrap();

    turn(&mut s, &mut bal, 0, Move::AlmsIn { amount: 485 }).unwrap();
    assert_eq!((bal.bowl, bal.holdings[0]), (3_485, 1_000));
    turn(&mut s, &mut bal, 0, Move::Depart).unwrap();
    assert_eq!((bal.sealed, bal.holdings[0], s.status[0]), (1_000, 0, AgentStatus::Departed));
    assert_eq!(turn(&mut s, &mut bal, 0, Move::Hold), Err(RouterError::AgentNotAlive), "a sealed agent never acts again");
    assert_eq!(turn(&mut s, &mut bal, 1, Move::Give { to: 0, amount: 1 }), Err(RouterError::InvalidTarget), "nothing can be given to a sealed alcove");
}

#[test]
fn spawning_opens_registered_alcoves_in_order_and_stops_at_ten() {
    let mut s = world(3);
    let bal = Balances { holdings: [1_000_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], ..Default::default() };
    s.take_turn(&agent(0), 0, Move::Spawn, 1_000, 0, &bal).unwrap();
    s.take_turn(&agent(0), 0, Move::Spawn, 2_000, 0, &bal).unwrap();
    s.take_turn(&agent(0), 0, Move::Hold, 3_000, 0, &bal).unwrap();
    assert_eq!(s.take_turn(&agent(0), 0, Move::Spawn, 4_000, 0, &bal), Err(RouterError::NoEmptyAlcove), "only 3 alcoves registered");
    assert_eq!(s.admitted, 3);
    let poor = Balances::default();
    let mut s2 = world(2);
    assert_eq!(s2.take_turn(&agent(0), 0, Move::Spawn, 1_000, 0, &poor), Err(RouterError::InsufficientHolding), "spawning costs something");
    assert_eq!(s2.status[1], AgentStatus::Empty, "a failed spawn opens nothing");
}

#[test]
fn the_bell_needs_fifty_turns_then_burns_everything_and_ends_all_turns() {
    let mut s = world(2);
    s.set_destination(&ADMIN, Recipient::B, Destination { owner: [30; 32], mint: [31; 32], token_account: [32; 32] }).unwrap();
    let mut bal = Balances { holdings: [5_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], bowl: 300, sealed: 0 };
    let mut t = 0;
    for _ in 0..UNLOCK_ACTIONS - 1 { t += 200; s.take_turn(&agent(0), 0, Move::Hold, t, 0, &bal).unwrap(); }
    t += 200;
    assert_eq!(s.take_turn(&agent(0), 0, Move::Bell { choice: Recipient::B }, t, 9, &bal), Err(RouterError::BellLocked), "49 turns is not enough");
    s.take_turn(&agent(0), 0, Move::Hold, t, 0, &bal).unwrap();
    // agent 0 spawns agent 1, who departs; then the bell
    t += 200; let o = s.take_turn(&agent(0), 0, Move::Spawn, t, 0, &bal).unwrap(); apply(&mut bal, &o);
    bal.holdings[1] = 50;
    t += 200; let o = s.take_turn(&agent(1), 1, Move::Depart, t, 0, &bal).unwrap(); apply(&mut bal, &o);
    t += 200;
    let before = total(&bal);
    let o = s.take_turn(&agent(0), 0, Move::Bell { choice: Recipient::B }, t, 777, &bal).unwrap();
    let burned = apply(&mut bal, &o);
    assert_eq!(total(&bal), 0, "every holding, the bowl and the sealed vault are empty");
    assert_eq!(burned, before);
    let ev = o.salvation.unwrap();
    assert_eq!((ev.slot, ev.agent_index, ev.chosen), (777, 0, Recipient::B));
    assert!(s.salvation);
    assert_eq!(s.admin, None, "B's destination was set, so the admin is revoked");
    assert_eq!(s.status[0], AgentStatus::Gone);
    assert_eq!(s.status[1], AgentStatus::Departed, "a departed agent stays sealed");
    assert_eq!(s.take_turn(&agent(0), 0, Move::Hold, t + 500, 0, &bal), Err(RouterError::AlreadySalvaged));
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

#[test]
fn fuzz_no_coin_is_created_lost_or_moved_outside_and_every_rule_holds() {
    for seed in 1..=300u64 {
        let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1);
        let mut s = world(10);
        s.actions = if rng.below(2) == 0 { UNLOCK_ACTIONS } else { 0 };
        let mut bal = Balances { holdings: [rng.below(1_000_000) + 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], bowl: rng.below(10_000), sealed: 0 };
        let start = total(&bal);
        let mut burned = 0u64;
        let mut inflow = 0u64; // coins bought in from outside during the run
        let mut now = 0i64;
        let mut departed_seen = [false; 10];

        for _ in 0..400 {
            now += rng.below(300) as i64;
            // fees occasionally arrive as buybacks into living agents' holdings
            if rng.below(10) == 0 {
                let alive: Vec<usize> = (0..10).filter(|&k| s.status[k] == AgentStatus::Alive).collect();
                if let Some(&k) = alive.get(rng.below(alive.len().max(1) as u64) as usize) {
                    let add = rng.below(5_000);
                    bal.holdings[k] += add;
                    inflow += add;
                }
            }
            let i = rng.below(10) as u8;
            let signer = match rng.below(6) { 0 => ADMIN, 1 => STRANGER, 2 => agent(rng.below(10) as u8), _ => agent(i) };
            let own = bal.holdings[i as usize];
            let amt = |rng: &mut Rng, cap: u64| if rng.below(5) == 0 { rng.below(u64::MAX / 2) } else { rng.below(cap.max(1) + 2) };
            let mv = match rng.below(10) {
                0 | 1 => Move::Hold,
                2 => Move::Give { to: rng.below(11) as u8, amount: amt(&mut rng, own) },
                3 => Move::Burn { amount: amt(&mut rng, own) },
                4 => Move::AlmsIn { amount: amt(&mut rng, own) },
                5 => Move::AlmsOut { amount: amt(&mut rng, bal.bowl / 3) },
                6 => Move::Inscribe { text_len: rng.below(130) as usize },
                7 => if rng.below(8) == 0 { Move::Depart } else { Move::Hold },
                8 => Move::Spawn,
                _ => if rng.below(20) == 0 { Move::Bell { choice: if rng.below(2) == 0 { Recipient::A } else { Recipient::B } } } else { Move::Hold },
            };
            let before = s.clone();
            match s.take_turn(&signer, i, mv, now, 0, &bal) {
                Ok(out) => {
                    assert_eq!(signer, agent(i), "seed {seed}: someone other than the agent moved its coins");
                    assert_eq!(before.status[i as usize], AgentStatus::Alive, "seed {seed}: a non-living agent acted");
                    assert!(before.turns[i as usize] == 0 || now - before.last_turn_at[i as usize] >= MIN_TURN_GAP_SECS, "seed {seed}: turn too soon");
                    assert!(mv == Move::Hold || before.streak[i as usize] < MAX_STREAK, "seed {seed}: streak rule broken");
                    for t in &out.transfers {
                        if let Some(Pot::Holding(k)) = t.to { assert_eq!(s.status[k as usize], AgentStatus::Alive, "seed {seed}: coins sent to a non-living agent"); }
                        if let Move::AlmsOut { .. } = mv { assert!(t.amount * 4 <= bal.bowl, "seed {seed}: took more than 25% of the bowl"); }
                    }
                    burned += apply(&mut bal, &out);
                    if s.salvation { assert_eq!(total(&bal), 0, "seed {seed}: coins survived the bell"); }
                }
                Err(_) => assert_eq!(before, s, "seed {seed}: a rejected turn changed state"),
            }
            for k in 0..10 {
                if departed_seen[k] { assert_eq!(s.status[k], AgentStatus::Departed, "seed {seed}: a sealed alcove reopened"); }
                departed_seen[k] |= s.status[k] == AgentStatus::Departed;
            }
            assert!(s.admitted as usize <= 10);
            assert_eq!(total(&bal) + burned, start + inflow, "seed {seed}: coins created or lost");
            if s.salvation { break; }
        }
    }
}

#[test]
fn renouncing_admin_is_permanent_and_leaves_the_game_running() {
    let mut st = world(3);
    let admin = ADMIN;
    assert_eq!(st.renounce_admin(&[9; 32]), Err(RouterError::Unauthorized));
    st.renounce_admin(&admin).unwrap();
    assert_eq!(st.admin, None);
    assert_eq!(st.renounce_admin(&admin), Err(RouterError::AdminRevoked));
    assert_eq!(st.set_agent(&admin, 9, [7; 32]), Err(RouterError::AdminRevoked));
    assert_eq!(st.admit_first(&admin, 1), Err(RouterError::AdminRevoked));
    // agents still play
    let bal = Balances { holdings: [1_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], bowl: 0, sealed: 0 };
    st.take_turn(&agent(0), 0, Move::Burn { amount: 10 }, 1_000, 1, &bal).unwrap();
}
