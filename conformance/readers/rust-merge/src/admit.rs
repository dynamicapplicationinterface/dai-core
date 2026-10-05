// What a session document admits, computed from the tables and the headers
// alone (conformance/merge/README.md, "What a session document admits";
// docs/format.md, "Session admission").
//
// No view is read but `_dai_seat_rules` and `_dai_author_rules`, declarations of
// which table is seated by which column and which carries a role, and
// `max_parties` comes from the signed manifest (manifest.json;
// docs/format.md#session-declarations, #fixtures-manifest). Everything else
// here is this reader's own computation.

use crate::{hexlc, load, rowid, Row, Table, V};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

// Why a row is or is not admitted. Only NotHeld and OtherSession are reported
// by a merge that took the row (or released it from waiting on a parent); the
// rest are silent.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Admitted,
    // Its (author, seq) was signed twice, in any tables: it counts nowhere
    // (docs/format.md#equivocated-counts-nothing).
    Equivocated,
    // It names an equivocated id as a parent, of any entity, whatever row this
    // copy holds there: neither admitted nor reported, it neither shows nor
    // hides (docs/format.md#admitted-parent-equivocated, #report-silent).
    ParentEquivocated,
    // It names as a parent an id at which the copy holds no row, in any table:
    // neither admitted nor reported (docs/format.md#waiting-on-parent).
    WaitingParent,
    // Waiting on a confirmation, or its seat is void: neither admitted nor
    // reported (docs/format.md#waiting, #void-row).
    Pending,
    // Names no seat value, a seat its author does not hold, or a version of
    // another seat (docs/format.md#seat-not-held).
    NotHeld,
    // Names a version from another session (docs/format.md#entity-other-session).
    OtherSession,
    // In a table carrying a role, by an author the role excludes
    // (docs/format.md#admitted-role). The page's codes name none for it, so it
    // is silent.
    Role,
    // A roster row that counts for nothing: by an equivocator, or a `_dai_seat`
    // row that is not a creator's seat row (docs/format.md#equivocator,
    // #creator-row-immutable).
    Nothing,
    // By an equivocator, in a session author table: none of his rows is
    // admitted or reported but as his signing twice
    // (docs/format.md#equivocator-holds-nothing).
    Equivocator,
    // In a session that is not live (docs/format.md#session-void).
    VoidSession,
}

pub struct Admission {
    // table -> (author hex, seq, deleted) of each head
    pub heads: BTreeMap<String, Vec<(String, i64, i64)>>,
    // (session, seat, holder)
    pub holders: BTreeSet<(String, String, String)>,
    // (session, seat, creator): every void open seat, for either reason
    pub voided: BTreeSet<(String, String, String)>,
    // (session, seat) whose counting confirms name two or more holders: the
    // void that reveals its creator (docs/format.md#revealing-two-confirms)
    pub void_two: BTreeSet<(String, String)>,
    // (author, table, seq)
    pub equivocated: BTreeSet<(String, String, i64)>,
    pub closed: BTreeSet<String>,
    // "table|author:seq" -> verdict, for every row of a session author table
    pub verdicts: BTreeMap<String, Verdict>,
    // (session, seat value) -> the rows a void of that seat rests on, as
    // (table, author:seq): its counting confirms and the session's creator's
    // seat row (docs/format.md#void-rests-on).
    pub void_rests: BTreeMap<(String, String), Vec<(String, String)>>,
    // "table|author:seq" -> the parents (author:seq, same table) that make the
    // row cross a session or a seat (docs/format.md#report-crossing).
    pub crossings: BTreeMap<String, Vec<String>>,
    // author -> session -> the seq of his lowest close there that counts,
    // for each author with a close that counts and a row of his in that
    // session at a higher seq (docs/format.md#close-monotone).
    pub close_after: BTreeMap<String, BTreeMap<String, i64>>,
}

// The roster tables and the close (docs/format.md#session-tables,
// #heads-roster): their heads partition by session, entity and author.
pub const ROSTER: [&str; 4] = ["_dai_seat", "_dai_binding", "_dai_confirm", "_dai_close"];

