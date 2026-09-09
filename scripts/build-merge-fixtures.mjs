/**
 * Builds the Level 1 merge fixtures.
 *
 * Each vector ships as input databases and expected text, checked in. The
 * Python reader's `merge` subcommand consumes the same inputs and diffs its own
 * dump against the same expected text — it never reads this script's output at
 * run time. If the fixtures were generated on the fly and Python compared
 * against that, the G1 gate would be TypeScript agreeing with itself.
 *
 *     node scripts/build-merge-fixtures.mjs          # write
 *     node scripts/build-merge-fixtures.mjs --check  # fail if anything differs
 *
 * `--check` is what CI runs. A change to the merge then cannot land without the
 * expected text changing in the same diff, where a reviewer sees it.
 *
 * Everything here is deterministic: replica and entity ids are constants, there
 * is no clock and no randomness. Two runs must produce identical text, or the
 * check flaps and somebody turns it off.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteReplicated } from "../dist/replicated.js";
import {
  applyRow,
  canonicalDump,
  changeEntity,
  createEntity,
  deleteEntity,
  mergeFrom,
} from "../dist/replicated-rows.js";
import { replicatedSchemaOf } from "../dist/replicated-frame.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "conformance", "merge");
const check = process.argv.includes("--check");

const SCHEMA = `-- dai:replicated
CREATE TABLE cases (
  title  TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  weight REAL
);
`;

const TABLES = ["cases"];
const id = (byte) => new Uint8Array(16).fill(byte);
const A = id(0xaa);
const B = id(0xbb);
const E1 = id(0x11);
const E2 = id(0x22);

/** A database on disk, behind the interface the write rules ask for. */
function open(path, extra) {
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(rewriteReplicated(SCHEMA).sql);
  // A table the author did not declare replicated. It never travels and never
  // merges, and the fixture exists to prove it does not stop one either.
  if (extra) db.exec(extra);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params),
    run: (sql, params = []) => void db.prepare(sql).run(...params),
    close: () => db.close(),
  };
}

function asReplica(db, replicaId) {
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [replicaId]);
  db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [replicaId]);
}

/**
 * Every vector, as a pair of copies and what merging them must produce.
 *
 * `fill` is given both copies and populates them; nothing else may write.
 */
const VECTORS = [
  {
    name: "merge-disjoint",
    what: "Two replicas, entities that never meet. Every row is new to the other side.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: 1.5 });
      createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "merge-idempotent",
    what: "B's rows only. Merging the same copy again adds nothing.",
    fill: (a, b) => {
      createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });
      void a;
    },
  },
  {
    name: "merge-conflict",
    what: "Both changed one entity from the same head. Two heads; current shows the deterministic pick, flagged.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "merge-resolve",
    what: "A change written while the conflict is open names both heads, which is what resolves it.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
      mergeFrom(a, b, TABLES);
      changeEntity(a, "cases", E1, { title: "settled", status: "open", weight: null });
    },
  },
  {
    name: "merge-tombstone",
    what: "A delete on one side and nothing on the other. Absent from current, present in heads.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "doomed", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      deleteEntity(b, "cases", E1);
    },
  },
  {
    name: "merge-tombstone-conflict",
    what: "A delete on one side, a change on the other, concurrent. Current shows the change, flagged (T1-D3).",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      changeEntity(a, "cases", E1, { title: "edited", status: "open", weight: null });
      deleteEntity(b, "cases", E1);
    },
  },
  {
    name: "merge-row-id-reused",
    what: "A row id already held with different content. Refused and counted; the honest rows still merge.",
    // The one vector where the copies do not end up the same, and that is the
    // answer. Each side holds different content under bb:1 and refuses the
    // other's: union merge converges over rows nobody disputes, and a disputed
    // id is where the guarantee stops. The alternative is one side silently
    // adopting the other's version of a row, which refusing it exists to stop.
    //
    // A Level 1 property, not a permanent one: at Level 2 the row that fails
    // to verify is refused and the one that verifies is kept, so the dispute
    // has an answer instead of two sides. Both copies are still fixed points
    // here — the run() above merges twice and requires nothing to move.
    converges: false,
    shrinksAt: "Track 2 — signatures decide a disputed row id",
    fill: (a, b) => {
      createEntity(b, "cases", E1, { title: "honest", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "also honest", status: "open", weight: null });
      applyRow(a, "cases", {
        _r_replica: B,
        _r_seq: 1,
        _r_lc: 1,
        _r_entity: E1,
        _r_parents: "[]",
        _r_deleted: 0,
        columns: { title: "not what B wrote", status: "open", weight: null },
      });
    },
  },
  {
    name: "schema-digest-replicated-only",
    cites: ["T1-D14", "T1-D21"],
    what:
      "The same replicated table on both sides and a local table on one. The canonical replicated schema must be identical, and the pair is a sibling.",
    // The rows are almost beside the point here; what is asserted is that two
    // readers agree about *whether these may merge*. Two readers disagreeing
    // about a merge is caught by every other vector; disagreeing about
    // mergeability is not, because the rows never get compared.
    localOnA: "CREATE TABLE notes_local (body TEXT);",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "heads-via-superseded-flag",
    what: "A chain and a fork on one copy. Heads must equal what a full parents scan would say.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "one", status: "open", weight: null });
      changeEntity(a, "cases", E1, { title: "two", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "other", status: "open", weight: null });
    },
  },
];

