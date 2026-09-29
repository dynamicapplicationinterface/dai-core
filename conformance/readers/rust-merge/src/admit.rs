// What a session document admits, computed from the tables and the headers
// alone (conformance/merge/README.md, "What a session document admits";
// docs/identity.md binding rule 5; docs/format.md, Session id and Signed twice).
//
// No view is read but `_dai_seat_rules`, a declaration of which table is seated
// by which column. Everything else here is this reader's own computation.

use crate::{hexlc, load, rowid, Table, V};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

// Why a row is or is not admitted. Only NotHeld and OtherSession are reported
// by a merge that took the row; the rest are silent.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Admitted,
    // Its (author, table, seq) was signed twice (D160): it counts nowhere.
    Equivocated,
    // Waiting on a confirmation, or its seat is void (D165): neither admitted
    // nor reported.
    Pending,
    // Names no seat, a seat someone else holds, or a version of another seat.
    NotHeld,
    // Names a version from another session.
    OtherSession,
    // After its own author's first close in the session (D151).
    Late,
}

pub struct Admission {
    // table -> (author hex, seq, deleted) of each admitted head
    pub heads: BTreeMap<String, Vec<(String, i64, i64)>>,
    pub holders: BTreeSet<(String, String, String)>,
    // (session, seat, creator)
    pub voided: BTreeSet<(String, String, String)>,
    // (author, table, seq)
    pub equivocated: BTreeSet<(String, String, i64)>,
    pub closed: BTreeSet<String>,
    // "table|author:seq" -> verdict, for every row held
    pub verdicts: BTreeMap<String, Verdict>,
    // (session, seat) -> the batch ids of the confirms that decide it
    pub confirm_batches: BTreeMap<(String, String), Vec<String>>,
}

// The session id a seat row would be the creator's row of: SHA-256 of the
// author id (16 bytes) and the seq as eight bytes big-endian, first 16 bytes
// (docs/format.md, Session id).
pub fn session_id(author: &[u8], seq: i64) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(author);
    h.update((seq as u64).to_be_bytes());
    h.finalize()[..16].to_vec()
}

fn blob(v: &V) -> Option<Vec<u8>> {
    match v {
        V::Blob(b) => Some(b.clone()),
        _ => None,
    }
}

fn int(v: &V) -> i64 {
    match v {
        V::Int(i) => *i,
        _ => 0,
    }
}

