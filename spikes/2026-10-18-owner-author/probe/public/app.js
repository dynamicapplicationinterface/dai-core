/**
 * Owner spike probe (experiments C and D).
 *
 * This context's author key: ES256, non-extractable, kept in IndexedDB. The
 * owner: a platform passkey; the store verifies it. A write pulls the owner's
 * latest checkpoint, merges rows by id, appends one signed row, encrypts the
 * database under a fresh data key, wraps that key under every path this
 * context holds (PRF, keychain secret, and the store as a control), signs a
 * checkpoint and uploads it. A restore reports each path separately.
 */
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = {
  from(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  to(text) {
    const t = String(text);
    const s = atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const fingerprint = async (secret) => hex(await sha256(new Uint8Array([...enc.encode("fp:"), ...new Uint8Array(secret)]))).slice(0, 16);
const ES256 = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const CONTEXT = standalone ? "Home Screen app" : "Safari tab";

const state = {
  release: null,
  author: null, // { keys, pub, id }
  owner: null,
  session: null,
  prf: { atCreate: "not tried", atSignIn: "not tried", secret: null, fp: null },
  platformAuthenticator: "unknown",
  keychain: { secret: null, fp: null, api: "PasswordCredential" in window ? "present" : "absent", how: "none" },
  local: { rows: [], seq: 0, base: null },
  lastRestore: null,
  log: [],
};

function note(line, bad = false) {
  const at = new Date().toISOString().slice(11, 19);
  state.log.push(`${at} ${line}`);
  keep();
  $("note").textContent = line;
  $("note").className = bad ? "bad" : "muted";
  render();
}

/*
 * The keychain form's submission reloads the page (that is what makes Safari
 * offer to save the password), so the owner session, the PRF readings and
 * the log are kept for this tab across it. The PRF secret itself is not: a
 * sign-in after the reload reads it again. A wipe clears all of this.
 */
function keep() {
  const { owner, session, prf, platformAuthenticator, log } = state;
  sessionStorage.setItem("dai-spike-state", JSON.stringify({ owner, session, prf: { atCreate: prf.atCreate, atSignIn: prf.atSignIn, fp: prf.fp }, platformAuthenticator, log }));
}
function recall() {
  const kept = JSON.parse(sessionStorage.getItem("dai-spike-state") ?? "null");
  if (!kept) return;
  Object.assign(state, { owner: kept.owner, session: kept.session, log: kept.log ?? [] });
  Object.assign(state.prf, kept.prf);
  if (state.prf.fp) state.log.push("(reloaded: PRF secret not held until the next sign-in)");
}

// ---- IndexedDB: the author key and the local working copy ----------------
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("dai-spike", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(op, key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("kv", op === "get" ? "readonly" : "readwrite");
    const r = op === "get" ? t.objectStore("kv").get(key) : t.objectStore("kv").put(value, key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function loadAuthor() {
  let keys = await kv("get", "author");
  if (!keys) {
    keys = await crypto.subtle.generateKey(ES256, false, ["sign", "verify"]);
    await kv("put", "author", keys);
  }
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const id = b64u.from((await sha256(pub)).slice(0, 16));
  state.author = { keys, pub, id };
  state.local = (await kv("get", "local")) ?? state.local;
}
const saveLocal = () => kv("put", "local", state.local);
const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign(SIGN, state.author.keys.privateKey, bytes));
const verify = async (pubB64, sigB64, bytes) =>
  crypto.subtle.verify(SIGN, await crypto.subtle.importKey("raw", b64u.to(pubB64), ES256, false, ["verify"]), b64u.to(sigB64), bytes);

// ---- The store -----------------------------------------------------------
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(state.session ? { authorization: `Bearer ${state.session}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await r.json();
  if (!r.ok && r.status !== 409) throw new Error(out.error ?? `HTTP ${r.status}`);
  return { status: r.status, ...out };
}

// ---- Passkey (C) and PRF (D i) -------------------------------------------
let PRF_SALT = null;

/*
 * Safari shows the passkey sheet only when create()/get() runs inside the
 * tap itself: a network round trip first spends the gesture, and the call
 * fails with NotAllowedError and no sheet. So the challenges are fetched
 * ahead of the tap, and refreshed well inside the store's five minutes.
 */
const pending = { register: null, login: null };
async function prefetch() {
  const [register, login] = await Promise.all([api("/api/register/options", {}), api("/api/login/options", {})]);
  pending.register = register;
  pending.login = login;
}
function take(kind) {
  const opts = pending[kind];
  pending[kind] = null;
  if (!opts) throw new Error("The challenge is not ready yet: wait a second and tap again.");
  return opts;
}

function readPrf(cred, where) {
  const ext = cred.getClientExtensionResults?.() ?? {};
  if (!("prf" in ext)) return { word: "no prf in extension results (unsupported)", secret: null };
  const first = ext.prf.results?.first;
  if (first) return { word: `supported, result returned at ${where}`, secret: new Uint8Array(first) };
  return { word: `prf.enabled=${ext.prf.enabled}, no result at ${where}`, secret: null };
}

async function createOwner() {
  try {
    const opts = take("register");
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64u.to(opts.challenge),
        rp: opts.rp,
        user: { id: b64u.to(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
        attestation: "none",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    const prf = readPrf(cred, "create");
    state.prf.atCreate = prf.word;
    const done = await api("/api/register/finish", {
      credentialId: b64u.from(cred.rawId),
      clientDataJSON: b64u.from(cred.response.clientDataJSON),
      attestationObject: b64u.from(cred.response.attestationObject),
      context: CONTEXT,
    });
    state.owner = done.owner;
    state.session = done.session;
    if (prf.secret) await takePrf(prf.secret);
    note("Owner passkey made. Signing in once more reads PRF the way every later sign-in will.");
    await enroll();
    prefetch().catch(() => {});
  } catch (e) {
    passkeyFailed(e);
  }
}

async function signIn() {
  try {
    const opts = take("login");
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64u.to(opts.challenge),
        rpId: opts.rpId,
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    const prf = readPrf(cred, "sign-in");
    state.prf.atSignIn = prf.word;
    const done = await api("/api/login/finish", {
      credentialId: b64u.from(cred.rawId),
      clientDataJSON: b64u.from(cred.response.clientDataJSON),
      authenticatorData: b64u.from(cred.response.authenticatorData),
      signature: b64u.from(cred.response.signature),
      userHandle: cred.response.userHandle ? b64u.from(cred.response.userHandle) : null,
    });
    state.owner = done.owner;
    state.session = done.session;
    if (prf.secret) await takePrf(prf.secret);
    await enroll();
    prefetch().catch(() => {});
    note("Signed in as the owner.");
  } catch (e) {
    passkeyFailed(e);
  }
}

async function takePrf(secret) {
  state.prf.secret = secret;
  state.prf.fp = await fingerprint(secret);
}

function passkeyFailed(e) {
  prefetch().catch(() => {});
  note(`Passkey: ${e.name ?? "Error"}: ${e.message}`, true);
  $("nopasskey").hidden = false;
}

async function enroll() {
  const proof = await sign(enc.encode(`dai-spike enroll ${state.owner} ${state.author.id}`));
  const r = await api("/api/enroll", { author: state.author.id, pub: b64u.from(state.author.pub), proof: b64u.from(proof), context: CONTEXT, ua: navigator.userAgent });
  state.authors = r.authors;
}

// ---- Keychain secret (D ii) ----------------------------------------------
async function makeSecret() {
  const secret = b64u.from(crypto.getRandomValues(new Uint8Array(32)));
  $("new-secret").value = secret;
  if ("PasswordCredential" in window) {
    try {
      await navigator.credentials.store(new PasswordCredential({ id: "dai-spike-wrap", password: secret }));
      state.keychain.how = "PasswordCredential store()";
    } catch (e) {
      state.keychain.how = `PasswordCredential failed: ${e.name}`;
    }
  }
  // Kept for this tab across the form's own navigation; never sent anywhere.
  sessionStorage.setItem("dai-spike-secret", secret);
  sessionStorage.setItem("dai-spike-how", state.keychain.how === "none" ? "form submission (Safari save prompt)" : state.keychain.how);
  $("save-form").submit();
}

async function useSecret(secret, how) {
  state.keychain.secret = enc.encode(secret);
  state.keychain.fp = await fingerprint(state.keychain.secret);
  state.keychain.how = how;
  render();
}

// ---- Wrapping and the database -------------------------------------------
async function wrappingKey(secret, path) {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("dai-spike-wrap"), info: enc.encode(path) }, base, { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

const PATHS = {
  prf: () => state.prf.secret,
  keychain: () => state.keychain.secret,
};

async function sealDatabase(rows) {
  const plain = enc.encode(JSON.stringify({ rows }));
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, plain));
  const envelope = {};
  for (const [path, secretOf] of Object.entries(PATHS)) {
    const secret = secretOf();
    if (!secret) continue;
    const wrapped = await crypto.subtle.wrapKey("raw", dataKey, await wrappingKey(secret, path), "AES-KW");
    envelope[path] = { wrapped: b64u.from(wrapped), fp: path === "prf" ? state.prf.fp : state.keychain.fp };
  }
  // The control: the store holds the data key. Not end-to-end; it keeps C's
  // question (do the rows survive through the owner?) apart from D's.
  envelope.store = { key: b64u.from(await crypto.subtle.exportKey("raw", dataKey)) };
  return { database: hex(await sha256(plain)), iv: b64u.from(iv), ciphertext: b64u.from(ciphertext), envelope };
}

async function openDatabase(cp) {
  const results = {};
  let dataKey = null;
  for (const path of ["prf", "keychain"]) {
    const entry = cp.envelope?.[path];
    const secret = PATHS[path]();
    if (!entry) { results[path] = "not in this checkpoint"; continue; }
    if (!secret) { results[path] = "no secret in this context"; continue; }
    try {
      const key = await crypto.subtle.unwrapKey("raw", b64u.to(entry.wrapped), await wrappingKey(secret, path), "AES-KW", { name: "AES-GCM" }, false, ["decrypt"]);
      results[path] = "unwrapped";
      dataKey ??= key;
    } catch {
      results[path] = `unwrap FAILED (secret here ${path === "prf" ? state.prf.fp : state.keychain.fp}, at write ${entry.fp})`;
    }
  }
  const usedClient = Boolean(dataKey);
  if (cp.envelope?.store) {
    results.store = "available (control)";
    dataKey ??= await crypto.subtle.importKey("raw", b64u.to(cp.envelope.store.key), { name: "AES-GCM" }, false, ["decrypt"]);
  }
  if (!dataKey) throw Object.assign(new Error("no path opens this checkpoint"), { results });
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.to(cp.iv) }, dataKey, b64u.to(cp.ciphertext)));
  const digestOk = hex(await sha256(plain)) === JSON.parse(cp.checkpoint).database;
  return { rows: JSON.parse(dec.decode(plain)).rows, results, digestOk, openedBy: usedClient ? Object.keys(results).find((p) => results[p] === "unwrapped") : "store" };
}

const rowBytes = (r) => enc.encode(JSON.stringify([r.id, r.author, r.seq, r.text, r.at]));

async function checkRows(rows, authors) {
  let bad = 0;
  for (const r of rows) {
    const a = authors[r.author];
    if (!a || !(await verify(a.pub, r.sig, rowBytes(r)))) bad++;
  }
  return bad;
}

const mergeRows = (mine, theirs) => {
  const byId = new Map([...theirs, ...mine].map((r) => [r.id, r]));
  return [...byId.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : 1));
};

async function restore(quiet = false) {
  if (!state.session) return note("Sign in with the passkey first.", true);
  const cp = await api("/api/checkpoint/latest");
  if (cp.none) {
    state.lastRestore = { none: true };
    if (!quiet) note("The owner has no checkpoint yet.");
    return null;
  }
  const checkpoint = JSON.parse(cp.checkpoint);
  const sigOk = await verify(cp.authors[cp.author].pub, cp.signature, enc.encode(cp.checkpoint));
  const opened = await openDatabase(cp);
  const badRows = await checkRows(opened.rows, cp.authors);
  state.authors = cp.authors;
  state.local.rows = mergeRows(state.local.rows, opened.rows);
  state.local.base = { revision: checkpoint.revision, digest: cp.digest, document: checkpoint.document };
  await saveLocal();
  const counts = {};
  for (const r of opened.rows) counts[r.author] = (counts[r.author] ?? 0) + 1;
  state.lastRestore = { revision: checkpoint.revision, digest: cp.digest.slice(0, 16), signedBy: cp.author, checkpointSignature: sigOk ? "verifies" : "DOES NOT VERIFY", databaseDigest: opened.digestOk ? "matches" : "DIFFERS", paths: opened.results, openedBy: opened.openedBy, rows: opened.rows.length, byAuthor: counts, rowSignaturesFailing: badRows };
  if (!quiet) note(`Restored revision ${checkpoint.revision}: ${opened.rows.length} rows.`);
  return { cp, checkpoint };
}

async function write() {
  const text = $("text").value.trim() || `row from ${CONTEXT}`;
  state.local.seq += 1;
  const row = { id: `${state.author.id}:${state.local.seq}`, author: state.author.id, seq: state.local.seq, text, at: new Date().toISOString() };
  row.sig = b64u.from(await sign(rowBytes(row)));
  state.local.rows = mergeRows([row], state.local.rows);
  await saveLocal();
  $("text").value = "";
  if (!state.session) return note("Written here only: not signed in, so nothing was uploaded.");
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await restore(true);
    const sealed = await sealDatabase(state.local.rows);
    const checkpoint = {
      release: state.release,
      document: latest?.checkpoint.document ?? crypto.randomUUID(),
      revision: (latest?.checkpoint.revision ?? 0) + 1,
      database: sealed.database,
      previous: latest?.cp.digest ?? null,
    };
    const text = JSON.stringify(checkpoint);
    const r = await api("/api/checkpoint", { checkpoint: text, signature: b64u.from(await sign(enc.encode(text))), author: state.author.id, envelope: sealed.envelope, iv: sealed.iv, ciphertext: sealed.ciphertext });
    if (r.status === 409) continue;
    state.local.base = { revision: r.revision, digest: r.digest, document: checkpoint.document };
    await saveLocal();
    return note(`Uploaded revision ${r.revision} (paths: ${Object.keys(sealed.envelope).join(", ")}).`);
  }
  note("The store moved on twice while writing; try again.", true);
}

async function listCheckpoints() {
  if (!state.session) return note("Sign in with the passkey first.", true);
  const r = await fetch("/api/checkpoints", { headers: { authorization: `Bearer ${state.session}` } }).then((x) => x.json());
  state.checkpoints = r;
  note(`${r.length} checkpoints for this owner.`);
}

function saveCopy() {
  const blob = new Blob([JSON.stringify({ savedAt: new Date().toISOString(), context: CONTEXT, author: state.author.id, rows: state.local.rows }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "dai-spike-copy.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---- Readings ------------------------------------------------------------
function readings() {
  const lines = [
    `context: ${CONTEXT}`,
    `user agent: ${navigator.userAgent}`,
    `origin: ${location.origin}`,
    `release digest: ${state.release?.slice(0, 16)}`,
    `author id (this context): ${state.author?.id} (hex ${state.author ? hex(b64u.to(state.author.id)) : ""})`,
    `author key extractable: ${state.author?.keys.privateKey.extractable}`,
    `platform authenticator available: ${state.platformAuthenticator}`,
    `owner: ${state.owner ?? "not signed in"}`,
    `PRF at create: ${state.prf.atCreate}`,
    `PRF at sign-in: ${state.prf.atSignIn}`,
    `PRF secret fingerprint: ${state.prf.fp ?? "none"}`,
    `PasswordCredential API: ${state.keychain.api}`,
    `keychain secret: ${state.keychain.how}; fingerprint ${state.keychain.fp ?? "none"}`,
    `local rows: ${state.local.rows.length}; base revision ${state.local.base?.revision ?? "none"}`,
    `enrolled authors: ${state.authors ? Object.entries(state.authors).map(([id, a]) => `${id} (${a.context})`).join("; ") : "unknown"}`,
    `last restore: ${state.lastRestore ? JSON.stringify(state.lastRestore) : "none"}`,
    `checkpoints: ${state.checkpoints ? state.checkpoints.map((c) => `r${c.revision} by ${c.author} [${c.paths.join(",")}]`).join("; ") : "not listed"}`,
    "log:",
    ...state.log,
  ];
  return lines.join("\n");
}

function render() {
  $("context").textContent = CONTEXT;
  $("ua").textContent = navigator.userAgent;
  if (state.author) {
    $("author").textContent = state.author.id;
    $("extractable").textContent = String(state.author.keys.privateKey.extractable);
  }
  $("owner-state").textContent = state.owner ? `Owner ${state.owner}. PRF: ${state.prf.atSignIn !== "not tried" ? state.prf.atSignIn : state.prf.atCreate}${state.prf.fp ? `, fingerprint ${state.prf.fp}` : ""}` : "Not signed in.";
  $("kc-fp").textContent = state.keychain.fp ?? "none";
  $("db-state").textContent = state.local.base ? `Base revision ${state.local.base.revision}.` : "No checkpoint restored or written here yet.";
  const tbody = $("rows");
  tbody.replaceChildren(
    ...state.local.rows.map((r) => {
      const tr = document.createElement("tr");
      for (const v of [`${r.seq}`, r.author.slice(0, 8) + (r.author === state.author?.id ? " (this)" : ""), r.text]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      return tr;
    }),
  );
  $("readings").value = readings();
}

const guard = (fn) => async () => {
  try {
    await fn();
  } catch (e) {
    note(`${e.name ?? "Error"}: ${e.message}${e.results ? ` ${JSON.stringify(e.results)}` : ""}`, true);
  }
};

async function start() {
  recall();
  state.release = hex(await sha256(enc.encode(await (await fetch("/app.js", { cache: "no-store" })).text())));
  PRF_SALT = await sha256(enc.encode("dai-spike-prf-v1"));
  await prefetch().catch((e) => note(`Could not reach the store: ${e.message}`, true));
  setInterval(() => prefetch().catch(() => {}), 3 * 60_000);
  await loadAuthor();
  if (!window.PublicKeyCredential) {
    state.platformAuthenticator = "no WebAuthn";
    $("nopasskey").hidden = false;
  } else {
    const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
    state.platformAuthenticator = ok ? "yes" : "no";
    if (!ok) $("nopasskey").hidden = false;
  }
  const kept = sessionStorage.getItem("dai-spike-secret");
  if (kept) await useSecret(kept, sessionStorage.getItem("dai-spike-how") ?? "form submission");
  if (new URLSearchParams(location.search).has("saved")) note("Secret made. If Safari offered to save the password, it is in Passwords now.");
  $("create").onclick = guard(createOwner);
  $("signin").onclick = guard(signIn);
  $("make-secret").onclick = guard(makeSecret);
  $("use-secret").onclick = guard(async () => {
    const v = $("saved-secret").value;
    if (!v) return note("The password field is empty: tap it and fill from Passwords.", true);
    await useSecret(v, "filled from Passwords");
    note("Keychain secret in use.");
  });
  $("add").onclick = guard(write);
  $("restore").onclick = guard(() => restore(false));
  $("list").onclick = guard(listCheckpoints);
  $("save-copy").onclick = saveCopy;
  $("copy").onclick = guard(async () => {
    await navigator.clipboard.writeText(readings());
    note("Readings copied.");
  });
  render();
}

start().catch((e) => note(`Start failed: ${e.name}: ${e.message}`, true));
