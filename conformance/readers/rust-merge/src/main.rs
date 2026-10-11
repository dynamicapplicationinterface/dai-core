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
    // The shortest digits d1..dk and n with 0.d1..dk x 10^n reading back as
    // the same double, placed by docs/format.md#dump-real. Rust's `{:e}` gives
    // the shortest round-tripping digits, nearest the value, as d1.d2..dk e(n-1).
    let sign = if f < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", f.abs());
    let (mant, exp) = sci.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let digits = digits.trim_end_matches('0').to_string();
    let digits = if digits.is_empty() { "0".to_string() } else { digits };
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}.0", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n < k {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        format!(
            "{}{}e{}{}",
            &digits[..1],
            if k > 1 { format!(".{}", &digits[1..]) } else { String::new() },
            if e >= 0 { "+" } else { "-" },
            e.abs()
        )
    };
    format!("{}{}", sign, body)
}

fn hexlc(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// An author id as a person is shown it: base64url, no padding.
// (docs/format.md#conv-hex)
fn shown(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for ch in b.chunks(3) {
        let n = ch.len();
        let v = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        let digits = [(v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63];
        for d in digits.iter().take(n + 1) {
            out.push(A[*d as usize] as char);
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

// The tables a merge takes. A bare database carries no manifest, so a table
// carrying `_r_replica` and `_r_seq` is replicated (replicated-tables.md
// T1-D18); in a session document that includes the roster tables and the
// close (docs/format.md#merge-whole-refusals). In UTF-8 order of name
// (docs/format.md#dump-tables).
fn replicated_tables(c: &Connection, schema: &str) -> Vec<Table> {
    let mut st = c
        .prepare(&format!("SELECT name FROM {}.sqlite_master WHERE type='table'", schema))
        .unwrap();
    let mut names: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let mut out = vec![];
    for name in names {
        let cols = table_cols(c, schema, &name);
        let pos = |k: &str| cols.iter().position(|x| x == k);
        let (Some(i_replica), Some(i_seq)) = (pos("_r_replica"), pos("_r_seq")) else { continue };
        let need = |k: &str| pos(k).unwrap_or_else(|| panic!("{}.{} has no {}", schema, name, k));
        out.push(Table {
            i_replica,
            i_seq,
            i_entity: need("_r_entity"),
            i_parents: need("_r_parents"),
            i_superseded: need("_r_superseded"),
            i_deleted: need("_r_deleted"),
            i_session: pos("_r_session"),
            i_batch: pos("_r_batch"),
            name,
            cols,
        });
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
    // Text (#parents-shape; not text is #parents-malformed).
    let V::Text(t) = v else { return false };
    // Parses as JSON to an array (#parents-shape, #parents-malformed).
    let Ok(serde_json::Value::Array(a)) = serde_json::from_str::<serde_json::Value>(t) else {
        return false;
    };
    // At most 256 elements; empty is the shape (#parents-shape, #parents-empty).
    if a.len() > PARENTS_CAP {
        return false;
    }
    // Each element a string `^[0-9a-f]{32}:[1-9][0-9]{0,15}$`, seq at most
    // 2^53 - 1 (#parents-shape, #conv-row-id). Order and repeats unchecked
    // (#parents-order-unchecked).
    a.iter().all(|e| {
        let Some(s) = e.as_str() else { return false };
        let Some((h, q)) = s.split_once(':') else { return false };
        h.len() == 32
            && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            && (1..=16).contains(&q.len())
            && q.bytes().all(|c| c.is_ascii_digit())
            && !q.starts_with('0')
            && q.parse::<u64>().map_or(false, |n| n <= 9007199254740991)
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
    let c = Connection::open(work).unwrap();
    disarm(&c);
    c.execute("ATTACH DATABASE ?1 AS S", [sibling.to_string_lossy().as_ref()]).unwrap();
    let tables = replicated_tables(&c, "main");
    let mut counts = Counts {
        applied: 0,
        duplicate: 0,
        rejected: vec![],
        new_replicas: 0,
        refused: vec![],
        refused_whole: None,
    };

    // Refused whole, in this order, before anything is taken
    // (docs/format.md#merge-whole-refusals, #document-mismatch). The
    // replication level (UNSUPPORTED_LEVEL) is in the signed manifest, which a
    // fixture does not carry (manifest.json gives only `view` and `session`),
    // and with no manifest every table carrying `_r_replica` and `_r_seq` is one
    // a merge takes (T1-D18), so MERGE_COVERAGE cannot arise here.
    let sib_tables = replicated_tables(&c, "S");
    let whole = if tables.is_empty() && sib_tables.is_empty() {
        Some("NOT_REPLICATED")
    } else if schema_lines(&c, "main", &tables, true) != schema_lines(&c, "S", &sib_tables, true) {
        Some("SCHEMA_MISMATCH")
    } else if view_mismatch {
        Some("SIGNED_VIEW_MISMATCH")
    } else {
        None
    };
    if let Some(w) = whole {
        counts.refused_whole = Some(w.to_string());
        let d = dump(&c, &tables);
        let a = admit::render(&admission(&c, &tables, max_parties));
        c.execute("DETACH DATABASE S", []).unwrap();
        return (counts, d, a);
    }

    // The state before the merge, for what this merge makes true
    // (docs/format.md#report-made-true, #equivocated-report).
    let before = admission(&c, &tables, max_parties);
    let held_headers_before: BTreeSet<String> = headers(&c, "main").into_iter().map(|h| h.id).collect();
    let lc_before: i64 = c
        .query_row("SELECT lc FROM main._dai_replica", [], |r| r.get(0))
        .unwrap_or(0);

    c.execute("BEGIN", []).unwrap();

    // _dai_replicas: the sibling's own id and those its _dai_replicas lists
    // (docs/format.md#merge-counts; replicated-tables.md §6, T1-D19).
    {
        let mut ids: BTreeSet<Vec<u8>> = BTreeSet::new();
        for q in ["SELECT id FROM S._dai_replica", "SELECT id FROM S._dai_replicas"] {
            if let Ok(mut st) = c.prepare(q) {
                for v in st.query_map([], |r| r.get::<_, Vec<u8>>(0)).unwrap() {
                    ids.insert(v.unwrap());
                }
            }
        }
        for id in ids {
            let held: i64 = c
                .query_row("SELECT count(*) FROM main._dai_replicas WHERE id = ?1", [&id], |r| r.get(0))
                .unwrap();
            if held == 0 {
                c.execute(
                    "INSERT INTO main._dai_replicas (id, label, first_seen, rows_seen) VALUES (?1, NULL, ?2, 0)",
                    rusqlite::params![id, lc_before],
                )
                .unwrap();
                counts.new_replicas += 1;
            }
        }
    }

    // The sibling's rows, by (table, author hex, seq).
    let sib_rows: BTreeMap<String, Vec<Row>> = tables.iter().map(|t| (t.name.clone(), load(&c, "S", t))).collect();
    let mut sib_index: BTreeMap<(String, String, i64), (usize, usize)> = BTreeMap::new();
    for (ti, t) in tables.iter().enumerate() {
        for (ri, r) in sib_rows[&t.name].iter().enumerate() {
            sib_index.insert((t.name.clone(), author_hex(t, r), seq_of(t, r)), (ti, ri));
        }
    }

    // refusals before sorting: (batch id hex or none, code, author hex)
    let mut refusals: BTreeSet<(Option<String>, String, String)> = BTreeSet::new();

    // 1. Headers, in batch id order (docs/format.md#merge-headers).
    let sib_headers = headers(&c, "S");
    // header id -> what it is, for the rows step
    let mut complete: BTreeMap<String, (String, BTreeSet<(String, i64)>)> = BTreeMap::new();
    let mut refused_malformed: BTreeMap<String, (String, BTreeSet<(String, i64)>)> = BTreeMap::new();
    let mut not_authentic: BTreeSet<String> = BTreeSet::new();
    let mut kept_new: Vec<(String, String, BTreeSet<(String, i64)>)> = vec![];
    for h in &sib_headers {
        // A header missing from the verdicts was not checked, and a header
        // not checked is not signed.
        let verdict = verdicts.get(&h.id).map(|s| s.as_str()).unwrap_or("BATCH_SIGNATURE_INVALID");
        if verdict != "ok" && verdict != "incomplete" {
            // Not authentic: refused in the name of the author it names, under
            // its own id, and not kept (docs/format.md#verify-refused,
            // #code-signature-invalid).
            refusals.insert((Some(h.id.clone()), verdict.to_string(), h.author.clone()));
            not_authentic.insert(h.id.clone());
            continue;
        }
        // Kept under the list it signed, the one that made it authentic
        // (docs/format.md#merge-headers-kept-list; lists.json).
        let signed = signed_lists.get(&h.id).cloned().unwrap_or_else(|| h.covers.clone());
        let list = parse_covers(&signed);
        if verdict == "ok" {
            // An authentic, complete header that lists a malformed row is
            // refused ROW_MALFORMED and not kept (docs/format.md#merge-headers-malformed).
            let malformed = list.iter().any(|(tn, s)| {
                sib_index
                    .get(&(tn.clone(), h.author.clone(), *s))
                    .map(|(ti, ri)| !parents_ok(&tables[*ti], &sib_rows[&tables[*ti].name][*ri]))
                    .unwrap_or(false)
            });
            if malformed {
                refusals.insert((Some(h.id.clone()), "ROW_MALFORMED".into(), h.author.clone()));
                refused_malformed.insert(h.id.clone(), (h.author.clone(), list.clone()));
                continue;
            }
            complete.insert(h.id.clone(), (h.author.clone(), list.clone()));
        }
        // Kept, complete or not (docs/format.md#merge-headers-kept); one held
        // already is rewritten to the list it signed (#merge-headers-rewritten).
        if held_headers_before.contains(&h.id) {
            c.execute(
                "UPDATE main._dai_batch SET covers = ?1 WHERE hex(id) = upper(?2)",
                rusqlite::params![signed, h.id],
            )
            .unwrap();
        } else {
            c.execute(
                "INSERT INTO main._dai_batch (id, author, lc, sig, pub, att, version, digest, covers)
                 SELECT id, author, lc, sig, pub, att, version, digest, ?1 FROM S._dai_batch WHERE hex(id) = upper(?2)",
                rusqlite::params![signed, h.id],
            )
            .unwrap();
            kept_new.push((h.id.clone(), h.author.clone(), list.clone()));
        }
    }
    let lists_of = |m: &BTreeMap<String, (String, BTreeSet<(String, i64)>)>, tn: &str, a: &str, s: i64| -> Vec<String> {
        m.iter()
            .filter(|(_, (au, l))| au == a && l.contains(&(tn.to_string(), s)))
            .map(|(id, _)| id.clone())
            .collect()
    };

    // A held row with `_r_batch` unset that a complete header the copy held
    // before the merge lists (its table, its author, its seq) is signed: its
    // `_r_batch` is set to the lowest such header before any row is placed.
    // Complete is over the copy's own rows (own_verdicts, own_lists)
    // (docs/format.md#merge-row-held-signed).
    {
        let mut own_complete: BTreeMap<String, (String, BTreeSet<(String, i64)>)> = BTreeMap::new();
        for h in headers(&c, "main") {
            if !held_headers_before.contains(&h.id) || own_verdicts.get(&h.id).map(|s| s.as_str()) != Some("ok") {
                continue;
            }
            let l = own_lists.get(&h.id).cloned().unwrap_or(h.covers.clone());
            own_complete.insert(h.id.clone(), (h.author.clone(), parse_covers(&l)));
        }
        for t in &tables {
            let Some(ib) = t.i_batch else { continue };
            for r in load(&c, "main", t) {
                if r.vals[ib] != V::Null {
                    continue;
                }
                let ids = lists_of(&own_complete, &t.name, &author_hex(t, &r), seq_of(t, &r));
                if let Some(low) = ids.iter().min() {
                    set_batch(&c, t, &r, Some(low));
                }
            }
        }
    }

    // 2. Rows (docs/format.md#merge-rows).
    let held_now = |c: &Connection, t: &Table, a: &str, s: i64| -> Option<Row> {
        local_row(c, t, a, s)
    };
    // (table index, row index, batch the row takes)
    let mut signed_rows: Vec<(usize, usize, String)> = vec![];
    let mut unsigned_rows: Vec<(usize, usize)> = vec![];
    for (ti, t) in tables.iter().enumerate() {
        for (ri, r) in sib_rows[&t.name].iter().enumerate() {
            let a = author_hex(t, r);
            let s = seq_of(t, r);
            let named = t.i_batch.and_then(|ib| match &r.vals[ib] {
                V::Blob(b) => Some(hexlc(b)),
                _ => None,
            });
            let author = a.clone();
            let in_malformed_refused = !lists_of(&refused_malformed, &t.name, &a, s).is_empty();
            if !parents_ok(t, r) {
                // Not taken; reported under the batch it names, in its
                // author's name, unless a header that listed it was refused
                // for it already (docs/format.md#merge-row-malformed).
                if !in_malformed_refused {
                    refusals.insert((named.clone(), "ROW_MALFORMED".into(), author.clone()));
                }
                continue;
            }
            let listing = lists_of(&complete, &t.name, &a, s);
            if !listing.is_empty() {
                // Signed; its `_r_batch` is the header it names if that one
                // is complete, kept and lists it, else the lowest that does
                // (docs/format.md#merge-row-signed, #merge-row-batch).
                let b = match &named {
                    Some(n) if listing.contains(n) => n.clone(),
                    _ => listing.iter().min().unwrap().clone(),
                };
                signed_rows.push((ti, ri, b));
                continue;
            }
            if in_malformed_refused {
                // Listed only by a header refused as ROW_MALFORMED
                // (docs/format.md#merge-row-refused-header).
                continue;
            }
            if let Some(n) = &named {
                // Names a header and no complete one lists it, unless the
                // sibling held that header and it was not authentic
                // (docs/format.md#merge-row-digest-mismatch).
                if !not_authentic.contains(n) {
                    refusals.insert((Some(n.clone()), "BATCH_DIGEST_MISMATCH".into(), author.clone()));
                }
                continue;
            }
            // Unsigned: refused, unless the copy holds a row at that id in
            // that table, when placing decides (docs/format.md#merge-row-unsigned,
            // #row-one-id).
            if held_now(&c, t, &a, s).is_some() {
                unsigned_rows.push((ti, ri));
            } else {
                refusals.insert((None, "BATCH_UNSIGNED".into(), author.clone()));
            }
        }
    }

    // 3. Placing, signed rows first (docs/format.md#merge-place).
    let mut rejected: BTreeSet<String> = BTreeSet::new();
    // (table, id) -> the batch it took, for each row this merge inserted
    let mut taken: BTreeMap<(String, String), Option<String>> = BTreeMap::new();
    for (ti, ri, b) in &signed_rows {
        let t = &tables[*ti];
        let r = &sib_rows[&t.name][*ri];
        let a = author_hex(t, r);
        let s = seq_of(t, r);
        let id = format!("{}:{}", a, s);
        let mut place = true;
        if let Some(h) = held_now(&c, t, &a, s) {
            let held_unsigned = t.i_batch.map(|ib| h.vals[ib] == V::Null).unwrap_or(false);
            if same_content(t, &h, r) {
                // A duplicate; a held row with `_r_batch` unset takes the
                // arriving row's (docs/format.md#merge-row-held-signed).
                counts.duplicate += 1;
                if held_unsigned {
                    set_batch(&c, t, &h, Some(b));
                }
                place = false;
            } else if held_unsigned {
                // A signed row outranks an unsigned one at its id
                // (docs/format.md#merge-signed-outranks).
                delete_row(&c, t, &a, s);
                rejected.insert(id.clone());
            } else {
                // A second row at one id (docs/format.md#merge-place-rejected).
                rejected.insert(id.clone());
                place = false;
            }
        }
        if !place {
            continue;
        }
        // Whatever table the unsigned one is in
        // (docs/format.md#merge-signed-outranks-any-table); a signed row in
        // another table is another row, and both are taken (#row-one-id).
        for t2 in &tables {
            if t2.name == t.name {
                continue;
            }
            if let Some(h2) = held_now(&c, t2, &a, s) {
                if t2.i_batch.map(|ib| h2.vals[ib] == V::Null).unwrap_or(false) {
                    delete_row(&c, t2, &a, s);
                    rejected.insert(id.clone());
                }
            }
        }
        insert_row(&c, t, r, Some(b));
        counts.applied += 1;
        taken.insert((t.name.clone(), id), Some(b.clone()));
    }
    for (ti, ri) in &unsigned_rows {
        let t = &tables[*ti];
        let r = &sib_rows[&t.name][*ri];
        let a = author_hex(t, r);
        let s = seq_of(t, r);
        let id = format!("{}:{}", a, s);
        // An unsigned row at an id another table holds is rejected
        // (docs/format.md#merge-place-rejected, #row-one-id).
        let elsewhere = tables.iter().any(|t2| t2.name != t.name && held_now(&c, t2, &a, s).is_some());
        match held_now(&c, t, &a, s) {
            _ if elsewhere => {
                rejected.insert(id);
            }
            Some(h) if same_content(t, &h, r) => counts.duplicate += 1,
            Some(_) => {
                rejected.insert(id);
            }
            None => {
                // Not reached: placing only ever replaces a row at this id.
                rejected.insert(id);
            }
        }
    }
    // Each id once, ordered by the author in lowercase hex, then the seq
    // compared as a number, `…:9` before `…:10` (docs/format.md#report-set).
    let mut rejected: Vec<String> = rejected.into_iter().collect();
    rejected.sort_by_key(|id| {
        let (a, s) = id.rsplit_once(':').unwrap_or((id.as_str(), ""));
        (a.to_string(), s.parse::<i64>().unwrap_or(0))
    });
    counts.rejected = rejected;

    // The Lamport clock only advances (replicated-tables.md §6).
    {
        let mut lc_max = lc_before;
        if let Ok(v) = c.query_row("SELECT lc FROM S._dai_replica", [], |r| r.get::<_, i64>(0)) {
            lc_max = lc_max.max(v);
        }
        for t in &tables {
            if let Ok(Some(v)) = c.query_row(&format!("SELECT max(_r_lc) FROM S.\"{}\"", t.name), [], |r| {
                r.get::<_, Option<i64>>(0)
            }) {
                lc_max = lc_max.max(v);
            }
        }
        let _ = c.execute("UPDATE main._dai_replica SET lc = ?1", [lc_max]);
    }
    c.execute("COMMIT", []).unwrap();

    // 4. Reports, from the row set after placing (docs/format.md#merge-reports).
    let after = admission(&c, &tables, max_parties);
    let batch_now = |tn: &str, id: &str| -> Option<String> {
        let t = tables.iter().find(|t| t.name == tn)?;
        let (a, s) = id.split_once(':')?;
        let r = local_row(&c, t, a, s.parse().ok()?)?;
        match &r.vals[t.i_batch?] {
            V::Blob(b) => Some(hexlc(b)),
            _ => None,
        }
    };

    // SEAT_NOT_HELD and ENTITY_OTHER_SESSION: about a row this merge took, or
    // released from waiting on a parent, or the child of a crossing whose
    // parent this merge took; the report is the child's
    // (docs/format.md#report-made-true, #seat-not-held, #entity-other-session,
    // #report-crossing). A row the admission leaves silent is reported
    // nowhere (#report-silent).
    let mut candidates: BTreeSet<String> = BTreeSet::new();
    for (tn, id) in taken.keys() {
        candidates.insert(format!("{}|{}", tn, id));
    }
    for (k, v) in &before.verdicts {
        if *v == admit::Verdict::WaitingParent
            && after.verdicts.get(k).map(|x| *x != admit::Verdict::WaitingParent).unwrap_or(false)
        {
            candidates.insert(k.clone());
        }
    }
    for (k, ps) in &after.crossings {
        let tn = k.split('|').next().unwrap_or("");
        if ps.iter().any(|p| taken.contains_key(&(tn.to_string(), p.clone()))) {
            candidates.insert(k.clone());
        }
    }
    for k in &candidates {
        let code = match after.verdicts.get(k) {
            Some(admit::Verdict::NotHeld) => "SEAT_NOT_HELD",
            Some(admit::Verdict::OtherSession) => "ENTITY_OTHER_SESSION",
            _ => continue,
        };
        let (tn, id) = k.split_once('|').unwrap();
        let author = id.split(':').next().unwrap().to_string();
        refusals.insert((batch_now(tn, id), code.into(), author));
    }

    // AUTHOR_EQUIVOCATED, once per author, filed under the lowest of his
    // revealing headers of all three kinds, or under no id when there is none
    // (docs/format.md#equivocated-report, #equivocated-filed).
    let mut revealed: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    // Two headers at one id: a header this merge kept that the copy did not
    // hold, listing a seq of its author newly equivocated
    // (#revealing-two-headers). A third header reveals nothing new
    // (#equivocated-third).
    let eq_before = admit::ids(&before.equivocated);
    let eq_after = admit::ids(&after.equivocated);
    let newly: BTreeSet<(String, i64)> = eq_after.difference(&eq_before).cloned().collect();
    for (a, _) in &newly {
        revealed.entry(a.clone()).or_default();
    }
    for (id, a, list) in &kept_new {
        if list.iter().any(|(_, s)| newly.contains(&(a.clone(), *s))) {
            revealed.entry(a.clone()).or_default().insert(id.clone());
        }
    }
    // A close followed by a row, newly true (#close-monotone, #revealing-close).
    let mut session_of_taken: BTreeMap<(String, String), (String, i64, String)> = BTreeMap::new();
    for ((tn, id), _) in &taken {
        let t = tables.iter().find(|t| &t.name == tn).unwrap();
        let Some(is) = t.i_session else { continue };
        let (a, s) = id.split_once(':').unwrap();
        if let Some(r) = local_row(&c, t, a, s.parse().unwrap()) {
            let sess = match &r.vals[is] {
                V::Blob(b) => hexlc(b),
                v => v.enc(),
            };
            session_of_taken.insert((tn.clone(), id.clone()), (a.to_string(), s.parse().unwrap(), sess));
        }
    }
    for (a, sessions) in &after.close_after {
        for (sess, q) in sessions {
            if before.close_after.get(a).map(|m| m.contains_key(sess)).unwrap_or(false) {
                continue;
            }
            let e = revealed.entry(a.clone()).or_default();
            for ((tn, id), (ra, rs, rsess)) in &session_of_taken {
                if ra == a && rsess == sess && (tn == "_dai_close" || rs > q) {
                    if let Some(Some(b)) = taken.get(&(tn.clone(), id.clone())) {
                        e.insert(b.clone());
                    }
                }
            }
        }
    }
    // Two confirms of one seat, newly true: the header named by a row this
    // merge took that the void rests on (#revealing-two-confirms, #void-rests-on).
    for k in after.void_two.difference(&before.void_two) {
        let Some(rests) = after.void_rests.get(k) else { continue };
        // The void accuses the session's creator, whose seat row it rests on.
        let creator = rests
            .iter()
            .find(|(tn, _)| tn == "_dai_seat")
            .map(|(_, id)| id.split(':').next().unwrap().to_string());
        let Some(creator) = creator else { continue };
        let e = revealed.entry(creator).or_default();
        for (tn, id) in rests {
            if let Some(Some(b)) = taken.get(&(tn.clone(), id.clone())) {
                e.insert(b.clone());
            }
        }
    }
    for (a, hs) in revealed {
        refusals.insert((hs.iter().next().cloned(), "AUTHOR_EQUIVOCATED".into(), a));
    }

    // Ordered by the batch id it is filed under (no id first), then code,
    // then author id in hex (docs/format.md#report-order).
    let mut ordered: Vec<(Option<String>, String, String)> = refusals.into_iter().collect();
    ordered.sort_by(|x, y| (x.0.is_some(), &x.0, &x.1, &x.2).cmp(&(y.0.is_some(), &y.0, &y.1, &y.2)));
    counts.refused = ordered
        .into_iter()
        .map(|(_, code, a)| (shown(&unhex(&a)), code))
        .collect();

    let d = dump(&c, &tables);
    let adm = admit::render(&after);
    c.execute("DETACH DATABASE S", []).unwrap();
    (counts, d, adm)
}

// A stored header, as a merge reads it.
struct Header {
    id: String,
    author: String,
    covers: String,
}

fn headers(c: &Connection, schema: &str) -> Vec<Header> {
    let Ok(mut st) = c.prepare(&format!("SELECT id, author, covers FROM {}._dai_batch ORDER BY id", schema)) else {
        return vec![];
    };
    let v: Vec<Header> = st
        .query_map([], |r| {
            let id = V::from(r.get_ref(0)?);
            let au = V::from(r.get_ref(1)?);
            let cv = V::from(r.get_ref(2)?);
            Ok(Header {
                id: id.enc(),
                author: au.enc(),
                covers: match cv {
                    V::Text(t) => t,
                    v => v.enc(),
                },
            })
        })
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    v
}

// A list: `[table, seq]` pairs (docs/format.md#covers-spelling). What does
// not parse lists nothing.
fn parse_covers(s: &str) -> BTreeSet<(String, i64)> {
    let mut out = BTreeSet::new();
    if let Ok(serde_json::Value::Array(a)) = serde_json::from_str::<serde_json::Value>(s) {
        for p in a {
            if let (Some(t), Some(q)) = (p.get(0).and_then(|x| x.as_str()), p.get(1).and_then(|x| x.as_i64())) {
                out.insert((t.to_string(), q));
            }
        }
    }
    out
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn author_hex(t: &Table, r: &Row) -> String {
    match &r.vals[t.i_replica] {
        V::Blob(b) => hexlc(b),
        v => v.enc(),
    }
}

fn seq_of(t: &Table, r: &Row) -> i64 {
    match &r.vals[t.i_seq] {
        V::Int(i) => *i,
        _ => 0,
    }
}

fn to_sql(v: &V) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match v {
        V::Null => Value::Null,
        V::Int(i) => Value::Integer(*i),
        V::Real(f) => Value::Real(*f),
        V::Text(t) => Value::Text(t.clone()),
        V::Blob(b) => Value::Blob(b.clone()),
    }
}

// The row the copy holds at (author, seq) in one table.
fn local_row(c: &Connection, t: &Table, a: &str, s: i64) -> Option<Row> {
    let sel = t.cols.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(",");
    let n = t.cols.len();
    c.query_row(
        &format!("SELECT {} FROM main.\"{}\" WHERE _r_replica = ?1 AND _r_seq = ?2", sel, t.name),
        rusqlite::params![unhex(a), s],
        |r| {
            Ok(Row {
                vals: (0..n).map(|i| V::from(r.get_ref(i).unwrap())).collect(),
            })
        },
    )
    .ok()
}

fn delete_row(c: &Connection, t: &Table, a: &str, s: i64) {
    c.execute(
        &format!("DELETE FROM main.\"{}\" WHERE _r_replica = ?1 AND _r_seq = ?2", t.name),
        rusqlite::params![unhex(a), s],
    )
    .unwrap();
}

fn set_batch(c: &Connection, t: &Table, r: &Row, b: Option<&String>) {
    if t.i_batch.is_none() {
        return;
    }
    let bv = b.map(|x| unhex(x));
    c.execute(
        &format!("UPDATE main.\"{}\" SET _r_batch = ?1 WHERE _r_replica = ?2 AND _r_seq = ?3", t.name),
        rusqlite::params![bv, to_sql(&r.vals[t.i_replica]), to_sql(&r.vals[t.i_seq])],
    )
    .unwrap();
}

fn insert_row(c: &Connection, t: &Table, r: &Row, b: Option<&String>) {
    let cols = t.cols.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(",");
    let qs = (1..=t.cols.len()).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let vals: Vec<rusqlite::types::Value> = (0..t.cols.len())
        .map(|i| {
            if Some(i) == t.i_batch {
                match b {
                    Some(x) => rusqlite::types::Value::Blob(unhex(x)),
                    None => rusqlite::types::Value::Null,
                }
            } else if i == t.i_superseded {
                // A display cache, derived and never carried
                // (docs/format.md#row-superseded).
                rusqlite::types::Value::Integer(0)
            } else {
                to_sql(&r.vals[i])
            }
        })
        .collect();
    c.execute(
        &format!("INSERT INTO main.\"{}\" ({}) VALUES ({})", t.name, cols, qs),
        rusqlite::params_from_iter(vals),
    )
    .unwrap();
}

// The same in `_r_lc`, `_r_entity`, `_r_parents`, `_r_deleted`, `_r_session`
// and every author column; `_r_batch` and `_r_superseded` are not compared
// (docs/format.md#merge-counts).
fn same_content(t: &Table, a: &Row, b: &Row) -> bool {
    (0..t.cols.len())
        .filter(|i| Some(*i) != t.i_batch && *i != t.i_superseded)
        .all(|i| a.vals[i].same(&b.vals[i]))
}

// A copy a merge works on holds the replicated tables' guards (replicated-
// tables.md §4); the merge is the one writer allowed past them (an outranked
// row is removed, docs/format.md#merge-signed-outranks), and this reader works
// on a scratch copy, so it drops them.
fn disarm(c: &Connection) {
    let names: Vec<String> = {
        let mut st = c.prepare("SELECT name FROM main.sqlite_master WHERE type='trigger'").unwrap();
        let v: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
        v
    };
    for n in names {
        c.execute(&format!("DROP TRIGGER main.\"{}\"", n), []).unwrap();
    }
}

// What the document admits, read from the rows of the merge only: a row whose
// `_r_batch` names a header the copy holds that lists it (its table, its
// author, its seq), or a row under the copy's own id. Any other row seats,
// admits, holds and closes nothing, and is no parent held
// (docs/format.md#uncovered-row). Computed on the copy with those rows set
// aside, then put back.
fn admission(c: &Connection, tables: &[Table], max_parties: usize) -> admit::Admission {
    let own: Option<String> = c
        .query_row("SELECT id FROM main._dai_replica", [], |r| r.get::<_, Vec<u8>>(0))
        .ok()
        .map(|b| hexlc(&b));
    let hs: BTreeMap<String, (String, BTreeSet<(String, i64)>)> = headers(c, "main")
        .into_iter()
        .map(|h| (h.id.clone(), (h.author.clone(), parse_covers(&h.covers))))
        .collect();
    c.execute("SAVEPOINT admission", []).unwrap();
    for t in tables {
        for r in load(c, "main", t) {
            let a = author_hex(t, &r);
            if Some(&a) == own.as_ref() {
                continue;
            }
            let covered = t
                .i_batch
                .and_then(|ib| match &r.vals[ib] {
                    V::Blob(b) => hs.get(&hexlc(b)),
                    _ => None,
                })
                .map(|(au, l)| *au == a && l.contains(&(t.name.clone(), seq_of(t, &r))))
                .unwrap_or(false);
            if !covered {
                c.execute(
                    &format!("DELETE FROM main.\"{}\" WHERE _r_replica = ?1 AND _r_seq = ?2", t.name),
                    rusqlite::params![to_sql(&r.vals[t.i_replica]), to_sql(&r.vals[t.i_seq])],
                )
                .unwrap();
            }
        }
    }
    let adm = admit::admit(c, tables, max_parties);
    c.execute("ROLLBACK TO admission", []).unwrap();
    c.execute("RELEASE admission", []).unwrap();
    adm
}

// The author columns of the tables a merge takes, one line per column: table,
// name, declared type (whitespace runs collapsed, trimmed, uppercased),
// `NOT NULL` or nothing, and the default as declared
// (docs/format.md#merge-whole-refusals; replicated-tables.md T1-D21).
// `system` includes the roster tables and the close, which a merge takes but
// the signed manifest never enumerates (T1-D26).
fn schema_lines(c: &Connection, schema: &str, tables: &[Table], system: bool) -> String {
    let mut out = String::new();
    for t in tables {
        if !system && admit::ROSTER.contains(&t.name.as_str()) {
            continue;
        }
        let mut st = c
            .prepare("SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info(?1, ?2)")
            .unwrap();
        let rows: Vec<(String, String, i64, Option<String>)> = st
            .query_map(rusqlite::params![t.name, schema], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        for (name, ty, nn, dflt) in rows {
            if name.starts_with("_r_") {
                continue;
            }
            let ty = ty.split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase();
            out.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\n",
                t.name,
                name,
                ty,
                if nn != 0 { "NOT NULL" } else { "" },
                dflt.unwrap_or_default()
            ));
        }
    }
    out
}

// The canonical dump (docs/format.md#merge-dump).
fn dump(c: &Connection, tables: &[Table]) -> String {
    let mut out = String::new();
    // Each table a merge takes, in UTF-8 order of name; rows by author id
    // (bytewise) then seq; every column in declared order but `_r_superseded`
    // (#dump-tables, #dump-value).
    let mut ts: Vec<&Table> = tables.iter().collect();
    ts.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    for t in ts {
        out.push_str(&format!("# {}\n", t.name));
        let mut rows = load(c, "main", t);
        rows.sort_by(|a, b| {
            let ka = (blob_bytes(&a.vals[t.i_replica]), seq_of(t, a));
            let kb = (blob_bytes(&b.vals[t.i_replica]), seq_of(t, b));
            ka.cmp(&kb)
        });
        for r in rows {
            let line: Vec<String> = (0..t.cols.len())
                .filter(|i| *i != t.i_superseded)
                .map(|i| r.vals[i].enc())
                .collect();
            out.push_str(&line.join("\t"));
            out.push('\n');
        }
    }
    // The author ids `_dai_replicas` holds, ascending (#dump-replicas).
    out.push_str("# _dai_replicas\n");
    let mut ids: Vec<Vec<u8>> = vec![];
    if let Ok(mut st) = c.prepare("SELECT id FROM main._dai_replicas") {
        ids = st.query_map([], |r| r.get::<_, Vec<u8>>(0)).unwrap().map(|x| x.unwrap()).collect();
    }
    ids.sort();
    for id in ids {
        out.push_str(&hexlc(&id));
        out.push('\n');
    }
    // The stored headers, by id, when the copy holds `_dai_batch` (#dump-batch).
    let has: i64 = c
        .query_row("SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name='_dai_batch'", [], |r| r.get(0))
        .unwrap();
    if has > 0 {
        out.push_str("# _dai_batch\n");
        let mut st = c
            .prepare("SELECT id, author, lc, sig, pub, att, version, digest, covers FROM main._dai_batch")
            .unwrap();
        let mut rows: Vec<Vec<V>> = st
            .query_map([], |r| Ok((0..9).map(|i| V::from(r.get_ref(i).unwrap())).collect::<Vec<V>>()))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        rows.sort_by(|a, b| blob_bytes(&a[0]).cmp(&blob_bytes(&b[0])));
        for r in rows {
            out.push_str(&r.iter().map(|v| v.enc()).collect::<Vec<_>>().join("\t"));
            out.push('\n');
        }
    }
    out
}

fn blob_bytes(v: &V) -> Vec<u8> {
    match v {
        V::Blob(b) => b.clone(),
        v => v.enc().into_bytes(),
    }
}

// The expected refusedBatches as (author, reason) pairs; None when misshapen, which fails.
fn refused_of(v: &serde_json::Value) -> Option<Vec<(String, String)>> {
    let a = v.as_array()?;
    let mut out = vec![];
    for e in a {
        let o = e.as_object()?;
        if o.len() != 2 {
            return None;
        }
        let author = o.get("author")?.as_str()?;
        let reason = o.get("reason")?.as_str()?;
        out.push((author.to_string(), reason.to_string()));
    }
    Some(out)
}

// A scratch copy of a fixture database: the fixtures are inputs and are never
// written (conformance/merge/README.md).
fn scratch(src: &Path, tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("dai-merge-{}-{}-{}.db", std::process::id(), n, tag));
    std::fs::copy(src, &p).unwrap_or_else(|e| panic!("copy {}: {}", src.display(), e));
    p
}

fn read_json(dir: &Path, f: &str, why: &mut Vec<String>) -> Option<serde_json::Value> {
    let p = dir.join(f);
    match std::fs::read_to_string(&p) {
        Err(_) => {
            why.push(format!("{}: missing", f));
            None
        }
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => Some(v),
            Err(e) => {
                why.push(format!("{}: not JSON: {}", f, e));
                None
            }
        },
    }
}

fn read_text(dir: &Path, f: &str, why: &mut Vec<String>) -> Option<String> {
    match std::fs::read_to_string(dir.join(f)) {
        Ok(s) => Some(s),
        Err(_) => {
            why.push(format!("{}: missing", f));
            None
        }
    }
}

// The first differing line of two texts, for a reason.
fn diff(name: &str, want: &str, got: &str) -> Option<String> {
    if want == got {
        return None;
    }
    let w: Vec<&str> = want.split('\n').collect();
    let g: Vec<&str> = got.split('\n').collect();
    for i in 0..w.len().max(g.len()) {
        let (a, b) = (w.get(i).copied().unwrap_or("<end>"), g.get(i).copied().unwrap_or("<end>"));
        if a != b {
            return Some(format!("{} differs at line {}:\n      want: {}\n      got:  {}", name, i + 1, a, b));
        }
    }
    Some(format!("{} differs", name))
}

// verdicts.json / lists.json: per copy, header id -> string.
fn per_copy(v: &serde_json::Value, side: &str, f: &str, required: bool, why: &mut Vec<String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    match v.get(side) {
        None if !required => {}
        Some(serde_json::Value::Object(o)) => {
            for (k, x) in o {
                match x.as_str() {
                    Some(s) => {
                        out.insert(k.clone(), s.to_string());
                    }
                    None => why.push(format!("{}: {}.{} is not a string", f, side, k)),
                }
            }
        }
        _ => why.push(format!("{}: `{}` missing or not an object", f, side)),
    }
    out
}

fn check(dir: &Path) -> Vec<String> {
    let mut why: Vec<String> = vec![];
    // result.json, in the shape schema.json gives it: a missing or misshapen
    // field fails, never skips.
    let Some(res) = read_json(dir, "result.json", &mut why) else { return why };
    let Some(ro) = res.as_object() else {
        why.push("result.json: not an object".into());
        return why;
    };
    let known = ["what", "cites", "converges", "admitted", "stable", "ab", "ba", "shrinksAt", "pairedWith", "before"];
    for k in ro.keys() {
        if !known.contains(&k.as_str()) {
            why.push(format!("result.json: unknown field `{}`", k));
        }
    }
    if !res.get("what").map(|v| v.is_string()).unwrap_or(false) {
        why.push("result.json: `what` missing or not a string".into());
    }
    match res.get("cites").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() && a.iter().all(|x| x.is_string()) => {}
        _ => why.push("result.json: `cites` missing, empty, or not strings".into()),
    }
    let flag = |k: &str, why: &mut Vec<String>| -> bool {
        match res.get(k).and_then(|v| v.as_bool()) {
            Some(b) => b,
            None => {
                why.push(format!("result.json: `{}` missing or not a boolean", k));
                false
            }
        }
    };
    let converges = flag("converges", &mut why);
    let admitted = flag("admitted", &mut why);
    let stable = flag("stable", &mut why);
    for k in ["shrinksAt", "pairedWith"] {
        if let Some(v) = res.get(k) {
            if !v.is_string() {
                why.push(format!("result.json: `{}` not a string", k));
            }
        }
    }
    let before = match res.get("before") {
        None => false,
        Some(serde_json::Value::Bool(true)) => true,
        Some(_) => {
            why.push("result.json: `before` present and not true".into());
            false
        }
    };

    // manifest.json: per copy, the signed-view digest and, in a session
    // document, the profile (docs/format.md#fixtures-manifest).
    let Some(man) = read_json(dir, "manifest.json", &mut why) else { return why };
    let mut views: BTreeMap<&str, String> = BTreeMap::new();
    let mut parties: BTreeMap<&str, Option<usize>> = BTreeMap::new();
    for side in ["a", "b"] {
        match man.get(side).and_then(|m| m.get("view")).and_then(|v| v.as_str()) {
            Some(v) => {
                views.insert(side, v.to_string());
            }
            None => why.push(format!("manifest.json: {}.view missing or not a string", side)),
        }
        let mp = match man.get(side).and_then(|m| m.get("session")) {
            None => None,
            Some(s) => {
                let mp = s.get("max_parties").and_then(|v| v.as_u64()).filter(|n| *n > 0);
                let close = s.get("close").and_then(|v| v.as_str());
                if mp.is_none() || !matches!(close, Some("any") | Some("creator")) {
                    why.push(format!("manifest.json: {}.session misshapen", side));
                }
                mp.map(|n| n as usize)
            }
        };
        parties.insert(side, mp);
    }

    let Some(ver) = read_json(dir, "verdicts.json", &mut why) else { return why };
    let lists = if dir.join("lists.json").exists() {
        read_json(dir, "lists.json", &mut why)
    } else {
        None
    };
    let mut verdict: BTreeMap<&str, BTreeMap<String, String>> = BTreeMap::new();
    let mut list: BTreeMap<&str, BTreeMap<String, String>> = BTreeMap::new();
    for side in ["a", "b"] {
        verdict.insert(side, per_copy(&ver, side, "verdicts.json", true, &mut why));
        list.insert(
            side,
            match &lists {
                Some(l) => per_copy(l, side, "lists.json", false, &mut why),
                None => BTreeMap::new(),
            },
        );
        for (id, v) in &verdict[side] {
            if !(v == "ok" || v == "incomplete" || v.starts_with("BATCH_") || v == "ROW_MALFORMED") {
                why.push(format!("verdicts.json: {}.{} is `{}`", side, id, v));
            }
        }
    }
    if let Some(l) = &lists {
        if let Some(o) = l.as_object() {
            for k in o.keys() {
                if k != "a" && k != "b" {
                    why.push(format!("lists.json: unknown copy `{}`", k));
                }
            }
        }
    }

    let expected: BTreeMap<&str, Option<String>> = [
        ("ab", read_text(dir, "expected-ab.txt", &mut why)),
        ("ba", read_text(dir, "expected-ba.txt", &mut why)),
    ]
    .into_iter()
    .collect();
    let schema_want = read_text(dir, "expected-schema.txt", &mut why);
    // The admitted text ships exactly where the flags say it does.
    let mut adm_want: BTreeMap<&str, Option<String>> = BTreeMap::new();
    for (k, f, on) in [
        ("ab", "expected-admitted-ab.txt", admitted),
        ("ba", "expected-admitted-ba.txt", admitted),
        ("a", "expected-admitted-a.txt", before),
        ("b", "expected-admitted-b.txt", before),
    ] {
        if on {
            adm_want.insert(k, read_text(dir, f, &mut why));
        } else if dir.join(f).exists() {
            why.push(format!("{} ships but result.json does not say so", f));
        }
    }
    if !why.is_empty() {
        return why;
    }

    let a_db = dir.join("a.db");
    let b_db = dir.join("b.db");
    for p in [&a_db, &b_db] {
        if !p.exists() {
            why.push(format!("{}: missing", p.file_name().unwrap().to_string_lossy()));
        }
    }
    if !why.is_empty() {
        return why;
    }

    // Every header a copy holds has its verdict, and no other
    // (conformance/merge/README.md, Verdicts); a session document carries its
    // profile in the manifest.
    for (side, p) in [("a", &a_db), ("b", &b_db)] {
        let tmp = scratch(p, side);
        {
            let c = Connection::open(&tmp).unwrap();
            let held: BTreeSet<String> = headers(&c, "main").into_iter().map(|h| h.id).collect();
            let given: BTreeSet<String> = verdict[side].keys().cloned().collect();
            if held != given {
                why.push(format!("verdicts.json: {} gives {:?}, the copy holds {:?}", side, given, held));
            }
            for k in list[side].keys() {
                if !held.contains(k) {
                    why.push(format!("lists.json: {}.{} is no header the copy holds", side, k));
                }
            }
            let tables = replicated_tables(&c, "main");
            if tables.iter().any(|t| t.i_session.is_some()) && parties[side].is_none() {
                why.push(format!("manifest.json: {} is a session document with no session profile", side));
            }
            // expected-schema.txt: the schema of copy A as built, over the
            // replicated tables only, the roster tables and the close left out
            // in a session document; a reader MAY check it
            // (docs/format.md#fixture-schema).
            if side == "a" {
                if let Some(w) = &schema_want {
                    let session = tables.iter().any(|t| t.i_session.is_some());
                    if let Some(d) = diff("expected-schema.txt", w, &schema_lines(&c, "main", &tables, !session)) {
                        why.push(d);
                    }
                }
            }
            // What each copy admits before any merge.
            if before {
                disarm(&c);
                let got = admit::render(&admission(&c, &tables, parties[side].unwrap_or(0)));
                if let Some(Some(w)) = adm_want.get(if side == "a" { "a" } else { "b" }) {
                    if let Some(d) = diff(&format!("expected-admitted-{}.txt", side), w, &got) {
                        why.push(d);
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }

    // Both directions: B into A reads b's verdicts, A into B a's.
    let mut dumps: BTreeMap<&str, String> = BTreeMap::new();
    for (dirn, local, other, ls, os) in [("ab", &a_db, &b_db, "a", "b"), ("ba", &b_db, &a_db, "b", "a")] {
        let work = scratch(local, ls);
        let sib = scratch(other, os);
        let mismatch = views[ls] != views[os];
        let mp = parties[ls].unwrap_or(0);
        let (counts, d, adm) = merge(&work, &sib, &verdict[os], &list[os], &verdict[ls], &list[ls], mp, mismatch);
        let want = &res[dirn];
        let field = |k: &str, got: serde_json::Value, why: &mut Vec<String>| match want.get(k) {
            None => why.push(format!("result.json: {}.{} missing", dirn, k)),
            Some(w) if *w != got => why.push(format!("{}.{}: want {}, got {}", dirn, k, w, got)),
            _ => {}
        };
        if want.get("applied").map(|v| v.is_i64()) != Some(true)
            || want.get("duplicate").map(|v| v.is_i64()) != Some(true)
            || want.get("newReplicas").map(|v| v.is_i64()) != Some(true)
            || want.get("rejected").and_then(|v| v.as_array()).map(|a| a.iter().all(|x| x.is_string())) != Some(true)
        {
            why.push(format!("result.json: {} misshapen", dirn));
        }
        field("applied", counts.applied.into(), &mut why);
        field("duplicate", counts.duplicate.into(), &mut why);
        field("newReplicas", counts.new_replicas.into(), &mut why);
        field("rejected", serde_json::Value::from(counts.rejected.clone()), &mut why);
        if let Some(o) = want.as_object() {
            for k in o.keys() {
                if !["applied", "duplicate", "rejected", "newReplicas", "refusedBatches", "refused"].contains(&k.as_str()) {
                    why.push(format!("result.json: unknown field {}.{}", dirn, k));
                }
            }
        }
        match want.get("refusedBatches").map(refused_of) {
            Some(Some(w)) => {
                if w != counts.refused {
                    why.push(format!("{}.refusedBatches: want {:?}, got {:?}", dirn, w, counts.refused));
                }
            }
            _ => why.push(format!("result.json: {}.refusedBatches missing or misshapen", dirn)),
        }
        // A merge refused whole says why (docs/format.md#document-mismatch).
        let w_ref = want.get("refused").map(|v| v.as_str().map(|s| s.to_string()));
        match (w_ref, &counts.refused_whole) {
            (None, None) => {}
            (Some(Some(w)), Some(g)) if w == *g => {}
            (w, g) => why.push(format!("{}.refused: want {:?}, got {:?}", dirn, w, g)),
        }
        if let Some(Some(w)) = expected.get(dirn) {
            if let Some(x) = diff(&format!("expected-{}.txt", dirn), w, &d) {
                why.push(x);
            }
        }
        if admitted {
            if let Some(Some(w)) = adm_want.get(dirn) {
                if let Some(x) = diff(&format!("expected-admitted-{}.txt", dirn), w, &adm) {
                    why.push(x);
                }
            }
        }
        // Merging a second time changes nothing.
        if stable {
            let (_, d2, adm2) = merge(&work, &sib, &verdict[os], &list[os], &verdict[ls], &list[ls], mp, mismatch);
            if let Some(x) = diff(&format!("{} merged twice", dirn), &d, &d2) {
                why.push(x);
            }
            if let Some(x) = diff(&format!("{} merged twice, admitted", dirn), &adm, &adm2) {
                why.push(x);
            }
        }
        dumps.insert(dirn, d);
        let _ = std::fs::remove_file(&work);
        let _ = std::fs::remove_file(&sib);
    }

    // Converges: the two directions' dumps are identical, checked in and
    // computed; a vector that says it does not, does not.
    if let (Some(Some(wa)), Some(Some(wb))) = (expected.get("ab"), expected.get("ba")) {
        if converges && wa != wb {
            why.push("converges: true, and expected-ab.txt and expected-ba.txt differ".into());
        }
        if !converges && wa == wb {
            why.push("converges: false, and expected-ab.txt and expected-ba.txt are identical".into());
        }
    }
    if converges && dumps.get("ab") != dumps.get("ba") {
        why.push("converges: true, and the two merged dumps differ".into());
    }
    why
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(root) = args.get(1) else {
        eprintln!("usage: dai-merge <fixture root>");
        std::process::exit(2);
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .unwrap_or_else(|e| panic!("{}: {}", root, e))
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let mut failed = 0;
    for d in &dirs {
        let name = d.file_name().unwrap().to_string_lossy().to_string();
        let why = match std::panic::catch_unwind(|| check(d)) {
            Ok(w) => w,
            Err(_) => vec!["the reader panicked".to_string()],
        };
        if why.is_empty() {
            println!("PASS {}", name);
        } else {
            failed += 1;
            println!("FAIL {}", name);
            for w in why {
                println!("    {}", w);
            }
        }
    }
    println!("{} of {} passed", dirs.len() - failed, dirs.len());
    if failed > 0 {
        std::process::exit(1);
    }
}
