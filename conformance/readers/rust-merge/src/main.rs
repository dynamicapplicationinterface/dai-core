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
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in b.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
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
    let mut st = c
        .prepare(&format!(
            // The roster tables (_dai_seat, _dai_binding, _dai_confirm,
            // _dai_close) are replicated tables like any other: they carry the
            // _r_ columns, and that is what decides, not the name.
            "SELECT name FROM {}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            schema
        ))
        .unwrap();
    let names: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    drop(st);
    let mut out = vec![];
    for n in names {
        let cols = table_cols(c, schema, &n);
        let idx = |k: &str| cols.iter().position(|x| x == k);
        if let (Some(a), Some(b), Some(e), Some(p), Some(s), Some(d)) = (
            idx("_r_replica"),
            idx("_r_seq"),
            idx("_r_entity"),
            idx("_r_parents"),
            idx("_r_superseded"),
            idx("_r_deleted"),
        ) {
            let i_batch = idx("_r_batch");
            let i_session = idx("_r_session");
            out.push(Table {
                name: n,
                cols,
                i_replica: a,
                i_seq: b,
                i_entity: e,
                i_parents: p,
                i_superseded: s,
                i_deleted: d,
                i_session,
                i_batch,
            });
        }
    }
    out
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
}

// Union merge, taking only what a verified header lists (docs/format.md).
// `verdicts` is the signature check's answer for each of the sibling's headers,
// by id in lowercase hex: "ok" or a BATCH_ code. A header missing from it was
// not checked, and a header not checked is not signed. `signed_lists` is the
// list that made a header authentic where it is not the one it stores
// (lists.json; docs/format.md#fixtures-verdicts), by id, in the one spelling.
// Returns the counts, the canonical dump, and what the document admits after.
fn merge(
    work: &Path,
    sibling: &Path,
    verdicts: &BTreeMap<String, String>,
    signed_lists: &BTreeMap<String, String>,
) -> (Counts, String, String) {
    let c = Connection::open(work).unwrap();
    c.execute_batch(&format!(
        "ATTACH DATABASE 'file:{}?mode=ro' AS S;",
        sibling.to_string_lossy().replace('\\', "/")
    ))
    .unwrap();

    let mut counts = Counts {
        applied: 0,
        duplicate: 0,
        rejected: vec![],
        new_replicas: 0,
        refused: vec![],
    };
    let mut refusals: BTreeMap<(String, String, String), Vec<u8>> = BTreeMap::new();

    let local_lc: i64 = c
        .query_row("SELECT lc FROM main._dai_replica", [], |r| r.get(0))
        .unwrap_or(0);
    let s_lc: i64 = c
        .query_row("SELECT lc FROM S._dai_replica", [], |r| r.get(0))
        .unwrap_or(0);
    let mut lc_max = local_lc.max(s_lc);

    let tables = replicated_tables(&c, "main");
    let s_tables = replicated_tables(&c, "S");

    c.execute_batch("BEGIN").unwrap();

    // The signed headers: a union by id of the verified ones, before any row,
    // since a row may name only a header this copy holds. A header lists the rows
    // it covers (its author, its seqs); a row's _r_batch is a cache of one header
    // that lists it, never the truth.
    let has = |schema: &str| -> bool {
        c.query_row(
            &format!("SELECT count(*) FROM {}.sqlite_master WHERE type='table' AND name='_dai_batch'", schema),
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
            > 0
    };
    // What this copy admitted and held equivocated before the merge, so the
    // merge reports only what it brings (D160, D165).
    let eq_before = admit::equivocated(&c, "main");
    let voided_before = admit::admit(&c, &tables).voided;

    let mut held: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut covering: BTreeMap<String, String> = BTreeMap::new(); // "table|author:seq" -> lowest ok id
    let mut covers: BTreeSet<String> = BTreeSet::new(); // "id|table|author:seq"
    let mut listed_by: BTreeMap<String, BTreeSet<String>> = BTreeMap::new(); // "table|author:seq" -> ok ids
    let mut authors: BTreeMap<String, Vec<u8>> = BTreeMap::new(); // header id -> its author
    let mut tainted: BTreeSet<String> = BTreeSet::new(); // complete headers that signed a malformed row
    // Every authentic header's list (ok or incomplete), by id: the revealing
    // headers of D160 are among the ones this merge kept, and "incomplete" is
    // kept too (docs/format.md#merge-headers-kept, #revealing-two-headers).
    let mut lists: BTreeMap<String, Vec<String>> = BTreeMap::new(); // header id -> "table|author:seq"
    // The headers the local copy held before the merge: a revealing header is
    // one "the local copy did not hold before" (docs/format.md#revealing-two-headers).
    let mut held_before: BTreeSet<String> = BTreeSet::new();
    if has("main") {
        let mut st = c.prepare("SELECT id FROM main._dai_batch").unwrap();
        held_before = st
            .query_map([], |r| r.get::<_, Vec<u8>>(0))
            .unwrap()
            .map(|x| hexlc(&x.unwrap()))
            .collect();
    }
    if has("main") && has("S") {
        let headers: Vec<(Vec<u8>, Vec<u8>, String)> = {
            let mut st = c.prepare("SELECT id, author, covers FROM S._dai_batch").unwrap();
            let v = st
                .query_map([], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, String>(2)?)))
                .unwrap()
                .map(|x| x.unwrap())
                .collect();
            v
        };
        let mut headers = headers;
        headers.sort_by(|a, b| hexlc(&a.0).cmp(&hexlc(&b.0)));
        let mut keep: Vec<(String, Vec<u8>, String)> = vec![];
        for (id, author, stored) in headers {
            let hid = hexlc(&id);
            // The list it signed is the one that made it authentic (the stored
            // one tried first, then the author's rows naming it), and a kept
            // header lists that one, not the one the sibling stored
            // (docs/format.md#verify-lists-tried, #merge-headers-kept-list).
            let listed = signed_lists.get(&hid).cloned().unwrap_or(stored);
            held.insert(hid.clone(), id.clone());
            authors.insert(hid.clone(), author.clone());
            let verdict = verdicts.get(&hid).cloned().unwrap_or_else(|| "BATCH_SIGNATURE_INVALID".to_string());
            if verdict != "ok" && verdict != "incomplete" {
                refusals.insert((hid, verdict, hexlc(&author)), author);
                continue;
            }
            // "incomplete": the author's header (batch format 2 signs its list),
            // whose rows the sibling does not hold as signed. Kept, so evidence
            // travels (D160), and no row is taken through it.
            keep.push((hid.clone(), id.clone(), listed.clone()));
            let mut keys = vec![];
            if let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(&listed) {
                for pair in list {
                    keys.push(format!("{}|{}:{}", pair[0].as_str().unwrap_or(""), hexlc(&author), pair[1]));
                }
            }
            lists.insert(hid.clone(), keys.clone());
            if verdict != "ok" {
                continue;
            }
            for key in keys {
                covers.insert(format!("{}|{}", hid, key));
                listed_by.entry(key).or_default().insert(hid.clone());
            }
        }

        // D159: every arriving row's parents are checked before anything reads
        // them. A complete header that signed one is refused whole: not kept,
        // and none of its rows taken, since a header kept without one of its
        // rows would fail at the next copy in its author's name.
        for t in &tables {
            if !s_tables.iter().any(|x| x.name == t.name) {
                continue;
            }
            for r in load(&c, "S", t) {
                if parents_well_formed(&r.vals[t.i_parents]) {
                    continue;
                }
                let key = format!("{}|{}", t.name, rowid(t, &r));
                if let Some(ids) = listed_by.get(&key) {
                    tainted.extend(ids.iter().cloned());
                }
            }
        }
        for hid in &tainted {
            let author = authors[hid].clone();
            refusals.insert((hid.clone(), "ROW_MALFORMED".to_string(), hexlc(&author)), author);
        }
        for (hid, id, listed) in keep {
            if tainted.contains(&hid) {
                lists.remove(&hid);
                continue;
            }
            // Its stored covers is the list it signed (#merge-headers-kept-list).
            c.execute(
                "INSERT OR IGNORE INTO main._dai_batch (id, author, lc, sig, pub, att, version, digest, covers) \
                 SELECT id, author, lc, sig, pub, att, version, digest, ?2 FROM S._dai_batch WHERE id = ?1",
                rusqlite::params![id, listed],
            )
            .unwrap();
        }
        // No row is taken through a tainted header, but "A row listed by a
        // complete header kept in step 1 ... is signed, and taken", and only
        // "A row listed only by a header refused as ROW_MALFORMED is not
        // taken" (docs/format.md#merge-row-signed, #merge-row-refused-header).
        // So a row another kept
        // complete header lists is taken through that one, and its _r_batch
        // is chosen among the kept headers only.
        for (key, ids) in &listed_by {
            if let Some(h) = ids.iter().find(|h| !tainted.contains(*h)) {
                covering.insert(key.clone(), h.clone());
            }
        }
        covers.retain(|x| !tainted.contains(x.split('|').next().unwrap_or("")));
        listed_by.retain(|_, ids| ids.iter().all(|h| tainted.contains(h)));
    }
    // What is left in listed_by: the rows only a refused-whole batch signed.
    let spoiled = listed_by;


    // Signed means listed by an ok header, whatever the row says. Signed rows are
    // placed first and unsigned after, so table order never decides.
    let mut signed_rows: Vec<(usize, Row)> = vec![];
    let mut unsigned_rows: Vec<(usize, Row)> = vec![];
    for (ti, t) in tables.iter().enumerate() {
        if !s_tables.iter().any(|x| x.name == t.name) {
            continue;
        }
        let m: i64 = c
            .query_row(&format!("SELECT coalesce(max(_r_lc),0) FROM S.\"{}\"", t.name), [], |r| r.get(0))
            .unwrap();
        lc_max = lc_max.max(m);
        for mut r in load(&c, "S", t) {
            let id = rowid(t, &r);
            let key = format!("{}|{}", t.name, id);
            // Signed by a batch refused whole (D159): not taken, and the batch
            // is already reported.
            if spoiled.contains_key(&key) {
                continue;
            }
            // Malformed and signed by nobody: refused in the name it carries.
            if !parents_well_formed(&r.vals[t.i_parents]) {
                let author = match &r.vals[t.i_replica] {
                    V::Blob(x) => x.clone(),
                    _ => vec![],
                };
                let named = t.i_batch.and_then(|b| match &r.vals[b] {
                    V::Blob(x) => Some(hexlc(x)),
                    _ => None,
                });
                refusals.insert((named.unwrap_or_default(), "ROW_MALFORMED".to_string(), hexlc(&author)), author);
                continue;
            }
            // Unsigned: taken only when this copy holds a row at that id in that
            // table already (a duplicate, or a second row at one id); otherwise
            // refused in every table, under the id it carries (BATCH_UNSIGNED,
            // batch format version 2).
            let held_here = |r: &Row| -> bool {
                let rep = match &r.vals[t.i_replica] {
                    V::Blob(x) => rusqlite::types::Value::Blob(x.clone()),
                    _ => rusqlite::types::Value::Null,
                };
                let seq = match &r.vals[t.i_seq] {
                    V::Int(i) => rusqlite::types::Value::Integer(*i),
                    _ => rusqlite::types::Value::Null,
                };
                c.query_row(
                    &format!("SELECT 1 FROM main.\"{}\" WHERE _r_replica = ?1 AND _r_seq = ?2", t.name),
                    rusqlite::params![rep, seq],
                    |_| Ok(()),
                )
                .is_ok()
            };
            let b = match t.i_batch {
                Some(b) => b,
                None => {
                    if held_here(&r) {
                        unsigned_rows.push((ti, r));
                    } else {
                        let author = match &r.vals[t.i_replica] {
                            V::Blob(x) => x.clone(),
                            _ => vec![],
                        };
                        refusals.insert((String::new(), "BATCH_UNSIGNED".to_string(), hexlc(&author)), author);
                    }
                    continue;
                }
            };
            let named = match &r.vals[b] {
                V::Blob(x) => Some(hexlc(x)),
                _ => None,
            };
            if let Some(cover) = covering.get(&key) {
                let keep = match &named {
                    Some(n) if covers.contains(&format!("{}|{}", n, key)) => n.clone(),
                    _ => cover.clone(),
                };
                r.vals[b] = V::Blob(held[&keep].clone());
                signed_rows.push((ti, r));
            } else if let Some(n) = named {
                // It names a header that does not vouch for it: refused in the
                // name of whoever wrote the row; unless the sibling held that
                // header and it was not authentic. "A header refused as
                // ROW_MALFORMED was authentic, so a row naming it that it does
                // not list is reported" (docs/format.md#merge-row-digest-mismatch).
                let refused_already =
                    held.contains_key(&n) && !verdicts.get(&n).map(|v| v == "ok" || v == "incomplete").unwrap_or(false);
                if !refused_already {
                    let author = match &r.vals[t.i_replica] {
                        V::Blob(x) => x.clone(),
                        _ => vec![],
                    };
                    refusals.insert((n, "BATCH_DIGEST_MISMATCH".to_string(), hexlc(&author)), author);
                }
            } else if held_here(&r) {
                unsigned_rows.push((ti, r));
            } else {
                let author = match &r.vals[t.i_replica] {
                    V::Blob(x) => x.clone(),
                    _ => vec![],
                };
                refusals.insert((String::new(), "BATCH_UNSIGNED".to_string(), hexlc(&author)), author);
            }
        }
    }

    let value = |v: &V| match v {
        V::Null => rusqlite::types::Value::Null,
        V::Int(i) => rusqlite::types::Value::Integer(*i),
        V::Real(f) => rusqlite::types::Value::Real(*f),
        V::Text(s) => rusqlite::types::Value::Text(s.clone()),
        V::Blob(b) => rusqlite::types::Value::Blob(b.clone()),
    };
    // The row this copy holds at (author, seq) in a table, if any. By value, not
    // by the arriving row's column positions: the tables differ in layout.
    let held_row = |t: &Table, replica: &V, seq: &V| -> Option<Row> {
        let sel = t.cols.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(",");
        let n = t.cols.len();
        c.query_row(
            &format!("SELECT {} FROM main.\"{}\" WHERE _r_replica = ?1 AND _r_seq = ?2", sel, t.name),
            rusqlite::params![value(replica), value(seq)],
            |x| Ok(Row { vals: (0..n).map(|i| V::from(x.get_ref(i).unwrap())).collect() }),
        )
        .ok()
    };
    let unsigned = |t: &Table, r: &Row| t.i_batch.map(|b| r.vals[b] == V::Null).unwrap_or(true);
    // A signed row outranks an unsigned one at its id: the unsigned one goes, and
    // what it superseded is recomputed below from the row set.
    let displace = |t: &Table, replica: &V, seq: &V| {
        c.execute(
            &format!("DELETE FROM main.\"{}\" WHERE _r_replica = ?1 AND _r_seq = ?2", t.name),
            rusqlite::params![value(replica), value(seq)],
        )
        .unwrap();
    };
    let reject = |id: String, rejected: &mut Vec<String>| {
        if !rejected.contains(&id) {
            rejected.push(id);
        }
    };
    let mut taken: Vec<(usize, String)> = vec![];
    for (rows, signed) in [(signed_rows, true), (unsigned_rows, false)] {
        for (ti, r) in rows {
            let t = &tables[ti];
            let id = rowid(t, &r);
            let (replica, seq) = (r.vals[t.i_replica].clone(), r.vals[t.i_seq].clone());
            // One author's seq names one row, whatever table it is in; the
            // collision is an unsigned row's. An unsigned row at an id another
            // table holds is rejected; a signed row outranks an unsigned one
            // there; two signed rows in two tables are both taken, and are
            // equivocation when their headers' digests differ
            // (docs/format.md#row-one-id, #merge-place-rejected,
            // #merge-signed-outranks).
            let mut refused = false;
            for (oi, o) in tables.iter().enumerate() {
                if oi == ti {
                    continue;
                }
                if let Some(there) = held_row(o, &replica, &seq) {
                    if !signed {
                        refused = true;
                    } else if unsigned(o, &there) {
                        displace(o, &replica, &seq);
                        reject(id.clone(), &mut counts.rejected);
                    }
                }
            }
            if refused {
                reject(id.clone(), &mut counts.rejected);
                continue;
            }
            match held_row(t, &replica, &seq) {
                None => {}
                Some(ex) => {
                    // T1-D11: _r_superseded is not row content, not compared; nor
                    // is _r_batch, which names a batch after the row.
                    let same = r
                        .vals
                        .iter()
                        .enumerate()
                        .all(|(i, v)| i == t.i_superseded || Some(i) == t.i_batch || v.same(&ex.vals[i]));
                    if same {
                        counts.duplicate += 1;
                        // Sealed where this copy still holds it pending: it takes
                        // the seal, once, from NULL.
                        if let Some(b) = t.i_batch {
                            if ex.vals[b] == V::Null && r.vals[b] != V::Null {
                                c.execute(
                                    &format!(
                                        "UPDATE main.\"{}\" SET _r_batch = ?1 WHERE _r_replica = ?2 AND _r_seq = ?3",
                                        t.name
                                    ),
                                    rusqlite::params![value(&r.vals[b]), value(&r.vals[t.i_replica]), value(&r.vals[t.i_seq])],
                                )
                                .unwrap();
                            }
                        }
                        continue;
                    }
                    if signed && unsigned(t, &ex) {
                        displace(t, &replica, &seq);
                        reject(id.clone(), &mut counts.rejected);
                    } else {
                        reject(id.clone(), &mut counts.rejected);
                        continue;
                    }
                }
            }
            let colnames = t.cols.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(",");
            let ph = (1..=t.cols.len()).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
            let params: Vec<rusqlite::types::Value> = r
                .vals
                .iter()
                .enumerate()
                .map(|(i, v)| if i == t.i_superseded { rusqlite::types::Value::Integer(0) } else { value(v) })
                .collect();
            c.execute(
                &format!("INSERT INTO main.\"{}\" ({}) VALUES ({})", t.name, colnames, ph),
                rusqlite::params_from_iter(params.iter()),
            )
            .unwrap();
            counts.applied += 1;
            taken.push((ti, id));
        }
    }

    // T1-D2: supersession is a pure function of the row set, recomputed over all
    // rows: superseded exactly while some row of its own entity names it. A row
    // of another entity naming it hides nothing (T1-D35).
    for t in &tables {
        let all = load(&c, "main", t);
        // A held row whose parents are not the one shape names nothing
        // (docs/format.md#parents-own-malformed).
        let mut parented: BTreeSet<(String, String)> = BTreeSet::new();
        for r in &all {
            let entity = r.vals[t.i_entity].enc();
            for s in admit::parents_of(&r.vals[t.i_parents]) {
                parented.insert((entity.clone(), s));
            }
        }
        for r in &all {
            let id = rowid(t, r);
            let want = if parented.contains(&(r.vals[t.i_entity].enc(), id.clone())) { 1 } else { 0 };
            if r.vals[t.i_superseded] != V::Int(want) {
                c.execute(
                    &format!(
                        "UPDATE main.\"{}\" SET _r_superseded = ?1 WHERE lower(hex(_r_replica))||':'||_r_seq = ?2",
                        t.name
                    ),
                    rusqlite::params![want, id],
                )
                .unwrap();
            }
        }
    }

    // After the rows are placed: what the document now admits, and what this
    // merge made of it.
    let admitted = admit::admit(&c, &tables);
    let batch_of = |t: &Table, id: &str| -> String {
        c.query_row(
            &format!(
                "SELECT lower(hex(_r_batch)) FROM main.\"{}\" WHERE lower(hex(_r_replica))||':'||_r_seq = ?1",
                t.name
            ),
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .unwrap_or_default()
    };
    // A row not admitted, and not merely waiting, void or late, is reported
    // with its author, under its own _r_batch after the merge, when this merge
    // made it true: the row was taken, or, for the two crossings, the parent
    // it crosses to was ("the report is made whichever of the two rows this
    // merge took, the child or the parent, and is the child's";
    // docs/format.md#report-crossing; docs/identity.md binding rule 5).
    let taken_keys: BTreeSet<String> = taken.iter().map(|(ti, id)| format!("{}|{}", tables[*ti].name, id)).collect();
    for (key, v) in &admitted.verdicts {
        let reason = match v {
            admit::Verdict::NotHeld => "SEAT_NOT_HELD",
            admit::Verdict::OtherSession => "ENTITY_OTHER_SESSION",
            _ => continue,
        };
        let Some((tname, id)) = key.split_once('|') else { continue };
        let by_parent = admitted
            .crossings
            .get(key)
            .map(|ps| ps.iter().any(|p| taken_keys.contains(&format!("{}|{}", tname, p))))
            .unwrap_or(false);
        if !taken_keys.contains(key) && !by_parent {
            continue;
        }
        let Some(t) = tables.iter().find(|t| t.name == tname) else { continue };
        let author = id.split(':').next().unwrap_or("").to_string();
        let raw: Vec<u8> = (0..author.len() / 2)
            .map(|i| u8::from_str_radix(&author[2 * i..2 * i + 2], 16).unwrap_or(0))
            .collect();
        refusals.insert((batch_of(t, id), reason.to_string(), author), raw);
    }
    // AUTHOR_EQUIVOCATED, once per author per merge, when this merge revealed
    // that author signing twice, filed under the lowest of that author's
    // revealing headers (docs/format.md#equivocated-filed, D171):
    let mut accused: BTreeMap<String, String> = BTreeMap::new(); // author hex -> batch id
    let mut accuse = |author: String, batch: String| {
        let e = accused.entry(author).or_insert_with(|| batch.clone());
        if batch < *e {
            *e = batch;
        }
    };
    // D160: a header this merge kept that the local copy did not hold before,
    // which lists, in any table, a seq of its author whose id is equivocated
    // after the merge and was not before (docs/format.md#revealing-two-headers).
    // Compared by id, (author, seq): a header listing an id already
    // equivocated in another table reveals nothing new
    // (docs/format.md#equivocated-third).
    let ids_before = admit::ids(&eq_before);
    for (author, seq) in admit::ids(&admitted.equivocated).difference(&ids_before) {
        let suffix = format!("|{}:{}", author, seq);
        for (hid, keys) in &lists {
            if !held_before.contains(hid) && keys.iter().any(|k| k.ends_with(&suffix)) {
                accuse(author.clone(), hid.clone());
            }
        }
    }
    // D165: the header named (_r_batch) by a row this merge took that the void
    // rests on, a counting confirm of that seat or the session's creator's seat
    // row, for a seat void after the merge and not before it.
    for (sess, seat, cr) in admitted.voided.difference(&voided_before) {
        for (tname, id) in admitted.void_rests.get(&(sess.clone(), seat.clone())).into_iter().flatten() {
            if !taken_keys.contains(&format!("{}|{}", tname, id)) {
                continue;
            }
            let Some(t) = tables.iter().find(|t| &t.name == tname) else { continue };
            let b = batch_of(t, id);
            if !b.is_empty() {
                accuse(cr.clone(), b);
            }
        }
    }
    for (author, batch) in accused {
        let raw: Vec<u8> = (0..author.len() / 2)
            .map(|i| u8::from_str_radix(&author[2 * i..2 * i + 2], 16).unwrap_or(0))
            .collect();
        refusals.insert((batch, "AUTHOR_EQUIVOCATED".to_string(), author), raw);
    }
    let admitted_text = admit::render(&admitted);

    let ids: Vec<Vec<u8>> = {
        let mut st = c
            .prepare("SELECT id FROM S._dai_replicas UNION SELECT id FROM S._dai_replica")
            .unwrap();
        let v = st
            .query_map([], |r| r.get::<_, Vec<u8>>(0))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        v
    };
    for id in ids {
        // label is NOT propagated (T1-D12); first_seen is the local Lamport value at first sight.
        let n = c
            .execute(
                "INSERT OR IGNORE INTO main._dai_replicas (id, label, first_seen) VALUES (?1, NULL, ?2)",
                rusqlite::params![id, local_lc],
            )
            .unwrap();
        counts.new_replicas += n as i64;
    }

    c.execute("UPDATE main._dai_replica SET lc = ?1", [lc_max])
        .unwrap();
    c.execute_batch("COMMIT").unwrap();
    counts.refused = refusals
        .into_iter()
        .map(|((_, reason, _), author)| (shown(&author), reason))
        .collect();

    let mut out = String::new();
    for t in &tables {
        out.push_str(&format!("# {}\n", t.name));
        let sel = t
            .cols
            .iter()
            .map(|x| format!("\"{}\"", x))
            .collect::<Vec<_>>()
            .join(",");
        let mut st = c
            .prepare(&format!(
                "SELECT {} FROM main.\"{}\" ORDER BY lower(hex(_r_replica)) ASC, _r_seq ASC",
                sel, t.name
            ))
            .unwrap();
        let n = t.cols.len();
        let rows: Vec<Vec<String>> = st
            .query_map([], |r| {
                Ok((0..n)
                    .map(|i| V::from(r.get_ref(i).unwrap()).enc())
                    .collect())
            })
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        for r in rows {
            out.push_str(&r.join("\t"));
            out.push('\n');
        }
    }
    out.push_str("# _dai_replicas\n");
    {
        let mut st = c.prepare("SELECT id FROM main._dai_replicas").unwrap();
        let mut v: Vec<String> = st
            .query_map([], |r| Ok(hexlc(&r.get::<_, Vec<u8>>(0)?)))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        v.sort();
        for x in v {
            out.push_str(&x);
            out.push('\n');
        }
    }
    let has_batch: i64 = c
        .query_row(
            "SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name='_dai_batch'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_batch > 0 {
        out.push_str("# _dai_batch\n");
        let mut st = c
            .prepare("SELECT id, author, lc, sig, pub, att, version, digest, covers FROM main._dai_batch ORDER BY hex(id) ASC")
            .unwrap();
        let rows: Vec<String> = st
            .query_map([], |r| {
                Ok((0..9)
                    .map(|i| V::from(r.get_ref(i).unwrap()).enc())
                    .collect::<Vec<_>>()
                    .join("\t"))
            })
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        for line in rows {
            out.push_str(&line);
            out.push('\n');
        }
    }
    (counts, out, admitted_text)
}

