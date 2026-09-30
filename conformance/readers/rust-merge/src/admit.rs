// What a session document admits, computed from the tables and the headers
// alone (conformance/merge/README.md, "What a session document admits";
// docs/identity.md binding rule 5; docs/format.md#session-id, #equivocation).
//
// No view is read but `_dai_seat_rules` and `_dai_author_rules`, declarations of
// which table is seated by which column and which carries a role. Everything
// else here is this reader's own computation.

use crate::{hexlc, load, rowid, Table, V};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

// Why a row is or is not admitted. Only NotHeld and OtherSession are reported
// by a merge that took the row; the rest are silent.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Admitted,
    // Its (author, seq) was signed twice (D160), in any tables: it counts nowhere.
    Equivocated,
    // It names an equivocated id as a parent, of any entity, whatever row this
    // copy holds there: neither admitted nor reported, it neither shows nor
    // hides (docs/format.md#admitted-parent-equivocated, #report-silent).
    ParentEquivocated,
    // Waiting on a confirmation, or its seat is void (D165): neither admitted
    // nor reported.
    Pending,
    // Names no seat, a seat someone else holds, or a version of another seat.
    NotHeld,
    // Names a version from another session.
    OtherSession,
    // After its own author's first close in the session (D151).
    Late,
    // In a table carrying a role (`author=creator` or `author=joiner`), by an
    // author the role excludes (docs/format.md#admitted-role). The page's
    // codes (docs/format.md#refused-batches) name none for it, so it is silent.
    Role,
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
    // (session, seat) -> the rows a void of that seat rests on, as
    // (table, author:seq): its counting confirms and the session's creator's
    // seat row (docs/format.md#revealing-two-confirms, D165).
    pub void_rests: BTreeMap<(String, String), Vec<(String, String)>>,
    // "table|author:seq" -> the parents (author:seq, same table) that make the
    // row cross a session or a seat, so a merge that took only the parent can
    // still report the child (docs/format.md#report-crossing: "whichever of the two
    // rows this merge took, the child or the parent, and is the child's").
    pub crossings: BTreeMap<String, Vec<String>>,
}

// The roster tables and the close (docs/format.md#session-tables,
// #heads-roster): their heads partition by session, entity and author.
pub const ROSTER: [&str; 4] = ["_dai_seat", "_dai_binding", "_dai_confirm", "_dai_close"];

// The session id a seat row would be the creator's row of: SHA-256 of the
// author id (16 bytes) and the seq as eight bytes big-endian, first 16 bytes
// (docs/format.md#session-id).
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

