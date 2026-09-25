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
            "SELECT name FROM {}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_dai\\_%' ESCAPE '\\' ORDER BY name",
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
        if let (Some(a), Some(b), Some(e), Some(p), Some(s)) = (
            idx("_r_replica"),
            idx("_r_seq"),
            idx("_r_entity"),
            idx("_r_parents"),
            idx("_r_superseded"),
        ) {
            let i_batch = idx("_r_batch");
            out.push(Table {
                name: n,
                cols,
                i_replica: a,
                i_seq: b,
                i_entity: e,
                i_parents: p,
                i_superseded: s,
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
// not checked, and a header not checked is not signed.
fn merge(work: &Path, sibling: &Path, verdicts: &BTreeMap<String, String>) -> (Counts, String) {
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
    let mut held: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut covering: BTreeMap<String, String> = BTreeMap::new(); // "table|author:seq" -> lowest ok id
    let mut covers: BTreeSet<String> = BTreeSet::new(); // "id|table|author:seq"
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
        for (id, author, listed) in headers {
            let hid = hexlc(&id);
            held.insert(hid.clone(), id.clone());
            let verdict = verdicts.get(&hid).cloned().unwrap_or_else(|| "BATCH_SIGNATURE_INVALID".to_string());
            if verdict != "ok" {
                refusals.insert((hid, verdict, hexlc(&author)), author);
                continue;
            }
            c.execute(
                "INSERT OR IGNORE INTO main._dai_batch (id, author, lc, sig, pub, att, version, digest, covers) \
                 SELECT id, author, lc, sig, pub, att, version, digest, covers FROM S._dai_batch WHERE id = ?1",
                [&id],
            )
            .unwrap();
            if let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(&listed) {
                for pair in list {
                    let key = format!("{}|{}:{}", pair[0].as_str().unwrap_or(""), hexlc(&author), pair[1]);
                    covers.insert(format!("{}|{}", hid, key));
                    covering.entry(key).or_insert_with(|| hid.clone());
                }
            }
        }
    }


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
            let b = match t.i_batch {
                Some(b) => b,
                None => {
                    unsigned_rows.push((ti, r));
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
                // name of whoever wrote the row.
                if !held.contains_key(&n) || verdicts.get(&n).map(|v| v == "ok").unwrap_or(false) {
                    let author = match &r.vals[t.i_replica] {
                        V::Blob(x) => x.clone(),
                        _ => vec![],
                    };
                    refusals.insert((n, "BATCH_DIGEST_MISMATCH".to_string(), hexlc(&author)), author);
                }
            } else {
                unsigned_rows.push((ti, r));
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
    for (rows, signed) in [(signed_rows, true), (unsigned_rows, false)] {
        for (ti, r) in rows {
            let t = &tables[ti];
            let id = rowid(t, &r);
            let (replica, seq) = (r.vals[t.i_replica].clone(), r.vals[t.i_seq].clone());
            // One author's seq names one row, whatever table it is in.
            let mut refused = false;
            for (oi, o) in tables.iter().enumerate() {
                if oi == ti {
                    continue;
                }
                if let Some(there) = held_row(o, &replica, &seq) {
                    if signed && unsigned(o, &there) {
                        displace(o, &replica, &seq);
                        reject(id.clone(), &mut counts.rejected);
                    } else {
                        refused = true;
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
        }
    }

    // T1-D2: supersession is a pure function of the row set, recomputed over all
    // rows: superseded exactly while some row of its own entity names it. A row
    // of another entity naming it hides nothing (T1-D35).
    for t in &tables {
        let all = load(&c, "main", t);
        let mut parented: BTreeSet<(String, String)> = BTreeSet::new();
        for r in &all {
            let entity = r.vals[t.i_entity].enc();
            if let V::Text(p) = &r.vals[t.i_parents] {
                if let Ok(serde_json::Value::Array(a)) = serde_json::from_str::<serde_json::Value>(p) {
                    for e in a {
                        if let serde_json::Value::String(s) = e {
                            parented.insert((entity.clone(), s.to_lowercase()));
                        }
                    }
                }
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
    (counts, out)
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
        for (dirn, base, sib, exp) in [
            ("ab", "a.db", "b.db", "expected-ab.txt"),
            ("ba", "b.db", "a.db", "expected-ba.txt"),
        ] {
            let work = tmp.join(format!("{}-{}.db", name, dirn));
            std::fs::copy(f.join(base), &work).unwrap();
            let theirs = verdicts.get(sib.trim_end_matches(".db")).cloned().unwrap_or_default();
            let (c, dump) = merge(&work, &f.join(sib), &theirs);
            let want = std::fs::read_to_string(f.join(exp))
                .unwrap()
                .replace("\r\n", "\n");
            if dump != want {
                problems.push(format!(
                    "{}: dump mismatch\n--- got\n{}--- want\n{}",
                    dirn, dump, want
                ));
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
