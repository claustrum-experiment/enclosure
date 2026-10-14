//! Writes a serialized `Router` account so the off-chain verifier can prove it decodes
//! the real on-chain layout (service/test/verify.test.mjs reads this file).

use anchor_lang::{AccountSerialize, prelude::Pubkey};
use claustrum_router::{Dest, Router};

#[test]
fn write_router_account_fixture() {
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let mut agents = [None; 10];
    agents[0] = Some(k(10));
    agents[3] = Some(k(13));
    let r = Router {
        admin: None,
        cranker: k(2),
        swap_program: Some(k(3)),
        fee_program: Some(k(4)),
        buyback_account: Some(k(5)),
        agents,
        actions: 57,
        destinations: [None, Some(Dest { owner: k(30), mint: k(31), token_account: k(32) })],
        salvation: true,
        rung_slot: 123_456_789,
        rung_unix_timestamp: 1_800_000_000,
        rung_agent_index: 3,
        rung_agent: k(13),
        chosen: 1,
        pending_lamports: [0, 5_000_000_000],
        escrow_amount: [0, 1_234_567],
        total_credited_lamports: [0, 9_000_000_000],
        total_swapped_lamports: [0, 4_000_000_000],
        total_swapped_out: [0, 600_000_000],
        total_delivered: [0, 598_765_433],
        deliveries: 7,
        total_claimed: 21_000_000_000,
        claimed_after_salvation: 9_000_000_000,
        claustrum_mint: Some(k(6)),
        status: [3, 0, 0, 2, 0, 0, 0, 0, 0, 0],
        streak: [1, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        last_turn_at: [1_799_999_000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        turns: [40, 0, 0, 17, 0, 0, 0, 0, 0, 0],
        admitted: 2,
        total_burned: 4_444_444,
        bump: 254,
        vault_bump: 253,
    };
    let mut buf = Vec::new();
    r.try_serialize(&mut buf).unwrap();
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../service/test/fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("router-account.hex"), hex).unwrap();
}

#[test]
fn write_pda_fixture() {
    let id = claustrum_router::ID;
    let (router, rb) = Pubkey::find_program_address(&[b"router"], &id);
    let (vault, vb) = Pubkey::find_program_address(&[b"vault"], &id);
    let (escrow1, eb) = Pubkey::find_program_address(&[b"escrow", &[1u8]], &id);
    let json = format!(
        "{{\"programId\":\"{id}\",\"router\":[\"{router}\",{rb}],\"vault\":[\"{vault}\",{vb}],\"escrow1\":[\"{escrow1}\",{eb}]}}"
    );
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../service/test/fixtures");
    std::fs::write(dir.join("pdas.json"), json).unwrap();
}