// Parents read leniently: admission reads what is held, and a held row whose
// parents are not the one shape names nothing (D159 refuses such rows at merge;
// a copy may still hold one of its own).
pub fn parents_of(v: &V) -> Vec<String> {
    match v {
        V::Text(p) => match serde_json::from_str::<serde_json::Value>(p) {
            Ok(serde_json::Value::Array(a)) => a
                .into_iter()
                .filter_map(|e| e.as_str().map(|s| s.to_lowercase()))
                .collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

// Equivocation (D160): two headers of one author listing the same
// (table, seq) with different digests. From `_dai_batch.covers`, the signed
// list; the author is the header's own.
pub fn equivocated(c: &Connection, schema: &str) -> BTreeSet<(String, String, i64)> {
    let mut out = BTreeSet::new();
    let has: i64 = c
        .query_row(
            &format!("SELECT count(*) FROM {}.sqlite_master WHERE type='table' AND name='_dai_batch'", schema),
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has == 0 {
        return out;
    }
    let mut st = c
        .prepare(&format!("SELECT author, digest, covers FROM {}._dai_batch", schema))
        .unwrap();
    let rows: Vec<(Vec<u8>, Vec<u8>, String)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    let mut digests: BTreeMap<(String, String, i64), BTreeSet<Vec<u8>>> = BTreeMap::new();
    for (author, digest, covers) in rows {
        if let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(&covers) {
            for pair in list {
                if let (Some(t), Some(s)) = (pair[0].as_str(), pair[1].as_i64()) {
                    digests
                        .entry((hexlc(&author), t.to_string(), s))
                        .or_default()
                        .insert(digest.clone());
                }
            }
        }
    }
    for (k, d) in digests {
        if d.len() > 1 {
            out.insert(k);
        }
    }
    out
}

// Which tables are seated, by which column: the `_dai_seat_rules` declaration.
fn seat_rules(c: &Connection) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Ok(mut st) = c.prepare("SELECT * FROM main._dai_seat_rules") {
        let v: Vec<(String, String)> = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        for (t, col) in v {
            out.insert(t, col);
        }
    }
    out
}

pub fn admit(c: &Connection, tables: &[Table]) -> Admission {
    let eq = equivocated(c, "main");
    let seated = seat_rules(c);
    let col = |t: &Table, k: &str| t.cols.iter().position(|x| x == k);
    let rows: BTreeMap<String, Vec<crate::Row>> =
        tables.iter().map(|t| (t.name.clone(), load(c, "main", t))).collect();
    let table = |n: &str| tables.iter().find(|t| t.name == n);
    let is_eq = |t: &Table, r: &crate::Row| {
        let a = blob(&r.vals[t.i_replica]).map(|b| hexlc(&b)).unwrap_or_default();
        eq.contains(&(a, t.name.clone(), int(&r.vals[t.i_seq])))
    };
    let hx = |v: &V| blob(v).map(|b| hexlc(&b)).unwrap_or_default();

    // The creator of each session: the author of the one `_dai_seat` row whose
    // own (author, seq) hashes to its session (D158). Her seat is hers.
    // session -> (creator, creator's seat)
    let mut creator: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut holders: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    if let (Some(t), Some(rs)) = (table("_dai_seat"), rows.get("_dai_seat")) {
        if let (Some(is), Some(iseat)) = (t.i_session, col(t, "seat")) {
            for r in rs {
                if is_eq(t, r) {
                    continue;
                }
                let (Some(a), Some(s)) = (blob(&r.vals[t.i_replica]), blob(&r.vals[is])) else { continue };
                if session_id(&a, int(&r.vals[t.i_seq])) == s {
                    let (sess, seat) = (hexlc(&s), hx(&r.vals[iseat]));
                    creator.insert(sess.clone(), (hexlc(&a), seat.clone()));
                    holders.entry((sess, seat)).or_default().insert(hexlc(&a));
                }
            }
        }
    }

    // The open seats: held by whoever the creator's confirms name. Two
    // confirms of one seat naming different holders void it (D165), whatever
    // their seqs; a confirm of the creator's own seat counts for nothing.
    let mut confirm_batches: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    if let (Some(t), Some(rs)) = (table("_dai_confirm"), rows.get("_dai_confirm")) {
        if let (Some(is), Some(iseat), Some(ih)) = (t.i_session, col(t, "seat"), col(t, "holder")) {
            for r in rs {
                if is_eq(t, r) {
                    continue;
                }
                let sess = hx(&r.vals[is]);
                let Some((cr, cseat)) = creator.get(&sess) else { continue };
                let seat = hx(&r.vals[iseat]);
                if &hx(&r.vals[t.i_replica]) != cr || &seat == cseat {
                    continue;
                }
                holders.entry((sess.clone(), seat.clone())).or_default().insert(hx(&r.vals[ih]));
                if let Some(b) = t.i_batch {
                    confirm_batches.entry((sess, seat)).or_default().push(hx(&r.vals[b]));
                }
            }
        }
    }
    let mut held: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut voided = BTreeSet::new();
    for ((sess, seat), hs) in &holders {
        if hs.len() == 1 {
            held.insert((sess.clone(), seat.clone()), hs.iter().next().unwrap().clone());
        } else {
            voided.insert((sess.clone(), seat.clone(), creator[sess].0.clone()));
        }
    }
    let members: BTreeSet<(String, String)> =
        held.iter().map(|((s, _), h)| (s.clone(), h.clone())).collect();

    // Closes (D151, D152, D153; the close rule `any`): a member's first close,
    // lowest in their own seq, binds only them. A later version or a tombstone
    // of it is another close row, never a reopening.
    let mut first_close: BTreeMap<(String, String), i64> = BTreeMap::new();
    if let (Some(t), Some(rs)) = (table("_dai_close"), rows.get("_dai_close")) {
        if let Some(is) = t.i_session {
            for r in rs {
                if is_eq(t, r) {
                    continue;
                }
                let key = (hx(&r.vals[is]), hx(&r.vals[t.i_replica]));
                if !members.contains(&key) {
                    continue;
                }
                let seq = int(&r.vals[t.i_seq]);
                let e = first_close.entry(key).or_insert(seq);
                *e = (*e).min(seq);
            }
        }
    }
    let closed: BTreeSet<String> = first_close.keys().map(|(s, _)| s.clone()).collect();

    let mut verdicts = BTreeMap::new();
    let mut heads = BTreeMap::new();
    for t in tables {
        let rs = &rows[&t.name];
        let seat_col = seated.get(&t.name).and_then(|k| col(t, k));
        let by_id: BTreeMap<String, &crate::Row> = rs.iter().map(|r| (rowid(t, r), r)).collect();
        let mut admitted: Vec<&crate::Row> = vec![];
        for r in rs {
            let v = if is_eq(t, r) {
                Verdict::Equivocated
            } else if let (Some(is), Some(ic)) = (t.i_session, seat_col) {
                let (sess, author, seat) = (hx(&r.vals[is]), hx(&r.vals[t.i_replica]), blob(&r.vals[ic]).map(|b| hexlc(&b)));
                // The versions it names, of its own entity (T1-D35: another
                // entity's row is not a version of this one).
                let mut crossing = None;
                for p in parents_of(&r.vals[t.i_parents]) {
                    if let Some(o) = by_id.get(&p) {
                        if o.vals[t.i_entity] != r.vals[t.i_entity] {
                            continue;
                        }
                        if hx(&o.vals[is]) != sess {
                            crossing = Some(Verdict::OtherSession);
                            break;
                        }
                        if blob(&o.vals[ic]).map(|b| hexlc(&b)) != seat {
                            crossing.get_or_insert(Verdict::NotHeld);
                        }
                    }
                }
                if let Some(x) = crossing {
                    x
                } else {
                    match seat {
                        None => Verdict::NotHeld,
                        Some(seat) => match held.get(&(sess.clone(), seat.clone())) {
                            Some(h) if *h == author => {
                                match first_close.get(&(sess.clone(), author.clone())) {
                                    Some(cs) if *cs < int(&r.vals[t.i_seq]) => Verdict::Late,
                                    _ => Verdict::Admitted,
                                }
                            }
                            Some(_) => Verdict::NotHeld,
                            None => Verdict::Pending,
                        },
                    }
                }
            } else {
                Verdict::Admitted
            };
            if v == Verdict::Admitted {
                admitted.push(r);
            }
            verdicts.insert(format!("{}|{}", t.name, rowid(t, r)), v);
        }
        // Heads over the admitted rows only: a row that does not count hides
        // nothing, and a parent of another entity hides nothing (T1-D35).
        let mut parented: BTreeSet<(String, String)> = BTreeSet::new();
        for r in &admitted {
            for p in parents_of(&r.vals[t.i_parents]) {
                parented.insert((r.vals[t.i_entity].enc(), p));
            }
        }
        let mut hs: Vec<(String, i64, i64)> = admitted
            .iter()
            .filter(|r| !parented.contains(&(r.vals[t.i_entity].enc(), rowid(t, r))))
            .map(|r| (hx(&r.vals[t.i_replica]), int(&r.vals[t.i_seq]), int(&r.vals[t.i_deleted])))
            .collect();
        hs.sort();
        heads.insert(t.name.clone(), hs);
    }

    Admission {
        heads,
        holders: held.into_iter().map(|((s, seat), h)| (s, seat, h)).collect(),
        voided,
        equivocated: eq,
        closed,
        verdicts,
        confirm_batches,
    }
}

// The expected-admitted-*.txt form (conformance/merge/README.md).
pub fn render(a: &Admission) -> String {
    let mut out = String::new();
    for (t, hs) in &a.heads {
        out.push_str(&format!("# {}\n", t));
        for (author, seq, deleted) in hs {
            out.push_str(&format!("{}:{}\t{}\n", author, seq, deleted));
        }
    }
    out.push_str("# holders\n");
    for (s, seat, h) in &a.holders {
        out.push_str(&format!("{}\t{}\t{}\n", s, seat, h));
    }
    out.push_str("# voided\n");
    for (s, seat, cr) in &a.voided {
        out.push_str(&format!("{}\t{}\t{}\n", s, seat, cr));
    }
    out.push_str("# equivocated\n");
    for (au, t, seq) in &a.equivocated {
        out.push_str(&format!("{}\t{}\t{}\n", au, t, seq));
    }
    out.push_str("# closed\n");
    for s in &a.closed {
        out.push_str(&format!("{}\n", s));
    }
    out
}