// Canonical CBOR of one column value as SQLite holds it
// (docs/format.md#cbor): integers in the shortest form, a REAL as a float64,
// text as UTF-8, bytes as a byte string, NULL as null.
fn cbor_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n < 1 << 8 {
        out.push(m | 24);
        out.push(n as u8);
    } else if n < 1 << 16 {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n < 1 << 32 {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

fn cbor_value(out: &mut Vec<u8>, v: &V) {
    match v {
        V::Null => out.push(0xf6),
        V::Int(i) if *i >= 0 => cbor_head(out, 0, *i as u64),
        V::Int(i) => cbor_head(out, 1, (-1 - *i) as u64),
        V::Real(f) => {
            out.push(0xfb);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        V::Text(t) => {
            cbor_head(out, 3, t.len() as u64);
            out.extend_from_slice(t.as_bytes());
        }
        V::Blob(b) => {
            cbor_head(out, 2, b.len() as u64);
            out.extend_from_slice(b);
        }
    }
}

// The session id a seat row would be the creator's seat row of: SHA-256 of
// the author id (16 bytes), the seq as eight bytes big-endian, and the
// canonical CBOR of [seat, seats, close] as the row holds them; the first 16
// bytes (docs/format.md#session-id, #session-id-roster).
pub fn session_id(author: &[u8], seq: i64, roster: [&V; 3]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(author);
    h.update((seq as u64).to_be_bytes());
    let mut c = vec![0x83];
    for v in roster {
        cbor_value(&mut c, v);
    }
    h.update(&c);
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

// A seat value is a byte string of exactly 16 bytes; anything else names no
// seat (docs/format.md#seat-value-shape).
fn seat_value(v: &V) -> Option<String> {
    blob(v).filter(|b| b.len() == 16).map(|b| hexlc(&b))
}

// A row's parents. A held row whose parents are not the one shape, a forward
// parent included, names nothing (docs/format.md#parents-own-malformed,
// #parent-forward). Not a lenient parse of what can be salvaged: nothing.
pub fn parents_of(t: &Table, r: &Row) -> Vec<String> {
    if !crate::parents_ok(t, r) {
        return vec![];
    }
    match &r.vals[t.i_parents] {
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

pub fn ids(eq: &BTreeSet<(String, String, i64)>) -> BTreeSet<(String, i64)> {
    eq.iter().map(|(a, _, s)| (a.clone(), *s)).collect()
}

// Equivocation: two headers of one author listing the same seq with different
// digests, in any tables (docs/format.md#equivocation, #equivocation-any-table,
// #equivocation-own-headers). From `_dai_batch.covers`, the signed list; the
// author is the header's own. Returned as one (author, table, seq) for each
// table a kept header lists an equivocated id in, the form the admitted text
// shows (conformance/merge/README.md); `ids` reduces it to the ids.
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
// (docs/format.md#session-declarations). The page does not give its columns;
// no fixture carries it. Read here as `_dai_seat_rules` is, (table, role), the
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

// A session's creator's seat row, as the roster rules read it.
struct CreatorRow {
    author: String,
    id: String,
    deleted: bool,
    valid: bool,
    seat: String,
    seats: Vec<String>,
    close_any: bool,
}

// The roster as it stands for one set of equivocators: who holds what, what is
// void, and which closes count.
struct Roster {
    live: BTreeSet<String>,
    // (session, seat) -> holder
    held: BTreeMap<(String, String), String>,
    // (session, seat) void, for either reason
    void: BTreeSet<(String, String)>,
    void_two: BTreeSet<(String, String)>,
    void_rests: BTreeMap<(String, String), Vec<(String, String)>>,
    // (session, author, seq) of each close that counts, its author's
    // equivocation not read (docs/format.md#close-counts)
    closes: Vec<(String, String, i64)>,
}

pub fn admit(c: &Connection, tables: &[Table], max_parties: usize) -> Admission {
    let eq = equivocated(c, "main");
    let eq_ids = ids(&eq);
    let seated = seat_rules(c);
    let roles = author_rules(c);
    let col = |t: &Table, k: &str| t.cols.iter().position(|x| x == k);
    let rows: BTreeMap<String, Vec<Row>> = tables.iter().map(|t| (t.name.clone(), load(c, "main", t))).collect();
    let table = |n: &str| tables.iter().find(|t| t.name == n);
    let hx = |v: &V| blob(v).map(|b| hexlc(&b)).unwrap_or_default();
    // A row is at an equivocated id when its (author, seq) is one, whatever
    // table the headers list it in (docs/format.md#equivocation-any-table).
    let is_eq = |t: &Table, r: &Row| eq_ids.contains(&(hx(&r.vals[t.i_replica]), int(&r.vals[t.i_seq])));
    // A parent spelled `<32 hex>:<seq>` names an equivocated id
    // (docs/format.md#conv-row-id).
    let names_eq = |p: &str| {
        p.split_once(':')
            .and_then(|(a, s)| s.parse::<i64>().ok().map(|s| eq_ids.contains(&(a.to_string(), s))))
            .unwrap_or(false)
    };
    // Every id the copy holds a row at, in any table
    // (docs/format.md#waiting-on-parent).
    let held_ids: BTreeSet<String> =
        tables.iter().flat_map(|t| rows[&t.name].iter().map(move |r| rowid(t, r))).collect();

    // The creators' seat rows: each `_dai_seat` row, deleted or not, whose own
    // author, seq and roster hash to its `_r_session`
    // (docs/format.md#creator, #session-id-creator-row).
    let mut creator_rows: BTreeMap<String, CreatorRow> = BTreeMap::new();
    let mut creator_ids: BTreeSet<String> = BTreeSet::new();
    if let (Some(t), Some(rs)) = (table("_dai_seat"), rows.get("_dai_seat")) {
        if let (Some(is), Some(iseat), Some(iseats), Some(iclose)) =
            (t.i_session, col(t, "seat"), col(t, "seats"), col(t, "close"))
        {
            for r in rs {
                let (Some(a), Some(s)) = (blob(&r.vals[t.i_replica]), blob(&r.vals[is])) else { continue };
                let sid = session_id(&a, int(&r.vals[t.i_seq]), [&r.vals[iseat], &r.vals[iseats], &r.vals[iclose]]);
                if sid != s {
                    continue;
                }
                // The roster is valid when `seat` is 16 bytes, `seats` a byte
                // string of whole 16-byte values, distinct and none `seat`, one
                // plus their number at most max_parties, and `close` is `any`
                // or `creator` (docs/format.md#roster-declared).
                let seat = seat_value(&r.vals[iseat]);
                let mut seats: Vec<String> = vec![];
                let mut valid = seat.is_some();
                match &r.vals[iseats] {
                    V::Blob(b) if b.len() % 16 == 0 => {
                        for ch in b.chunks(16) {
                            let v = hexlc(ch);
                            if seats.contains(&v) || Some(&v) == seat.as_ref() {
                                valid = false;
                            }
                            seats.push(v);
                        }
                    }
                    _ => valid = false,
                }
                if 1 + seats.len() > max_parties {
                    valid = false;
                }
                let close_any = match &r.vals[iclose] {
                    V::Text(x) if x == "any" => true,
                    V::Text(x) if x == "creator" => false,
                    _ => {
                        valid = false;
                        false
                    }
                };
                creator_ids.insert(format!("_dai_seat|{}", rowid(t, r)));
                creator_rows.insert(
                    hexlc(&s),
                    CreatorRow {
                        author: hexlc(&a),
                        id: rowid(t, r),
                        deleted: int(&r.vals[t.i_deleted]) != 0,
                        valid,
                        seat: seat.unwrap_or_default(),
                        seats,
                        close_any,
                    },
                );
            }
        }
    }

    // The roster for a set of equivocators.
    let roster_for = |equivocators: &BTreeSet<String>| -> Roster {
        // A session is live when its creator's seat row is held, not deleted,
        // declares a valid roster and is by no equivocator; a creator's seat
        // row at an equivocated id is by an equivocator (docs/format.md#creator,
        // #session-void).
        let live: BTreeSet<String> = creator_rows
            .iter()
            .filter(|(_, cr)| !cr.deleted && cr.valid && !equivocators.contains(&cr.author))
            .map(|(s, _)| s.clone())
            .collect();
        // Counting confirms: by the session's creator, in her live session,
        // naming a value her creator's seat row's `seats` holds; at any seq,
        // deleted or not, superseded or not (docs/format.md#confirms). Every
        // rule skips a row at an equivocated id.
        let mut named: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        let mut rests: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
        if let (Some(t), Some(rs)) = (table("_dai_confirm"), rows.get("_dai_confirm")) {
            if let (Some(is), Some(iseat), Some(ih)) = (t.i_session, col(t, "seat"), col(t, "holder")) {
                for r in rs {
                    if is_eq(t, r) {
                        continue;
                    }
                    let sess = hx(&r.vals[is]);
                    if !live.contains(&sess) {
                        continue;
                    }
                    let cr = &creator_rows[&sess];
                    if hx(&r.vals[t.i_replica]) != cr.author {
                        continue;
                    }
                    let Some(value) = seat_value(&r.vals[iseat]) else { continue };
                    if !cr.seats.contains(&value) {
                        continue;
                    }
                    let k = (sess.clone(), value);
                    named.entry(k.clone()).or_default().insert(hx(&r.vals[ih]));
                    let rs = rests.entry(k).or_default();
                    if rs.is_empty() {
                        rs.push(("_dai_seat".to_string(), cr.id.clone()));
                    }
                    rs.push((t.name.clone(), rowid(t, r)));
                }
            }
        }
        // Holders: the creator holds her seat; an open seat whose counting
        // confirms name one holder, no equivocator, is his; two or more, or an
        // equivocator, and it is void (docs/format.md#holders, #void).
        let mut held = BTreeMap::new();
        let mut void = BTreeSet::new();
        let mut void_two = BTreeSet::new();
        let mut void_rests = BTreeMap::new();
        for s in &live {
            let cr = &creator_rows[s];
            held.insert((s.clone(), cr.seat.clone()), cr.author.clone());
        }
        for (k, hs) in &named {
            if hs.len() > 1 {
                void_two.insert(k.clone());
            }
            if hs.len() > 1 || hs.iter().any(|h| equivocators.contains(h)) {
                void.insert(k.clone());
                void_rests.insert(k.clone(), rests[k].clone());
            } else {
                held.insert(k.clone(), hs.iter().next().unwrap().clone());
            }
        }
        // Closes that count: not deleted, in a live session, by an author the
        // close rule permits (docs/format.md#close-counts).
        let mut closes = vec![];
        if let (Some(t), Some(rs)) = (table("_dai_close"), rows.get("_dai_close")) {
            if let Some(is) = t.i_session {
                for r in rs {
                    if is_eq(t, r) || int(&r.vals[t.i_deleted]) != 0 {
                        continue;
                    }
                    let sess = hx(&r.vals[is]);
                    if !live.contains(&sess) {
                        continue;
                    }
                    let cr = &creator_rows[&sess];
                    let a = hx(&r.vals[t.i_replica]);
                    let permitted = a == cr.author
                        || (cr.close_any && held.iter().any(|((s, _), h)| *s == sess && *h == a));
                    if permitted {
                        closes.push((sess, a, int(&r.vals[t.i_seq])));
                    }
                }
            }
        }
        Roster { live, held, void, void_two, void_rests, closes }
    };

    // Equivocators: authors with two headers at one id anywhere in the
    // document, and authors with a close that counts and a row of theirs in
    // that session at a higher seq (docs/format.md#equivocator,
    // #close-monotone). Whether a close counts does not read its author's
    // own equivocation; only fewer things count as the set grows, so one pass
    // over the header equivocators finds them all.
    let e0: BTreeSet<String> = eq_ids.iter().map(|(a, _)| a.clone()).collect();
    let r0 = roster_for(&e0);
    // (session, author) -> the highest seq of any row of his in that session,
    // in any table, at an id not equivocated
    let mut top: BTreeMap<(String, String), i64> = BTreeMap::new();
    for t in tables {
        let Some(is) = t.i_session else { continue };
        for r in &rows[&t.name] {
            if is_eq(t, r) {
                continue;
            }
            let k = (hx(&r.vals[is]), hx(&r.vals[t.i_replica]));
            let s = int(&r.vals[t.i_seq]);
            let e = top.entry(k).or_insert(s);
            *e = (*e).max(s);
        }
    }
    let mut lowest_close: BTreeMap<(String, String), i64> = BTreeMap::new();
    for (s, a, q) in &r0.closes {
        if e0.contains(a) {
            continue;
        }
        let e = lowest_close.entry((s.clone(), a.clone())).or_insert(*q);
        *e = (*e).min(*q);
    }
    let mut close_after: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for ((s, a), q) in &lowest_close {
        if top.get(&(s.clone(), a.clone())).map(|x| x > q).unwrap_or(false) {
            close_after.entry(a.clone()).or_default().insert(s.clone(), *q);
        }
    }
    let mut equivocators = e0.clone();
    equivocators.extend(close_after.keys().cloned());
    let ro = roster_for(&equivocators);

    // A session is closed when a close that counts, by an author who is no
    // equivocator, names it (docs/format.md#closed).
    let closed: BTreeSet<String> = ro
        .closes
        .iter()
        .filter(|(_, a, _)| !equivocators.contains(a))
        .map(|(s, _, _)| s.clone())
        .collect();
    let members: BTreeSet<(String, String)> = ro.held.iter().map(|((s, _), h)| (s.clone(), h.clone())).collect();

    // Current bindings: the heads of `_dai_binding` among rows by authors who
    // are no equivocator, by session, entity and author; a binding names the
    // seat its author asks for (docs/format.md#waiting).
    let mut asking: BTreeSet<(String, String, String)> = BTreeSet::new(); // (session, seat, author)

    let mut verdicts = BTreeMap::new();
    let mut crossings: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut heads = BTreeMap::new();
    // The roster tables first, so the bindings are known before a seated row
    // asks whether its author waits.
    let mut order: Vec<&Table> = tables.iter().filter(|t| ROSTER.contains(&t.name.as_str())).collect();
    order.extend(tables.iter().filter(|t| !ROSTER.contains(&t.name.as_str())));
    for t in order {
        let rs = &rows[&t.name];
        let roster = ROSTER.contains(&t.name.as_str());
        let seat_col = seated.get(&t.name).and_then(|k| col(t, k));
        let by_id: BTreeMap<String, &Row> = rs.iter().map(|r| (rowid(t, r), r)).collect();
        // Whose statement a row is, for partitioning heads (docs/format.md#heads).
        let part = |r: &Row| -> String {
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
        let mut counted: Vec<&Row> = vec![];
        for r in rs {
            let id = rowid(t, r);
            let key = format!("{}|{}", t.name, id);
            let author = hx(&r.vals[t.i_replica]);
            let parents = parents_of(t, r);
            let v = if is_eq(t, r) {
                Verdict::Equivocated
            } else if roster {
                // An equivocator's roster rows count for nothing; in
                // `_dai_seat` only creators' seat rows count
                // (docs/format.md#equivocator, #creator-row-immutable,
                // #heads-roster).
                if equivocators.contains(&author) || (t.name == "_dai_seat" && !creator_ids.contains(&key)) {
                    Verdict::Nothing
                } else {
                    Verdict::Admitted
                }
            } else if t.i_session.is_none() {
                // A plain document's tables: heads among rows at ids not
                // equivocated (docs/format.md#heads-plain).
                Verdict::Admitted
            } else if parents.iter().any(|p| names_eq(p)) {
                // Before any other rule reads its parents
                // (docs/format.md#admitted-parent-equivocated).
                Verdict::ParentEquivocated
            } else {
                let is = t.i_session.unwrap();
                let sess = hx(&r.vals[is]);
                if !ro.live.contains(&sess) {
                    Verdict::VoidSession
                } else if equivocators.contains(&author) {
                    Verdict::Equivocator
                } else if parents.iter().any(|p| !held_ids.contains(p)) {
                    Verdict::WaitingParent
                } else {
                    // The versions it names: rows of its own table and entity
                    // (docs/format.md#parent-other-entity).
                    let mut crossing = None;
                    let mut across: Vec<String> = vec![];
                    for p in &parents {
                        let Some(o) = by_id.get(p) else { continue };
                        if o.vals[t.i_entity] != r.vals[t.i_entity] {
                            continue;
                        }
                        if o.vals[is] != r.vals[is] {
                            crossing = Some(Verdict::OtherSession);
                            across.push(p.clone());
                            continue;
                        }
                        if let Some(ic) = seat_col {
                            if !o.vals[ic].same(&r.vals[ic]) {
                                crossing.get_or_insert(Verdict::NotHeld);
                                across.push(p.clone());
                            }
                        }
                    }
                    if let Some(x) = crossing {
                        crossings.insert(key.clone(), across);
                        x
                    } else {
                        let holds = match seat_col {
                            Some(ic) => match seat_value(&r.vals[ic]) {
                                None => Err(Verdict::NotHeld),
                                Some(seat) => {
                                    let k = (sess.clone(), seat.clone());
                                    match ro.held.get(&k) {
                                        Some(h) if *h == author => Ok(()),
                                        Some(_) => Err(Verdict::NotHeld),
                                        None if ro.void.contains(&k) => Err(Verdict::Pending),
                                        None if creator_rows[&sess].seats.contains(&seat)
                                            && asking.contains(&(sess.clone(), seat.clone(), author.clone())) =>
                                        {
                                            Err(Verdict::Pending)
                                        }
                                        None => Err(Verdict::NotHeld),
                                    }
                                }
                            },
                            // Otherwise: its author is a member of the row's
                            // session. The page names no report for a row
                            // that is not; read as silent.
                            None => {
                                if members.contains(&(sess.clone(), author.clone())) {
                                    Ok(())
                                } else {
                                    Err(Verdict::Pending)
                                }
                            }
                        };
                        let is_creator = creator_rows[&sess].author == author;
                        match holds {
                            Err(v) => v,
                            Ok(()) => match roles.get(&t.name).map(|s| s.as_str()) {
                                Some("creator") if !is_creator => Verdict::Role,
                                Some("joiner") if is_creator => Verdict::Role,
                                _ => Verdict::Admitted,
                            },
                        }
                    }
                }
            };
            if v == Verdict::Admitted {
                counted.push(r);
            }
            if !roster && t.i_session.is_some() {
                verdicts.insert(key, v);
            }
        }
        // "A head is a row no row of its own partition names as a parent": a
        // row that does not count neither shows nor hides.
        let mut parented: BTreeSet<(String, String)> = BTreeSet::new();
        for r in &counted {
            for p in parents_of(t, r) {
                parented.insert((part(r), p));
            }
        }
        let hs_rows: Vec<&&Row> = counted.iter().filter(|r| !parented.contains(&(part(r), rowid(t, r)))).collect();
        if t.name == "_dai_binding" {
            if let (Some(is), Some(iseat)) = (t.i_session, col(t, "seat")) {
                for r in &hs_rows {
                    if int(&r.vals[t.i_deleted]) != 0 {
                        continue;
                    }
                    if let Some(v) = seat_value(&r.vals[iseat]) {
                        asking.insert((hx(&r.vals[is]), v, hx(&r.vals[t.i_replica])));
                    }
                }
            }
        }
        let mut hs: Vec<(String, i64, i64)> = hs_rows
            .iter()
            .map(|r| (hx(&r.vals[t.i_replica]), int(&r.vals[t.i_seq]), int(&r.vals[t.i_deleted])))
            .collect();
        hs.sort();
        heads.insert(t.name.clone(), hs);
    }

    let creator_of = |s: &str| creator_rows[s].author.clone();
    Admission {
        heads,
        holders: ro.held.iter().map(|((s, seat), h)| (s.clone(), seat.clone(), h.clone())).collect(),
        voided: ro.void.iter().map(|(s, seat)| (s.clone(), seat.clone(), creator_of(s))).collect(),
        void_two: ro.void_two.clone(),
        equivocated: eq,
        closed,
        verdicts,
        void_rests: ro.void_rests.clone(),
        crossings,
        close_after,
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
