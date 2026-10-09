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
    // The shortest form that holds the argument (docs/format.md#cbor-integer).
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n <= 0xff {
        out.push(m | 24);
        out.push(n as u8);
    } else if n <= 0xffff {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n <= 0xffff_ffff {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

fn cbor_value(out: &mut Vec<u8>, v: &V) {
    match v {
        // NULL is CBOR null (docs/format.md#cbor-other).
        V::Null => out.push(0xf6),
        // Integers, in the shortest form (docs/format.md#cbor-integer).
        V::Int(i) => {
            if *i >= 0 {
                cbor_head(out, 0, *i as u64);
            } else {
                cbor_head(out, 1, (-1 - *i) as u64);
            }
        }
        // A REAL is a float64, `fb` and eight bytes (docs/format.md#cbor-float).
        V::Real(f) => {
            out.push(0xfb);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        // Text is UTF-8; bytes are a byte string (docs/format.md#cbor-other).
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
    // The seq as eight bytes, unsigned, big-endian (docs/format.md#session-id).
    h.update((seq as u64).to_be_bytes());
    // The array of three, each value as the row holds it, whatever its type
    // (docs/format.md#session-id-roster).
    let mut cb = vec![];
    cbor_head(&mut cb, 4, 3);
    for v in roster {
        cbor_value(&mut cb, v);
    }
    h.update(&cb);
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
    match v {
        V::Blob(b) if b.len() == 16 => Some(hexlc(b)),
        _ => None,
    }
}

// A row's parents. A held row whose parents are not the one shape, a forward
// parent included, names nothing (docs/format.md#parents-own-malformed,
// #parent-forward). Not a lenient parse of what can be salvaged: nothing.
pub fn parents_of(t: &Table, r: &Row) -> Vec<String> {
    // The shape is checked before the parents are read for any purpose
    // (docs/format.md#parents-malformed).
    if !crate::parents_ok(t, r) {
        return vec![];
    }
    match &r.vals[t.i_parents] {
        V::Text(p) => serde_json::from_str::<Vec<String>>(p).unwrap_or_default(),
        _ => vec![],
    }
}

pub fn ids(eq: &BTreeSet<(String, String, i64)>) -> BTreeSet<(String, i64)> {
    eq.iter().map(|(a, _, s)| (a.clone(), *s)).collect()
}

// A stored list, read only in the one spelling: `[table, seq]` pairs ordered
// by table (UTF-8 order) then seq, non-empty, each seq positive, no pair
// twice and no seq twice in any tables. Any other spelling is not a list and
// lists nothing (docs/format.md#covers-spelling, #covers-seq-once).
fn covers_list(s: &str) -> Vec<(String, i64)> {
    let Ok(v) = serde_json::from_str::<Vec<(String, i64)>>(s) else { return vec![] };
    if v.is_empty() || v.iter().any(|(_, q)| *q < 1) {
        return vec![];
    }
    let mut sorted = v.clone();
    sorted.sort_by(|a, b| (a.0.as_bytes(), a.1).cmp(&(b.0.as_bytes(), b.1)));
    sorted.dedup();
    let seqs: BTreeSet<i64> = v.iter().map(|(_, q)| *q).collect();
    if sorted != v || seqs.len() != v.len() {
        return vec![];
    }
    match serde_json::to_string(&v) {
        Ok(spelled) if spelled == s => v,
        _ => vec![],
    }
}

// Equivocation: two headers of one author listing the same seq with different
// digests, in any tables (docs/format.md#equivocation, #equivocation-any-table,
// #equivocation-own-headers). From `_dai_batch.covers`, the signed list; the
// author is the header's own. Returned as one (author, table, seq) for each
// table a kept header lists an equivocated id in, the form the admitted text
// shows (conformance/merge/README.md); `ids` reduces it to the ids.
pub fn equivocated(c: &Connection, schema: &str) -> BTreeSet<(String, String, i64)> {
    // (author, digest, list) of each stored header.
    let mut hs: Vec<(String, String, Vec<(String, i64)>)> = vec![];
    if let Ok(mut st) = c.prepare(&format!("SELECT author, digest, covers FROM {}._dai_batch", schema)) {
        hs = st
            .query_map([], |r| {
                Ok((
                    V::from(r.get_ref(0)?).enc(),
                    V::from(r.get_ref(1)?).enc(),
                    match V::from(r.get_ref(2)?) {
                        V::Text(t) => t,
                        v => v.enc(),
                    },
                ))
            })
            .unwrap()
            .map(|x| x.unwrap())
            .map(|(a, d, cv)| (a, d, covers_list(&cv)))
            .collect();
    }
    // (author, seq) -> the digests of the headers listing it, in any table.
    let mut digests: BTreeMap<(String, i64), BTreeSet<String>> = BTreeMap::new();
    for (a, d, l) in &hs {
        for (_, s) in l {
            digests.entry((a.clone(), *s)).or_default().insert(d.clone());
        }
    }
    let mut out = BTreeSet::new();
    for (a, _, l) in &hs {
        for (tn, s) in l {
            if digests.get(&(a.clone(), *s)).map(|d| d.len() > 1).unwrap_or(false) {
                out.insert((a.clone(), tn.clone(), *s));
            }
        }
    }
    out
}

// The first two columns of each row of a declaration view, as text; nothing
// when the view is not there.
fn declaration(c: &Connection, view: &str) -> Vec<(String, String)> {
    let Ok(mut st) = c.prepare(&format!("SELECT * FROM main.\"{}\"", view)) else { return vec![] };
    let rows = st.query_map([], |r| Ok((V::from(r.get_ref(0)?), V::from(r.get_ref(1)?))));
    let Ok(rows) = rows else { return vec![] };
    rows.filter_map(|x| x.ok())
        .filter_map(|(a, b)| match (a, b) {
            (V::Text(a), V::Text(b)) => Some((a, b)),
            _ => None,
        })
        .collect()
}

// Which tables are seated, by which column: the `_dai_seat_rules` declaration.
fn seat_rules(c: &Connection) -> BTreeMap<String, String> {
    declaration(c, "_dai_seat_rules").into_iter().collect()
}

// Which author tables carry a role: the `_dai_author_rules` declaration
// (docs/format.md#session-declarations). The page does not give its columns;
// no fixture carries it. Read here as `_dai_seat_rules` is, (table, role), the
// role `creator` or `joiner`, with or without the `author=` of the profile
// spelling. An assumption, reported as a silence.
fn author_rules(c: &Connection) -> BTreeMap<String, String> {
    declaration(c, "_dai_author_rules")
        .into_iter()
        .map(|(t, r)| (t, r.trim_start_matches("author=").to_string()))
        .collect()
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

// One row of the merge, as the rules read it.
struct Rec {
    table: String,
    ti: usize,
    vals: Vec<V>,
    author: String,
    seq: i64,
    id: String,
    entity: String,
    session: String,
    deleted: bool,
    parents: Vec<String>,
}

fn col<'a>(tables: &[Table], r: &'a Rec, name: &str) -> Option<&'a V> {
    tables[r.ti].cols.iter().position(|c| c == name).map(|i| &r.vals[i])
}

fn hexv(v: &V) -> String {
    match v {
        V::Blob(b) => hexlc(b),
        v => v.enc(),
    }
}

fn split_id(id: &str) -> (String, i64) {
    match id.rsplit_once(':') {
        Some((a, s)) => (a.to_string(), s.parse().unwrap_or(0)),
        None => (id.to_string(), 0),
    }
}

fn roster(
    recs: &[Rec],
    tables: &[Table],
    creators: &BTreeMap<String, CreatorRow>,
    eq_ids: &BTreeSet<(String, i64)>,
    e: &BTreeSet<String>,
) -> Roster {
    // Every rule skips a row at an equivocated id
    // (docs/format.md#session-skip-equivocated), and a roster or close row by
    // an equivocator counts for nothing (docs/format.md#equivocator).
    let counts = |r: &Rec| !eq_ids.contains(&(r.author.clone(), r.seq)) && !e.contains(&r.author);
    // Live: the creator's seat row is not deleted, its roster is valid, and its
    // author is no equivocator (docs/format.md#creator, #session-void).
    let live: BTreeSet<String> = creators
        .iter()
        .filter(|(_, cr)| cr.valid && !cr.deleted && !e.contains(&cr.author) && !eq_ids.contains(&split_id(&cr.id)))
        .map(|(s, _)| s.clone())
        .collect();
    // Counting confirms: by the creator, in her live session, naming a value
    // her seat row's `seats` holds and a 16-byte holder; at any seq, deleted or
    // not, superseded or not (docs/format.md#confirms, #confirm-versions-count).
    let mut names: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    let mut confirms: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
    for r in recs.iter().filter(|r| r.table == "_dai_confirm") {
        if !counts(r) || !live.contains(&r.session) {
            continue;
        }
        let cr = &creators[&r.session];
        if r.author != cr.author {
            continue;
        }
        let Some(v) = col(tables, r, "seat").and_then(seat_value) else { continue };
        if !cr.seats.contains(&v) {
            continue;
        }
        let Some(h) = col(tables, r, "holder").and_then(seat_value) else { continue };
        names.entry((r.session.clone(), v.clone())).or_default().insert(h);
        confirms.entry((r.session.clone(), v)).or_default().push(("_dai_confirm".into(), r.id.clone()));
    }
    let mut held: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut void: BTreeSet<(String, String)> = BTreeSet::new();
    let mut void_two: BTreeSet<(String, String)> = BTreeSet::new();
    let mut void_rests: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
    // The creator holds the creator's seat (docs/format.md#creator-seat, #holders).
    for s in &live {
        let cr = &creators[s];
        held.insert((s.clone(), cr.seat.clone()), cr.author.clone());
    }
    for (k, hs) in &names {
        // Void when its counting confirms name two or more holders, or a
        // holder who is an equivocator (docs/format.md#void,
        // #equivocator-holds-nothing); else held by the one they name
        // (docs/format.md#holders).
        let two = hs.len() >= 2;
        if two || hs.iter().any(|h| e.contains(h)) {
            void.insert(k.clone());
            if two {
                void_two.insert(k.clone());
            }
            // A void rests on the counting confirms of its seat and on the
            // live session's creator's seat row (docs/format.md#void-rests-on).
            let mut rests = confirms[k].clone();
            rests.push(("_dai_seat".into(), creators[&k.0].id.clone()));
            void_rests.insert(k.clone(), rests);
        } else {
            held.insert(k.clone(), hs.iter().next().unwrap().clone());
        }
    }
    // A close counts when it is not deleted, in a live session, by the creator
    // or, under `close=any`, a holder of a seat in its own session
    // (docs/format.md#close-counts).
    let mut closes = vec![];
    for r in recs.iter().filter(|r| r.table == "_dai_close") {
        if !counts(r) || r.deleted || !live.contains(&r.session) {
            continue;
        }
        let cr = &creators[&r.session];
        let holder = held.iter().any(|((s, _), h)| *s == r.session && *h == r.author);
        if r.author == cr.author || (cr.close_any && holder) {
            closes.push((r.session.clone(), r.author.clone(), r.seq));
        }
    }
    Roster { live, held, void, void_two, void_rests, closes }
}

// A head is a row no row of its own partition names as a parent
// (docs/format.md#heads). `members` are indexes into `recs` with a partition key.
fn heads_among(recs: &[Rec], members: &[(usize, String)]) -> Vec<(String, i64, i64)> {
    let mut named: BTreeSet<(String, String)> = BTreeSet::new();
    for (i, k) in members {
        for p in &recs[*i].parents {
            named.insert((k.clone(), p.clone()));
        }
    }
    members
        .iter()
        .filter(|(i, k)| !named.contains(&(k.clone(), recs[*i].id.clone())))
        .map(|(i, _)| (recs[*i].author.clone(), recs[*i].seq, recs[*i].deleted as i64))
        .collect()
}

pub fn admit(c: &Connection, tables: &[Table], max_parties: usize) -> Admission {
    let equivocated = equivocated(c, "main");
    let eq_ids = ids(&equivocated);
    let is_eq = |a: &str, s: i64| eq_ids.contains(&(a.to_string(), s));

    let mut recs: Vec<Rec> = vec![];
    for (ti, t) in tables.iter().enumerate() {
        for r in load(c, "main", t) {
            let author = hexv(&r.vals[t.i_replica]);
            let seq = int(&r.vals[t.i_seq]);
            recs.push(Rec {
                table: t.name.clone(),
                ti,
                author,
                seq,
                id: rowid(t, &r),
                entity: hexv(&r.vals[t.i_entity]),
                session: t.i_session.map(|i| hexv(&r.vals[i])).unwrap_or_default(),
                deleted: int(&r.vals[t.i_deleted]) != 0,
                parents: parents_of(t, &r),
                vals: r.vals,
            });
        }
    }
    let mut heads: BTreeMap<String, Vec<(String, i64, i64)>> =
        tables.iter().map(|t| (t.name.clone(), vec![])).collect();
    let session_doc = tables.iter().any(|t| t.i_session.is_some());

    if !session_doc {
        // A plain document's heads: among rows at ids not equivocated,
        // partitioned by entity (docs/format.md#heads-plain,
        // #equivocator-holds-nothing).
        for t in tables {
            let members: Vec<(usize, String)> = recs
                .iter()
                .enumerate()
                .filter(|(_, r)| r.table == t.name && !is_eq(&r.author, r.seq))
                .map(|(i, r)| (i, r.entity.clone()))
                .collect();
            heads.insert(t.name.clone(), heads_among(&recs, &members));
        }
        return Admission {
            heads,
            holders: BTreeSet::new(),
            voided: BTreeSet::new(),
            void_two: BTreeSet::new(),
            equivocated,
            closed: BTreeSet::new(),
            verdicts: BTreeMap::new(),
            void_rests: BTreeMap::new(),
            crossings: BTreeMap::new(),
            close_after: BTreeMap::new(),
        };
    }

    // The copy holds a row at an id, in any table (docs/format.md#waiting-on-parent).
    let held_ids: BTreeSet<(String, i64)> = recs.iter().map(|r| (r.author.clone(), r.seq)).collect();

    // Creators' seat rows: the `_dai_seat` rows whose own author, seq and
    // roster hash to their `_r_session` (docs/format.md#creator,
    // #session-id-creator-row), and whether each declares a valid roster
    // (docs/format.md#roster-declared).
    let mut creators: BTreeMap<String, CreatorRow> = BTreeMap::new();
    let mut creator_ids: BTreeSet<String> = BTreeSet::new();
    for r in recs.iter().filter(|r| r.table == "_dai_seat") {
        let (Some(seat), Some(seats), Some(close)) =
            (col(tables, r, "seat"), col(tables, r, "seats"), col(tables, r, "close"))
        else {
            continue;
        };
        let Some(author) = blob(&r.vals[tables[r.ti].i_replica]) else { continue };
        let sid = hexlc(&session_id(&author, r.seq, [seat, seats, close]));
        if sid != r.session {
            continue;
        }
        let seat_v = seat_value(seat);
        let open: Option<Vec<String>> = match seats {
            V::Blob(b) if b.len() % 16 == 0 => Some(b.chunks(16).map(hexlc).collect()),
            _ => None,
        };
        let close_rule = match close {
            V::Text(t) if t == "any" || t == "creator" => Some(t.clone()),
            _ => None,
        };
        let valid = match (&seat_v, &open, &close_rule) {
            (Some(s), Some(o), Some(_)) => {
                let distinct: BTreeSet<&String> = o.iter().collect();
                distinct.len() == o.len() && !o.contains(s) && 1 + o.len() <= max_parties
            }
            _ => false,
        };
        creator_ids.insert(r.id.clone());
        creators.insert(
            r.session.clone(),
            CreatorRow {
                author: r.author.clone(),
                id: r.id.clone(),
                deleted: r.deleted,
                valid,
                seat: seat_v.unwrap_or_default(),
                seats: open.unwrap_or_default(),
                close_any: close_rule.as_deref() == Some("any"),
            },
        );
    }

    // Equivocators: two headers at one id (docs/format.md#equivocator) ...
    let e0: BTreeSet<String> = eq_ids.iter().map(|(a, _)| a.clone()).collect();
    // ... or a close that counts, its author's equivocation not read, and a
    // row of his in that session at a higher seq, in any table
    // (docs/format.md#close-counts, #close-monotone, #close-first).
    let r0 = roster(&recs, tables, &creators, &eq_ids, &e0);
    let mut lowest: BTreeMap<(String, String), i64> = BTreeMap::new();
    for (s, a, q) in &r0.closes {
        let e = lowest.entry((a.clone(), s.clone())).or_insert(*q);
        *e = (*e).min(*q);
    }
    let mut close_after: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for ((a, s), q) in &lowest {
        let above = recs
            .iter()
            .any(|r| r.author == *a && r.session == *s && r.seq > *q && !is_eq(&r.author, r.seq));
        if above {
            close_after.entry(a.clone()).or_default().insert(s.clone(), *q);
        }
    }
    let mut e = e0.clone();
    e.extend(close_after.keys().cloned());
    let ro = roster(&recs, tables, &creators, &eq_ids, &e);

    let holders: BTreeSet<(String, String, String)> =
        ro.held.iter().map(|((s, v), h)| (s.clone(), v.clone(), h.clone())).collect();
    let voided: BTreeSet<(String, String, String)> = ro
        .void
        .iter()
        .map(|(s, v)| (s.clone(), v.clone(), creators[s].author.clone()))
        .collect();
    // A session is closed when a close that counts, by an author who is no
    // equivocator, names it (docs/format.md#closed).
    let closed: BTreeSet<String> = ro.closes.iter().filter(|(_, a, _)| !e.contains(a)).map(|(s, _, _)| s.clone()).collect();

    // The roster tables' and the close's heads: among rows by authors who are
    // no equivocator, partitioned by session, entity and author; in
    // `_dai_seat` only creators' seat rows count (docs/format.md#heads-roster,
    // #creator-row-immutable).
    for tn in ROSTER {
        if !heads.contains_key(tn) {
            continue;
        }
        let members: Vec<(usize, String)> = recs
            .iter()
            .enumerate()
            .filter(|(_, r)| r.table == tn && !e.contains(&r.author) && !is_eq(&r.author, r.seq))
            .filter(|(_, r)| tn != "_dai_seat" || creator_ids.contains(&r.id))
            .map(|(i, r)| (i, format!("{}|{}|{}", r.session, r.entity, r.author)))
            .collect();
        heads.insert(tn.to_string(), heads_among(&recs, &members));
    }

    // The bindings that count: heads of `_dai_binding` (docs/format.md#waiting).
    let binding_heads: BTreeSet<(String, i64)> = heads
        .get("_dai_binding")
        .map(|v| v.iter().map(|(a, s, _)| (a.clone(), *s)).collect())
        .unwrap_or_default();
    // (session, author) -> the seat values his current bindings name.
    let mut asks: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for r in recs.iter().filter(|r| r.table == "_dai_binding") {
        if r.deleted || !binding_heads.contains(&(r.author.clone(), r.seq)) {
            continue;
        }
        if let Some(v) = col(tables, r, "seat").and_then(seat_value) {
            asks.entry((r.session.clone(), r.author.clone())).or_default().insert(v);
        }
    }

    let seats = seat_rules(c);
    let roles = author_rules(c);
    // (table, id) -> index, for finding a parent in the row's own table.
    let by_id: BTreeMap<(String, String), usize> =
        recs.iter().enumerate().map(|(i, r)| ((r.table.clone(), r.id.clone()), i)).collect();

    let mut verdicts: BTreeMap<String, Verdict> = BTreeMap::new();
    let mut crossings: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut admitted: Vec<usize> = vec![];
    for (i, r) in recs.iter().enumerate() {
        if ROSTER.contains(&r.table.as_str()) {
            continue;
        }
        let key = format!("{}|{}", r.table, r.id);
        let seat_col = seats.get(&r.table);
        fn seat_of<'a>(tables: &[Table], sc: Option<&String>, x: &'a Rec) -> Option<&'a V> {
            sc.and_then(|c| col(tables, x, c))
        }
        // The crossings: a parent that is a row of its own table and entity
        // from another session, or, seated, in its session acting for another
        // seat (docs/format.md#admitted-no-other-session,
        // #admitted-no-other-seat, #parent-other-entity, #report-crossing).
        let mut other_session = false;
        let mut other_seat = false;
        let mut cross = vec![];
        for p in &r.parents {
            let Some(&pi) = by_id.get(&(r.table.clone(), p.clone())) else { continue };
            let pr = &recs[pi];
            let (pa, ps) = split_id(p);
            if pr.entity != r.entity || is_eq(&pa, ps) {
                continue;
            }
            if pr.session != r.session {
                other_session = true;
                cross.push(p.clone());
            } else if seat_col.is_some() && !seat_of(tables, seat_col, pr).zip(seat_of(tables, seat_col, r)).map(|(a, b)| a.same(b)).unwrap_or(false) {
                other_seat = true;
                cross.push(p.clone());
            }
        }
        if !cross.is_empty() {
            crossings.insert(key.clone(), cross);
        }
        let live = ro.live.contains(&r.session);
        let v = if is_eq(&r.author, r.seq) {
            // docs/format.md#admitted-not-equivocated, #equivocated-counts-nothing
            Verdict::Equivocated
        } else if e.contains(&r.author) {
            // docs/format.md#equivocator-holds-nothing
            Verdict::Equivocator
        } else if !live {
            // docs/format.md#session-void
            Verdict::VoidSession
        } else if r.parents.iter().any(|p| {
            let (a, s) = split_id(p);
            is_eq(&a, s)
        }) {
            // docs/format.md#admitted-parent-equivocated
            Verdict::ParentEquivocated
        } else if r.parents.iter().any(|p| !held_ids.contains(&split_id(p))) {
            // docs/format.md#admitted-parents-held, #waiting-on-parent
            Verdict::WaitingParent
        } else if other_session {
            // docs/format.md#entity-other-session
            Verdict::OtherSession
        } else if let Some(sc) = seat_col {
            // docs/format.md#admitted-seat, #seat-not-held, #waiting, #void-row
            match col(tables, r, sc).and_then(seat_value) {
                None => Verdict::NotHeld,
                Some(_) if other_seat => Verdict::NotHeld,
                Some(v) => {
                    let k = (r.session.clone(), v.clone());
                    if ro.held.get(&k) == Some(&r.author) {
                        Verdict::Admitted
                    } else if ro.void.contains(&k) {
                        Verdict::Pending
                    } else {
                        let open = creators[&r.session].seats.contains(&v);
                        let asked = asks.get(&(r.session.clone(), r.author.clone())).map(|x| x.contains(&v)).unwrap_or(false);
                        if open && !ro.held.contains_key(&k) && asked {
                            Verdict::Pending
                        } else {
                            Verdict::NotHeld
                        }
                    }
                }
            }
        } else if ro.held.iter().any(|((s, _), h)| *s == r.session && *h == r.author) {
            // docs/format.md#admitted-member
            Verdict::Admitted
        } else {
            Verdict::Pending
        };
        // docs/format.md#admitted-role
        let v = match (v, roles.get(&r.table)) {
            (Verdict::Admitted, Some(role)) => {
                let is_creator = creators[&r.session].author == r.author;
                if (role == "creator") == is_creator {
                    Verdict::Admitted
                } else {
                    Verdict::Role
                }
            }
            (v, _) => v,
        };
        if v == Verdict::Admitted {
            admitted.push(i);
        }
        verdicts.insert(key, v);
    }

    // A session author table's heads: among admitted rows only, partitioned
    // by entity, session and (seated) seat (docs/format.md#heads-author-table).
    for t in tables {
        if ROSTER.contains(&t.name.as_str()) {
            continue;
        }
        let seat_col = seats.get(&t.name);
        let members: Vec<(usize, String)> = admitted
            .iter()
            .filter(|i| recs[**i].table == t.name)
            .map(|i| {
                let r = &recs[*i];
                let seat = seat_col.and_then(|c| col(tables, r, c)).map(|v| v.enc()).unwrap_or_default();
                (*i, format!("{}|{}|{}", r.entity, r.session, seat))
            })
            .collect();
        heads.insert(t.name.clone(), heads_among(&recs, &members));
    }

    Admission {
        heads,
        holders,
        voided,
        void_two: ro.void_two.clone(),
        equivocated,
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
    // The admitted heads of every table, `id` and the deleted flag, by author
    // then seq.
    for (t, hs) in &a.heads {
        out.push_str(&format!("# {}\n", t));
        let mut hs = hs.clone();
        hs.sort();
        for (au, s, d) in hs {
            out.push_str(&format!("{}:{}\t{}\n", au, s, d));
        }
    }
    out.push_str("# holders\n");
    for (s, v, h) in &a.holders {
        out.push_str(&format!("{}\t{}\t{}\n", s, v, h));
    }
    out.push_str("# voided\n");
    for (s, v, cr) in &a.voided {
        out.push_str(&format!("{}\t{}\t{}\n", s, v, cr));
    }
    out.push_str("# equivocated\n");
    for (au, t, s) in &a.equivocated {
        out.push_str(&format!("{}\t{}\t{}\n", au, t, s));
    }
    out.push_str("# closed\n");
    for s in &a.closed {
        out.push_str(&format!("{}\n", s));
    }
    out
}
