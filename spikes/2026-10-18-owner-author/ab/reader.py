"""Spike, 18 October: experiments A and B through the Python reader.

Reads the inputs run.mjs wrote (out/<exp>-{a,b}.db, the copies as they stood
before the exchange, and out/<exp>-verdicts.json, the signature check's answer
for each copy's headers) and merges each way with
conformance/reference/dai_merge.py, as the conformance suite does.

    python spikes/2026-10-18-owner-author/ab/reader.py
"""
import json
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here.parents[2] / "conformance" / "reference"))
import dai_merge as dm  # noqa: E402

out = here / "out"
report = {}
for name in ("A", "Bi", "Bii"):
    verdicts = json.loads((out / f"{name}-verdicts.json").read_text(encoding="utf-8"))
    runs = {}
    dumps = {}
    for direction, (mine, theirs) in (("ab", ("a", "b")), ("ba", ("b", "a"))):
        local = dm.load(out / f"{name}-{mine}.db")
        sibling = dm.load(out / f"{name}-{theirs}.db")
        result = dm.merge(local, sibling, verdicts[theirs], {}, verdicts[mine], {})
        result["refusedBatches"] = [
            {k: (v.hex() if isinstance(v, (bytes, bytearray)) else v) for k, v in r.items()} if isinstance(r, dict) else r
            for r in result["refusedBatches"]
        ]
        dumps[direction] = dm.canonical_dump(local, dm.replicated_tables(local))
        runs[direction] = {"result": result, "admitted": dm.admitted_dump(local, dm.MAX_PARTIES)}
    runs["converged"] = dumps["ab"] == dumps["ba"]
    report[name] = runs

(out / "python-report.json").write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2, default=str))