/** Merges a fresh copy of `from` into a fresh copy of `into` and reports both. */
function run(vector, direction) {
  const a = open(join(out, vector.name, "scratch-a.db"), vector.localOnA);
  const b = open(join(out, vector.name, "scratch-b.db"));
  asReplica(a, A);
  asReplica(b, B);
  vector.fill(a, b);
  const [left, right] = direction === "ab" ? [a, b] : [b, a];
  const result = mergeFrom(left, right, TABLES);
  const dump = canonicalDump(left, TABLES);

  /*
   * And again, changing nothing.
   *
   * For a converging vector this is idempotence. For the disputed one it is
   * the claim that matters more: two copies that will never agree must each
   * still be a fixed point. Non-convergent must not mean non-deterministic —
   * a dispute that grew on every exchange would be a copy that never settles,
   * which is worse than one that settles differently from its sibling.
   */
  const again = mergeFrom(left, right, TABLES);
  const settled = canonicalDump(left, TABLES);
  if (settled !== dump) {
    console.error(`${vector.name} [${direction}]: merging twice changed the table`);
    process.exit(1);
  }
  if (again.applied !== 0) {
    console.error(`${vector.name} [${direction}]: the second merge applied ${again.applied} rows`);
    process.exit(1);
  }
  a.close();
  b.close();
  rmSync(join(out, vector.name, "scratch-a.db"));
  rmSync(join(out, vector.name, "scratch-b.db"));
  return { dump, result };
}

/** The inputs, written as they stand before any merge. */
function writeInputs(vector) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  const a = open(join(dir, "a.db"), vector.localOnA);
  const b = open(join(dir, "b.db"));
  asReplica(a, A);
  asReplica(b, B);
  vector.fill(a, b);
  a.close();
  b.close();
}

const README = `# Level 1 merge fixtures

Generated by \`scripts/build-merge-fixtures.mjs\`; \`--check\` fails when anything
here differs from what the generator produces, so a change to the merge cannot
land without the expected text changing in the same diff.

Per vector:

| file | what it is |
|---|---|
| \`a.db\`, \`b.db\` | the two copies, before any merge |
| \`expected-ab.txt\` | the canonical dump of A after merging B into it |
| \`expected-ba.txt\` | the canonical dump of B after merging A into it |
| \`result.json\` | the counts and refused ids the merge reports |

**The databases are inputs, never oracles.** SQLite file bytes depend on the
library version and on page layout, so two engines that agree perfectly produce
different files. Nothing may compare \`.db\` bytes — the comparison is always the
dump. Adding a byte comparison "for completeness" would make the suite fail on a
correct implementation.

**\`expected-ab.txt\` and \`expected-ba.txt\` are identical wherever
\`result.json\` says \`converges: true\`, and both are checked in anyway.** Union
merge is commutative, so they must be; a fixture asserting it is worth more than
a sentence claiming it.

One vector says \`converges: false\`, and that is the answer rather than a
failure. When two copies hold different content under one row id, each refuses
the other's and each keeps its own: union merge converges over rows nobody
disputes, and a disputed id is where the guarantee stops. The alternative would
be one side silently adopting the other's version of a row, which is what
refusing it exists to prevent. Both dumps are checked in so the divergence is
pinned rather than described.

A second implementation reads \`a.db\` and \`b.db\`, performs its own merge in both
directions, and diffs its own dump against these files. It never reads the
generator's output at run time.
`;

let differences = 0;
const compare = (path, content) => {
  if (!check) {
    writeFileSync(path, content, "utf8");
    return;
  }
  const held = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (held !== content) {
    console.error(`differs: ${path.slice(repo.length + 1)}`);
    differences += 1;
  }
};

mkdirSync(out, { recursive: true });
compare(join(out, "README.md"), README);

for (const vector of VECTORS) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  writeInputs(vector);

  const ab = run(vector, "ab");
  const ba = run(vector, "ba");
  const shouldConverge = vector.converges !== false;
  if (shouldConverge && ab.dump !== ba.dump) {
    console.error(`${vector.name}: merging A<-B and B<-A disagree, which union merge forbids`);
    process.exit(1);
  }
  if (!shouldConverge && ab.dump === ba.dump) {
    console.error(`${vector.name}: the two directions were expected to differ, and did not`);
    process.exit(1);
  }

  {
    const shape = open(join(dir, "scratch-shape.db"), vector.localOnA);
    const schema = replicatedSchemaOf(shape);
    shape.close();
    rmSync(join(dir, "scratch-shape.db"));
    compare(join(dir, "expected-schema.txt"), schema);
  }
  compare(join(dir, "expected-ab.txt"), ab.dump);
  compare(join(dir, "expected-ba.txt"), ba.dump);
  compare(
    join(dir, "result.json"),
    `${JSON.stringify(
      {
        what: vector.what,
        converges: shouldConverge,
        ...(vector.shrinksAt ? { shrinksAt: vector.shrinksAt } : {}),
        // Each copy is a fixed point whether or not the two agree: run()
        // merges a second time and requires nothing to move.
        stable: true,
        ab: ab.result,
        ba: ba.result,
      },
      null,
      2,
    )}\n`,
  );
}

if (check && differences > 0) {
  console.error(`\n${differences} fixture file(s) differ. Regenerate and commit the diff.`);
  process.exit(1);
}
console.log(check ? "fixtures match" : `${VECTORS.length} merge fixtures written to conformance/merge`);
