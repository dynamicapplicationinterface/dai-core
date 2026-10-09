import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENER = resolve(repo, "apps", "runner", "src", "main.ts");

/**
 * Every refusal on the arrival path takes the launch screen down (ruled 25
 * September, backlog D122).
 *
 * An address naming a copy held here is painted as launching into it, and the
 * launch screen hides the report. A refusal said with `say(…, true)` leaves it
 * up, and the person sits on "This is taking longer than it should · Tap to
 * open", which reopens the held copy without a word about what arrived. D122
 * fixed one refusal that way and found its sibling beside it doing the same;
 * the e2e tests in mailbox-link-e2e show two of them in sight. This holds the
 * rest: in the two functions an arrival runs through, a refusal is said by
 * `refuseArrival`, never by `say` with an error flag.
 */

/** The body of a top-level function in the opener's source, by name. */
function body(source: string, name: string): string {
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  expect(start, `${name} is in the opener`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${name} ends`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every `say(…)` call in a stretch of source, with its arguments as written. */
function sayCalls(code: string): string[] {
  const calls: string[] = [];
  const opener = /\bsay\(/g;
  for (let match = opener.exec(code); match; match = opener.exec(code)) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    calls.push(code.slice(match.index, i));
  }
  return calls;
}

/** The last top-level argument of a call, as written. */
function lastArgument(call: string): string {
  const inner = call.slice(call.indexOf("(") + 1, -1);
  let depth = 0;
  let quote = "";
  let cut = -1;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0 && inner.slice(i + 1).trim()) cut = i;
  }
  return cut < 0 ? "" : inner.slice(cut + 1).trim().replace(/,$/, "").trim();
}

/*
 * The merge report's line, flagged by whether the merge was refused. Said with
 * a document already mounted (standing consent) or after the card was pressed,
 * and the card takes the launch screen down, so nothing is over it.
 */
const ALLOWED_FLAGS = new Set(["Boolean(report.refused)"]);

test("every refusal on the arrival path is said by refuseArrival, which takes the launch screen down", () => {
  const source = readFileSync(OPENER, "utf8");
  const refuse = body(source, "refuseArrival");
  expect(refuse, "refuseArrival clears the launching class").toContain('document.body.classList.remove("launching")');
  expect(refuse, "and the launch guard").toContain("clearLaunchGuard()");

  const found: string[] = [];
  for (const name of ["ingest", "launchFromLibrary"]) {
    const calls = sayCalls(body(source, name));
    expect(calls.length, `${name} says something (the scan found its calls)`).toBeGreaterThan(0);
    for (const call of calls) {
      const flag = lastArgument(call);
      if (flag && !ALLOWED_FLAGS.has(flag)) found.push(`${name}: ${call.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  expect(found, "a flagged say() on the arrival path leaves the launch screen over its sentence").toEqual([]);
  for (const name of ["ingest", "launchFromLibrary"]) {
    expect(body(source, name), `${name} refuses through refuseArrival`).toContain("refuseArrival(");
  }
});