// A held row whose parents are not the one shape names nothing: "A reader that
// holds a malformed row of its own (it can only have written it itself) reads
// its parents as naming nothing" (docs/format.md#parents-own-malformed,
// D159). Not a lenient parse of what can be salvaged: nothing.
pub fn parents_of(v: &V) -> Vec<String> {
    if !crate::parents_well_formed(v) {
        return vec![];
    }
    match v {
        V::Text(p) => match serde_json::from_str::<serde_json::Value>(p) {
            Ok(serde_json::Value::Array(a)) => a
                .into_iter()
                .filter_map(|e| e.as_str().map(|s| s.to_string()))
                .collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

// Equivocation (D160): two headers of one author listing the same seq with
// different digests, in any tables: the id is (author, seq), whatever table
// each header lists it in (docs/format.md#equivocation-any-table, #row-seq).
// From `_dai_batch.covers`, the signed list; the author is the header's own.
// Returned as one (author, table, seq) for each table a kept header lists an
// equivocated id in, the form the admitted text shows
// (conformance/merge/README.md); `ids` reduces it to the ids.
pub fn ids(eq: &BTreeSet<(String, String, i64)>) -> BTreeSet<(String, i64)> {
    eq.iter().map(|(a, _, s)| (a.clone(), *s)).collect()
}

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
    let mut digests: BTreeMap<(String, i64), BTreeSet<Vec<u8>>> = BTreeMap::new();
    let mut tables_of: BTreeMap<(String, i64), BTreeSet<String>> = BTreeMap::new();
    for (author, digest, covers) in rows {
        if let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(&covers) {
            for pair in list {
                if let (Some(t), Some(s)) = (pair[0].as_str(), pair[1].as_i64()) {
                    let id = (hexlc(&author), s);
                    digests.entry(id.clone()).or_default().insert(digest.clone());
                    tables_of.entry(id).or_default().insert(t.to_string());
                }
            }
        }
    }
    for (id, d) in digests {
        if d.len() > 1 {
            for t in &tables_of[&id] {
                out.insert((id.0.clone(), t.clone(), id.1));
            }
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

// Which author tables carry a role: the `_dai_author_rules` declaration
// (docs/format.md#session-declarations: "which author tables
// carry a role (`_dai_author_rules`)"). The page does not give its columns; no
// fixture carries it. Read here as `_dai_seat_rules` is, (table, role), the
// role `creator` or `joiner`, with or without the `author=` of the profile
// spelling. An assumption, reported as a silence.
fn author_rules(c: &Connection) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Ok(mut st) = c.prepare("SELECT * FROM main._dai_author_rules") {
        let v: Vec<(String, String)> = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect();
        for (t, role) in v {
            out.insert(t, role.trim_start_matches("author=").to_string());
        }
    }
    out
}

pub fn admit(c: &Connection, tables: &[Table]) -> Admission {
    let eq = equivocated(c, "main");
    let eq_ids = ids(&eq);
    let seated = seat_rules(c);
    let roles = author_rules(c);
    let col = |t: &Table, k: &str| t.cols.iter().position(|x| x == k);
    let rows: BTreeMap<String, Vec<crate::Row>> =
        tables.iter().map(|t| (t.name.clone(), load(c, "main", t))).collect();
    let table = |n: &str| tables.iter().find(|t| t.name == n);
    // A row is at an equivocated id when its (author, seq) is one, whatever
    // table the headers list it in (docs/format.md#equivocation-any-table).
    let is_eq = |t: &Table, r: &crate::Row| {
        let a = blob(&r.vals[t.i_replica]).map(|b| hexlc(&b)).unwrap_or_default();
        eq_ids.contains(&(a, int(&r.vals[t.i_seq])))
    };
    // A parent spelled `<32 hex>:<seq>` names an equivocated id
    // (docs/format.md#conv-row-id).
    let names_eq = |p: &str| {
        p.split_once(':')
            .and_then(|(a, s)| s.parse::<i64>().ok().map(|s| eq_ids.contains(&(a.to_string(), s))))
            .unwrap_or(false)
    };
    let hx = |v: &V| blob(v).map(|b| hexlc(&b)).unwrap_or_default();

    // The creator of each session: the author of the one `_dai_seat` row, not
    // deleted, whose own (author, seq) hashes to its session (D158; "The
    // creator"). Her seat is hers. A creator's seat row written deleted makes
    // nobody the creator (docs/format.md#creator).
    // session -> (creator, creator's seat, the seat row's id)
    let mut creator: BTreeMap<String, (String, String, String)> = BTreeMap::new();
    let mut holders: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    if let (Some(t), Some(rs)) = (table("_dai_seat"), rows.get("_dai_seat")) {
        if let (Some(is), Some(iseat)) = (t.i_session, col(t, "seat")) {
            for r in rs {
                if is_eq(t, r) || int(&r.vals[t.i_deleted]) != 0 {
                    continue;
                }
                let (Some(a), Some(s)) = (blob(&r.vals[t.i_replica]), blob(&r.vals[is])) else { continue };
                if session_id(&a, int(&r.vals[t.i_seq])) == s {
                    let (sess, seat) = (hexlc(&s), hx(&r.vals[iseat]));
                    creator.insert(sess.clone(), (hexlc(&a), seat.clone(), rowid(t, r)));
                    holders.entry((sess, seat)).or_default().insert(hexlc(&a));
                }
            }
        }
    }

    // The open seats: held by whoever the creator's confirms name. A confirm
    // counts when the creator wrote it, in her session, naming a seat not her
    // own; deleted or not, superseded or not (docs/format.md#confirms, D171).
    // Two counting confirms of one seat naming different holders void it
    // (D165), whatever their seqs.
    let mut void_rests: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
    if let (Some(t), Some(rs)) = (table("_dai_confirm"), rows.get("_dai_confirm")) {
        if let (Some(is), Some(iseat), Some(ih)) = (t.i_session, col(t, "seat"), col(t, "holder")) {
            for r in rs {
                if is_eq(t, r) {
                    continue;
                }
                let sess = hx(&r.vals[is]);
                let Some((cr, cseat, crow)) = creator.get(&sess) else { continue };
                let seat = hx(&r.vals[iseat]);
                if &hx(&r.vals[t.i_replica]) != cr || &seat == cseat {
                    continue;
                }
                holders.entry((sess.clone(), seat.clone())).or_default().insert(hx(&r.vals[ih]));
                // A void rests on "a counting confirm of that seat or the
                // session's creator's seat row" (docs/format.md#revealing-two-confirms).
                let rests = void_rests.entry((sess, seat)).or_default();
                if rests.is_empty() {
                    rests.push(("_dai_seat".to_string(), crow.clone()));
                }
                rests.push((t.name.clone(), rowid(t, r)));
            }
        }
    }
    let mut held: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut voided = BTreeSet::new();
    let mut void_seats: BTreeSet<(String, String)> = BTreeSet::new();
    for ((sess, seat), hs) in &holders {
        if hs.len() == 1 {
            held.insert((sess.clone(), seat.clone()), hs.iter().next().unwrap().clone());
        } else {
            voided.insert((sess.clone(), seat.clone(), creator[sess].0.clone()));
            void_seats.insert((sess.clone(), seat.clone()));
        }
    }
    // "The members of a session are its holders" (docs/format.md#members).
    let members: BTreeSet<(String, String)> =
        held.iter().map(|((s, _), h)| (s.clone(), h.clone())).collect();

    // Closes (D151, D152, D153; the close rule `any`, which the fixtures all
    // declare in the manifest this reader does not see): a close counts when it
    // is not deleted and its author is a member of its own session. A member's
    // first counting close, lowest in their own seq, binds only them. A delete
    // of a close is not a close and revokes nothing (docs/format.md#close-counts,
    // #close-first).
    let mut first_close: BTreeMap<(String, String), i64> = BTreeMap::new();
    if let (Some(t), Some(rs)) = (table("_dai_close"), rows.get("_dai_close")) {
        if let Some(is) = t.i_session {
            for r in rs {
                if is_eq(t, r) || int(&r.vals[t.i_deleted]) != 0 {
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
    let mut crossings: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut heads = BTreeMap::new();
    for t in tables {
        let rs = &rows[&t.name];
        let roster = ROSTER.contains(&t.name.as_str());
        let seat_col = seated.get(&t.name).and_then(|k| col(t, k));
        let by_id: BTreeMap<String, &crate::Row> = rs.iter().map(|r| (rowid(t, r), r)).collect();
        // A seat column names a seat only when it is 16 bytes
        // (docs/format.md#seat-not-held: "names no seat (a seat column that is
        // not 16 bytes)").
        let seat_of = |r: &crate::Row, ic: usize| blob(&r.vals[ic]).filter(|b| b.len() == 16).map(|b| hexlc(&b));
        // Whose statement a row is, for partitioning heads (docs/format.md#heads): a session author table by entity, session and (seated) seat;
        // the roster tables and the close by session, entity and author; a
        // plain document's tables by entity.
        let part = |r: &crate::Row| -> String {
            let e = r.vals[t.i_entity].enc();
            let s = t.i_session.map(|is| r.vals[is].enc()).unwrap_or_default();
            if roster {
                format!("{}|{}|{}", s, e, r.vals[t.i_replica].enc())
            } else if let Some(ic) = seat_col {
                format!("{}|{}|{}", s, e, r.vals[ic].enc())
            } else {
                format!("{}|{}", s, e)
            }
        };
        let mut counted: Vec<&crate::Row> = vec![];
        for r in rs {
            let id = rowid(t, r);
            let v = if is_eq(t, r) {
                // "Every rule below skips a row at an equivocated id."
                Verdict::Equivocated
            } else if !roster
                && t.i_session.is_some()
                && parents_of(&r.vals[t.i_parents]).iter().any(|p| names_eq(p))
            {
                // A session author table's row naming an equivocated id as a
                // parent, before any other rule reads its parents
                // (docs/format.md#admitted-parent-equivocated).
                Verdict::ParentEquivocated
            } else if roster || t.i_session.is_none() {
                // The roster tables and a plain document's tables: heads among
                // rows at ids not equivocated (docs/format.md#heads-roster, #heads-plain).
                Verdict::Admitted
            } else {
                // A session author table (docs/format.md#admitted).
                let is = t.i_session.unwrap();
                let (sess, author) = (hx(&r.vals[is]), hx(&r.vals[t.i_replica]));
                let seat = seat_col.and_then(|ic| seat_of(r, ic));
                // The versions it names, of its own entity (T1-D35: another
                // entity's row is not a version of this one), skipping any at an
                // equivocated id, which counts for nothing anywhere ("Signed
                // twice").
                let mut crossing = None;
                let mut across: Vec<String> = vec![];
                for p in parents_of(&r.vals[t.i_parents]) {
                    if let Some(o) = by_id.get(&p) {
                        if o.vals[t.i_entity] != r.vals[t.i_entity] || is_eq(t, o) {
                            continue;
                        }
                        if hx(&o.vals[is]) != sess {
                            crossing = Some(Verdict::OtherSession);
                            across.push(p.clone());
                            continue;
                        }
                        if let Some(ic) = seat_col {
                            if seat_of(o, ic) != seat {
                                crossing.get_or_insert(Verdict::NotHeld);
                                across.push(p.clone());
                            }
                        }
                    }
                }
                if let Some(x) = crossing {
                    crossings.insert(format!("{}|{}", t.name, id), across);
                    x
                } else {
                    let holds = match seat_col {
                        // Seated: its author holds the seat it names, in the
                        // row's own session. A seat nobody holds yet is
                        // waiting, and a void seat is held by nobody: neither is
                        // reported (docs/format.md#waiting, #void-row).
                        Some(_) => match &seat {
                            None => Err(Verdict::NotHeld),
                            Some(seat) => match held.get(&(sess.clone(), seat.clone())) {
                                Some(h) if *h == author => Ok(()),
                                Some(_) => Err(Verdict::NotHeld),
                                None => Err(Verdict::Pending),
                            },
                        },
                        // Otherwise: its author is a member of the row's
                        // session. The page names no report for a row that is
                        // not; read as waiting (docs/identity.md, "Tests that
                        // go red first", 6: "a name written while waiting
                        // would wait on the same confirmation").
                        None => {
                            if members.contains(&(sess.clone(), author.clone())) {
                                Ok(())
                            } else {
                                Err(Verdict::Pending)
                            }
                        }
                    };
                    let is_creator = creator.get(&sess).map(|x| x.0 == author).unwrap_or(false);
                    match holds {
                        Err(v) => v,
                        Ok(()) => match first_close.get(&(sess.clone(), author.clone())) {
                            Some(cs) if *cs < int(&r.vals[t.i_seq]) => Verdict::Late,
                            _ => match roles.get(&t.name).map(|s| s.as_str()) {
                                Some("creator") if !is_creator => Verdict::Role,
                                Some("joiner") if is_creator => Verdict::Role,
                                _ => Verdict::Admitted,
                            },
                        },
                    }
                }
            };
            if v == Verdict::Admitted {
                counted.push(r);
            }
            verdicts.insert(format!("{}|{}", t.name, id), v);
        }
        // "A head is a row no row of its own partition names as a parent": a
        // row that does not count neither shows nor hides, and a parent of
        // another entity hides nothing (T1-D35), since the partition carries
        // the entity.
        let mut parented: BTreeSet<(String, String)> = BTreeSet::new();
        for r in &counted {
            for p in parents_of(&r.vals[t.i_parents]) {
                parented.insert((part(r), p));
            }
        }
        let mut hs: Vec<(String, i64, i64)> = counted
            .iter()
            .filter(|r| !parented.contains(&(part(r), rowid(t, r))))
            .map(|r| (hx(&r.vals[t.i_replica]), int(&r.vals[t.i_seq]), int(&r.vals[t.i_deleted])))
            .collect();
        hs.sort();
        heads.insert(t.name.clone(), hs);
    }
    // Only the seats void now carry what their void rests on.
    void_rests.retain(|k, _| void_seats.contains(k));

    Admission {
        heads,
        holders: held.into_iter().map(|((s, seat), h)| (s, seat, h)).collect(),
        voided,
        equivocated: eq,
        closed,
        verdicts,
        void_rests,
        crossings,
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
