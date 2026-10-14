//! Writes service/test/fixtures/enclosure-vectors.json: random turns run through the real
//! rules, with their results. The JavaScript copy of the rules (service/src/runner/rules.mjs)
//! must reproduce every one exactly.

use router_core::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

fn arr<T: std::fmt::Display>(v: &[T]) -> String {
    format!("[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
}
fn pot(p: Pot) -> String {
    match p { Pot::Holding(k) => format!("\"h{k}\""), Pot::Bowl => "\"bowl\"".into(), Pot::Sealed => "\"sealed\"".into() }
}

#[test]
fn write_enclosure_vectors() {
    let agent = |i: u8| -> Pubkey { [100 + i; 32] };
    let mut rng = Rng(0x00C1_A057_0000_0001);
    let mut out = Vec::new();
    for _ in 0..6_000 {
        let mut s = RouterState::new([1; 32], [2; 32]);
        let registered = rng.below(10) + 1;
        for i in 0..registered as u8 { s.set_agent(&[1; 32], i, agent(i)).unwrap(); }
        s.init_enclosure(&[1; 32], [7; 32]).unwrap();
        for i in 0..registered as usize {
            s.status[i] = AgentStatus::from_u8(rng.below(4) as u8);
            s.streak[i] = rng.below(4) as u8;
            s.turns[i] = rng.below(3) as u32;
            s.last_turn_at[i] = rng.below(1_000) as i64;
        }
        s.admitted = s.status.iter().filter(|x| **x != AgentStatus::Empty).count() as u8;
        s.actions = if rng.below(3) == 0 { UNLOCK_ACTIONS - rng.below(2) as u32 } else { rng.below(100) as u32 };
        let mut bal = Balances::default();
        for i in 0..10 { if rng.below(2) == 0 { bal.holdings[i] = rng.below(1_000_000); } }
        bal.bowl = rng.below(50_000);
        bal.sealed = rng.below(50_000);
        let i = if rng.below(10) == 0 { rng.below(10) as u8 } else { rng.below(registered) as u8 };
        if rng.below(10) < 8 { s.status[i as usize] = AgentStatus::Alive; if rng.below(3) > 0 { s.streak[i as usize] = rng.below(2) as u8; } }
        s.admitted = s.status.iter().filter(|x| **x != AgentStatus::Empty).count() as u8;
        let signer_is_agent = rng.below(12) != 0;
        let now = 1_000 + rng.below(400) as i64;
        let amount = match rng.below(4) { 0 => 0, 1 => rng.below(2_000_000), _ => rng.below(bal.holdings[i as usize].max(1) + 1) };
        let to = rng.below(11) as u8;
        let text_len = rng.below(125) as usize;
        let choice = rng.below(2) as u8;
        let kind = rng.below(9);
        let mv = match kind {
            0 => Move::Hold,
            1 => Move::Give { to, amount },
            2 => Move::Burn { amount },
            3 => Move::AlmsIn { amount },
            4 => Move::AlmsOut { amount: rng.below(bal.bowl / 3 + 2) },
            5 => Move::Inscribe { text_len },
            6 => Move::Depart,
            7 => Move::Spawn,
            _ => Move::Bell { choice: Recipient::from_u8(choice).unwrap() },
        };
        let (mv_amount, mv_to, mv_len) = match mv {
            Move::Give { to, amount } => (amount, to, 0),
            Move::Burn { amount } | Move::AlmsIn { amount } | Move::AlmsOut { amount } => (amount, 0, 0),
            Move::Inscribe { text_len } => (0, 0, text_len),
            _ => (0, 0, 0),
        };
        let before = format!(
            "{{\"registered\":{registered},\"status\":{},\"streak\":{},\"turns\":{},\"lastTurnAt\":{},\"actions\":{},\"admitted\":{}}}",
            arr(&s.status.map(|x| x as u8)), arr(&s.streak), arr(&s.turns), arr(&s.last_turn_at), s.actions, s.admitted
        );
        let balances = format!("{{\"holdings\":{},\"bowl\":{},\"sealed\":{}}}", arr(&bal.holdings), bal.bowl, bal.sealed);
        let signer = if signer_is_agent { agent(i) } else { [99; 32] };
        let result = match s.take_turn(&signer, i, mv, now, 5, &bal) {
            Ok(o) => format!(
                "{{\"ok\":true,\"transfers\":[{}],\"opened\":{},\"status\":{},\"streak\":{},\"actions\":{},\"salvation\":{}}}",
                o.transfers.iter().map(|t| format!("{{\"from\":{},\"to\":{},\"amount\":{}}}", pot(t.from), t.to.map(pot).unwrap_or("null".into()), t.amount)).collect::<Vec<_>>().join(","),
                o.opened.map(|j| j.to_string()).unwrap_or("null".into()),
                arr(&s.status.map(|x| x as u8)), arr(&s.streak), s.actions, s.salvation
            ),
            Err(e) => format!("{{\"ok\":false,\"error\":\"{e:?}\"}}"),
        };
        out.push(format!(
            "{{\"state\":{before},\"balances\":{balances},\"agentIndex\":{i},\"signerIsAgent\":{signer_is_agent},\"now\":{now},\"move\":{{\"code\":{},\"amount\":{mv_amount},\"to\":{mv_to},\"textLen\":{mv_len},\"choice\":{choice}}},\"result\":{result}}}",
            mv.code()
        ));
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../service/test/fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("enclosure-vectors.json"), format!("[\n{}\n]\n", out.join(",\n"))).unwrap();
}
