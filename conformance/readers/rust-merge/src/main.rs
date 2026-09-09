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

struct Row {
    vals: Vec<V>,
}

struct Table {
    name: String,
    cols: Vec<String>,
    i_replica: usize,
    i_seq: usize,
    i_parents: usize,
    i_superseded: usize,
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
        if let (Some(a), Some(b), Some(p), Some(s)) = (
            idx("_r_replica"),
            idx("_r_seq"),
            idx("_r_parents"),
            idx("_r_superseded"),
        ) {
            out.push(Table {
                name: n,
                cols,
                i_replica: a,
                i_seq: b,
                i_parents: p,
                i_superseded: s,
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
}

fn merge(work: &Path, sibling: &Path) -> (Counts, String) {
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
    };

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

    for t in &tables {
        if !s_tables.iter().any(|x| x.name == t.name) {
            continue;
        }
        let m: i64 = c
            .query_row(
                &format!("SELECT coalesce(max(_r_lc),0) FROM S.\"{}\"", t.name),
                [],
                |r| r.get(0),
            )
            .unwrap();
        lc_max = lc_max.max(m);

        let local = load(&c, "main", t);
        let mut by_id: BTreeMap<String, Row> = BTreeMap::new();
        for r in local {
            by_id.insert(rowid(t, &r), r);
        }
        let incoming = load(&c, "S", t);
        let mut to_insert: Vec<Row> = vec![];
        for r in incoming {
            let id = rowid(t, &r);
            match by_id.get(&id) {
                None => {
                    counts.applied += 1;
                    to_insert.push(r);
                }
                Some(ex) => {
                    // T1-D11: _r_superseded is not row content, not compared.
                    let same = r
                        .vals
                        .iter()
                        .enumerate()
                        .all(|(i, v)| i == t.i_superseded || v.same(&ex.vals[i]));
                    if same {
                        counts.duplicate += 1;
                    } else {
                        counts.rejected.push(id);
                    }
                }
            }
        }

        let colnames = t
            .cols
            .iter()
            .map(|x| format!("\"{}\"", x))
            .collect::<Vec<_>>()
            .join(",");
        let ph = (1..=t.cols.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");
        {
            let mut st = c
                .prepare(&format!(
                    "INSERT OR IGNORE INTO main.\"{}\" ({}) VALUES ({})",
                    t.name, colnames, ph
                ))
                .unwrap();
            for r in &to_insert {
                let params: Vec<rusqlite::types::Value> = r
                    .vals
                    .iter()
                    .map(|v| match v {
                        V::Null => rusqlite::types::Value::Null,
                        V::Int(i) => rusqlite::types::Value::Integer(*i),
                        V::Real(f) => rusqlite::types::Value::Real(*f),
                        V::Text(s) => rusqlite::types::Value::Text(s.clone()),
                        V::Blob(b) => rusqlite::types::Value::Blob(b.clone()),
                    })
                    .collect();
                st.execute(rusqlite::params_from_iter(params.iter())).unwrap();
            }
        }

        // T1-D2: supersession is a pure function of the row set. Recompute over all rows.
        let all = load(&c, "main", t);
        let mut parented: BTreeSet<String> = BTreeSet::new();
        for r in &all {
            if let V::Text(p) = &r.vals[t.i_parents] {
                if let Ok(serde_json::Value::Array(a)) =
                    serde_json::from_str::<serde_json::Value>(p)
                {
                    for e in a {
                        if let serde_json::Value::String(s) = e {
                            parented.insert(s.to_lowercase());
                        }
                    }
                }
            }
        }
        let mut st = c
            .prepare(&format!(
                "UPDATE main.\"{}\" SET _r_superseded = 1 WHERE lower(hex(_r_replica))||':'||_r_seq = ?1 AND _r_superseded = 0",
                t.name
            ))
            .unwrap();
        for id in &parented {
            st.execute([id]).unwrap();
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
    (counts, out)
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
        for (dirn, base, sib, exp) in [
            ("ab", "a.db", "b.db", "expected-ab.txt"),
            ("ba", "b.db", "a.db", "expected-ba.txt"),
        ] {
            let work = tmp.join(format!("{}-{}.db", name, dirn));
            std::fs::copy(f.join(base), &work).unwrap();
            let (c, dump) = merge(&work, &f.join(sib));
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
            {
                problems.push(format!(
                    "{}: counts got applied={} duplicate={} newReplicas={} rejected={:?}, want {}",
                    dirn, c.applied, c.duplicate, c.new_replicas, c.rejected, e
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
