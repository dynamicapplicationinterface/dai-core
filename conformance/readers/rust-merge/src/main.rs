mod admit;

use rusqlite::{types::ValueRef, Connection};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Clone, PartialEq, Debug)]
enum V {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl V {
    fn from(r: ValueRef<'_>) -> V {
        match r {
            ValueRef::Null => V::Null,
            ValueRef::Integer(i) => V::Int(i),
            ValueRef::Real(f) => V::Real(f),
            ValueRef::Text(t) => V::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => V::Blob(b.to_vec()),
        }
    }
    // T1-D9 canonical encoding
    fn enc(&self) -> String {
        match self {
            V::Null => "nil".into(),
            V::Int(i) => i.to_string(),
            V::Text(t) => t
                .replace('\\', "\\\\")
                .replace('\t', "\\t")
                .replace('\n', "\\n"),
            V::Blob(b) => b.iter().map(|x| format!("{:02x}", x)).collect(),
            V::Real(f) => enc_real(*f),
        }
    }
    fn same(&self, o: &V) -> bool {
        match (self, o) {
            (V::Real(a), V::Real(b)) => a.to_bits() == b.to_bits(),
            _ => self == o,
        }
    }
}

fn enc_real(f: f64) -> String {
    if f.is_nan() {
        return "nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let s = format!("{}", f);
    if s.contains('.') || s.contains('e') || s.contains('E') {
        s
    } else {
        format!("{}.0", s)
    }
}

fn hexlc(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// An author id as a person is shown it: base64url, no padding.
fn shown(b: &[u8]) -> String {
    todo!()
}

struct Row {
    vals: Vec<V>,
}

struct Table {
    name: String,
    cols: Vec<String>,
    i_replica: usize,
    i_seq: usize,
    i_entity: usize,
    i_parents: usize,
    i_superseded: usize,
    i_deleted: usize,
    // The session a row belongs to, in a session document (T1-D26).
    i_session: Option<usize>,
    // The signed batch a row left in (docs/identity.md), when the table has one.
    // Not row content: the batch is named after the rows.
    i_batch: Option<usize>,
}

fn table_cols(c: &Connection, schema: &str, t: &str) -> Vec<String> {
    let mut st = c
        .prepare(&format!("SELECT name FROM pragma_table_info(?1, ?2)"))
        .unwrap();
    let v: Vec<String> = st
        .query_map(rusqlite::params![t, schema], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    v
}

fn replicated_tables(c: &Connection, schema: &str) -> Vec<Table> {
    todo!()
}

fn load(c: &Connection, schema: &str, t: &Table) -> Vec<Row> {
    let sel = t
        .cols
        .iter()
        .map(|x| format!("\"{}\"", x))
        .collect::<Vec<_>>()
        .join(",");
    let mut st = c
        .prepare(&format!("SELECT {} FROM {}.\"{}\"", sel, schema, t.name))
        .unwrap();
    let n = t.cols.len();
    let rows: Vec<Row> = st
        .query_map([], |r| {
            Ok(Row {
                vals: (0..n).map(|i| V::from(r.get_ref(i).unwrap())).collect(),
            })
        })
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    rows
}

// The one shape of _r_parents (D159): a flat JSON array of at most 256 row ids,
// each 32 lowercase hex characters, a colon and a positive safe-integer seq.
// Anything else is ROW_MALFORMED at merge.
const PARENTS_CAP: usize = 256;
fn parents_well_formed(v: &V) -> bool {
    let V::Text(p) = v else { return false };
    let Ok(serde_json::Value::Array(a)) = serde_json::from_str::<serde_json::Value>(p) else { return false };
    if a.len() > PARENTS_CAP {
        return false;
    }
    a.iter().all(|e| {
        let Some(s) = e.as_str() else { return false };
        let Some((hex, seq)) = s.split_once(':') else { return false };
        hex.len() == 32
            && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && !seq.is_empty()
            && !seq.starts_with('0')
            && seq.bytes().all(|b| b.is_ascii_digit())
            && seq.len() <= 16
            && seq.parse::<u64>().map(|n| n <= (1u64 << 53) - 1).unwrap_or(false)
    })
}

// A row's parents are well formed when they are the one shape and name no id
// of the row's own author at a seq at or above the row's own
// (docs/format.md#parents-shape, #parent-forward).
fn parents_ok(t: &Table, r: &Row) -> bool {
    if !parents_well_formed(&r.vals[t.i_parents]) {
        return false;
    }
    let own = match &r.vals[t.i_replica] {
        V::Blob(b) => hexlc(b),
        _ => return true,
    };
    let seq = match &r.vals[t.i_seq] {
        V::Int(i) => *i,
        _ => return true,
    };
    let V::Text(p) = &r.vals[t.i_parents] else { return false };
    let a: Vec<String> = serde_json::from_str(p).unwrap_or_default();
    !a.iter().any(|x| match x.split_once(':') {
        Some((h, s)) => h == own && s.parse::<i64>().map(|n| n >= seq).unwrap_or(true),
        None => true,
    })
}

fn rowid(t: &Table, r: &Row) -> String {
    let rep = match &r.vals[t.i_replica] {
        V::Blob(b) => hexlc(b),
        v => v.enc(),
    };
    let seq = match &r.vals[t.i_seq] {
        V::Int(i) => i.to_string(),
        v => v.enc(),
    };
    format!("{}:{}", rep, seq)
}

struct Counts {
    applied: i64,
    duplicate: i64,
    rejected: Vec<String>,
    new_replicas: i64,
    // (author shown, reason), one per batch and reason, ordered by batch id.
    refused: Vec<(String, String)>,
    // The whole sibling refused (SIGNED_VIEW_MISMATCH), or None.
    refused_whole: Option<String>,
}

// Union merge, taking only what a verified header lists (docs/format.md).
// `verdicts` is the signature check's answer for each of the sibling's headers,
// by id in lowercase hex: "ok" or a BATCH_ code. A header missing from it was
// not checked, and a header not checked is not signed. `signed_lists` is the
// list that made a header authentic where it is not the one it stores
// (lists.json; docs/format.md#fixtures-verdicts), by id, in the one spelling.
// `own_verdicts` and `own_lists` are the same for the local copy's headers,
// each against the local copy's rows: a held header complete over them adopts
// the pending rows it lists (docs/format.md#merge-row-held-signed).
// Returns the counts, the canonical dump, and what the document admits after.
fn merge(
    work: &Path,
    sibling: &Path,
    verdicts: &BTreeMap<String, String>,
    signed_lists: &BTreeMap<String, String>,
    own_verdicts: &BTreeMap<String, String>,
    own_lists: &BTreeMap<String, String>,
    max_parties: usize,
    view_mismatch: bool,
) -> (Counts, String, String) {
    todo!()
}

// The canonical dump (docs/format.md#merge-dump).
fn dump(c: &Connection, tables: &[Table]) -> String {
    todo!()
}

// The expected refusedBatches as (author, reason) pairs; None when misshapen, which fails.
fn refused_of(v: &serde_json::Value) -> Option<Vec<(String, String)>> {
    todo!()
}

fn main() {
    todo!()
}
