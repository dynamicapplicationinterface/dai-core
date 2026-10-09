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
    todo!()
}

fn cbor_value(out: &mut Vec<u8>, v: &V) {
    todo!()
}

// The session id a seat row would be the creator's seat row of: SHA-256 of
// the author id (16 bytes), the seq as eight bytes big-endian, and the
// canonical CBOR of [seat, seats, close] as the row holds them; the first 16
// bytes (docs/format.md#session-id, #session-id-roster).
pub fn session_id(author: &[u8], seq: i64, roster: [&V; 3]) -> Vec<u8> {
    todo!()
}

fn blob(v: &V) -> Option<Vec<u8>> {
    todo!()
}

fn int(v: &V) -> i64 {
    todo!()
}

// A seat value is a byte string of exactly 16 bytes; anything else names no
// seat (docs/format.md#seat-value-shape).
fn seat_value(v: &V) -> Option<String> {
    todo!()
}

// A row's parents. A held row whose parents are not the one shape, a forward
// parent included, names nothing (docs/format.md#parents-own-malformed,
// #parent-forward). Not a lenient parse of what can be salvaged: nothing.
pub fn parents_of(t: &Table, r: &Row) -> Vec<String> {
    todo!()
}

pub fn ids(eq: &BTreeSet<(String, String, i64)>) -> BTreeSet<(String, i64)> {
    todo!()
}

// Equivocation: two headers of one author listing the same seq with different
// digests, in any tables (docs/format.md#equivocation, #equivocation-any-table,
// #equivocation-own-headers). From `_dai_batch.covers`, the signed list; the
// author is the header's own. Returned as one (author, table, seq) for each
// table a kept header lists an equivocated id in, the form the admitted text
// shows (conformance/merge/README.md); `ids` reduces it to the ids.
pub fn equivocated(c: &Connection, schema: &str) -> BTreeSet<(String, String, i64)> {
    todo!()
}

// Which tables are seated, by which column: the `_dai_seat_rules` declaration.
fn seat_rules(c: &Connection) -> BTreeMap<String, String> {
    todo!()
}

// Which author tables carry a role: the `_dai_author_rules` declaration
// (docs/format.md#session-declarations). The page does not give its columns;
// no fixture carries it. Read here as `_dai_seat_rules` is, (table, role), the
// role `creator` or `joiner`, with or without the `author=` of the profile
// spelling. An assumption, reported as a silence.
fn author_rules(c: &Connection) -> BTreeMap<String, String> {
    todo!()
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
    todo!()
}

// The expected-admitted-*.txt form (conformance/merge/README.md).
pub fn render(a: &Admission) -> String {
    todo!()
}