// The expected refusedBatches as (author, reason) pairs; None when misshapen, which fails.
fn refused_of(v: &serde_json::Value) -> Option<Vec<(String, String)>> {
    v.as_array()?
        .iter()
        .map(|x| Some((x["author"].as_str()?.to_string(), x["reason"].as_str()?.to_string())))
        .collect()
}

fn main() {
    let dir = std::env::args().nth(1).expect("fixture root");
    let tmp = std::env::temp_dir().join("dai-merge-work");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();

    let mut fixtures: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            if p.is_dir() && p.join("a.db").exists() {
                Some(p)
            } else {
                None
            }
        })
        .collect();
    fixtures.sort();

    let mut fail = false;
    for f in fixtures {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let expect: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(f.join("result.json")).unwrap()).unwrap();
        let mut problems: Vec<String> = vec![];

        // The record's shape, against the schema shipped beside the fixtures.
        //
        // Checked by this reader rather than by whatever wrote the fixtures: a
        // generator validating its own output can only confirm it agrees with
        // itself, and a field and the check that wanted it can be removed by
        // one edit. A check that can be deleted by the same motion that
        // deletes what it checks is not a check.
        //
        // A malformed record fails rather than being skipped. A vector this
        // reader cannot understand is a vector it is not checking, and a
        // silent skip reads exactly like a pass.
        let schema_path = f.parent().unwrap().join("schema.json");
        match std::fs::read_to_string(&schema_path) {
            Err(_) => problems.push(
                "conformance/merge/schema.json is missing; nothing defines what a vector must carry"
                    .to_string(),
            ),
            Ok(text) => {
                let schema: serde_json::Value = serde_json::from_str(&text).unwrap();
                if let Some(required) = schema["required"].as_object() {
                    for field in required.keys() {
                        if expect.get(field).is_none() {
                            problems.push(format!("result.json has no {:?}, which the schema requires", field));
                        }
                    }
                }
                if let Some(cites) = expect["cites"].as_array() {
                    if cites.is_empty() {
                        problems.push(
                            "cites is empty; a vector nobody can trace to the document is a rule the suite invented"
                                .to_string(),
                        );
                    }
                }
                if let Some(required) = schema["requiredInResult"].as_object() {
                    for dirn in ["ab", "ba"] {
                        if let Some(block) = expect.get(dirn) {
                            for field in required.keys() {
                                if block.get(field).is_none() {
                                    problems.push(format!("{} has no {:?}, which the schema requires", dirn, field));
                                }
                            }
                        }
                    }
                }
            }
        }
        // The signature check's answer for every header (README, Verdicts).
        // Required: a vector without it is one nothing checked.
        // Per copy: B into A reads b's verdicts, A into B reads a's.
        let verdicts: BTreeMap<String, BTreeMap<String, String>> = match std::fs::read_to_string(f.join("verdicts.json")) {
            Err(_) => {
                problems.push("verdicts.json is missing".to_string());
                BTreeMap::new()
            }
            Ok(text) => serde_json::from_str::<BTreeMap<String, BTreeMap<String, String>>>(&text).unwrap(),
        };
        // The list that made a header authentic where it is not the stored one
        // (lists.json, only where a vector has one), per copy as verdicts are.
        let lists: BTreeMap<String, BTreeMap<String, String>> = match std::fs::read_to_string(f.join("lists.json")) {
            Err(_) => BTreeMap::new(),
            Ok(text) => serde_json::from_str::<BTreeMap<String, BTreeMap<String, String>>>(&text).unwrap(),
        };
        for (dirn, base, sib, exp) in [
            ("ab", "a.db", "b.db", "expected-ab.txt"),
            ("ba", "b.db", "a.db", "expected-ba.txt"),
        ] {
            let work = tmp.join(format!("{}-{}.db", name, dirn));
            std::fs::copy(f.join(base), &work).unwrap();
            let theirs = verdicts.get(sib.trim_end_matches(".db")).cloned().unwrap_or_default();
            let their_lists = lists.get(sib.trim_end_matches(".db")).cloned().unwrap_or_default();
            let (c, dump, admitted) = merge(&work, &f.join(sib), &theirs, &their_lists);
            let want = std::fs::read_to_string(f.join(exp))
                .unwrap()
                .replace("\r\n", "\n");
            if dump != want {
                problems.push(format!(
                    "{}: dump mismatch\n--- got\n{}--- want\n{}",
                    dirn, dump, want
                ));
            }
            // What the document admits after the merge (README, "What a session
            // document admits"). A vector that says it ships this and does not
            // is a failure, not a skip; so is a flag that is not a boolean.
            match expect["admitted"].as_bool() {
                Some(true) => {
                    let file = format!("expected-admitted-{}.txt", dirn);
                    match std::fs::read_to_string(f.join(&file)) {
                        Err(_) => problems.push(format!("{} is missing, and result.json says admitted", file)),
                        Ok(text) => {
                            let want = text.replace("\r\n", "\n");
                            if admitted != want {
                                problems.push(format!(
                                    "{}: admitted mismatch\n--- got\n{}--- want\n{}",
                                    dirn, admitted, want
                                ));
                            }
                        }
                    }
                }
                Some(false) => {}
                None => problems.push("result.json's admitted is not a boolean".to_string()),
            }
            let e = &expect[dirn];
            let er: Vec<String> = e["rejected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect();
            if e["applied"].as_i64() != Some(c.applied)
                || e["duplicate"].as_i64() != Some(c.duplicate)
                || e["newReplicas"].as_i64() != Some(c.new_replicas)
                || er != c.rejected
                || refused_of(&e["refusedBatches"]) != Some(c.refused.clone())
            {
                problems.push(format!(
                    "{}: counts got applied={} duplicate={} newReplicas={} rejected={:?} refusedBatches={:?}, want {}",
                    dirn, c.applied, c.duplicate, c.new_replicas, c.rejected, c.refused, e
                ));
            }
        }
        if problems.is_empty() {
            println!("PASS {}", name);
        } else {
            fail = true;
            println!("FAIL {}", name);
            for p in problems {
                println!("  {}", p);
            }
        }
    }
    if fail {
        std::process::exit(1);
    }
}
