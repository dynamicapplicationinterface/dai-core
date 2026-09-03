<script setup lang="ts">
/**
 * The maker path: from "the AI gave me code" to a file in your downloads.
 *
 * The conversation is a replay and says so. Scripting it is fine for a product
 * tour and dishonest the moment it pretends to be a live model, so it is
 * labelled, it does not accept typing, and nothing claims to be generating.
 *
 * Everything after the conversation is real. The source shown on screen is the
 * source that gets compiled, by the same `buildContainer` the command line uses,
 * signed with a key minted in this tab, and the file that downloads is a working
 * application. A visitor who inspects it will find exactly what they were shown.
 */
import { computed, ref } from 'vue';
import { buildContainer } from '../../src/core.js';

const APP_SOURCE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>My Tasks</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem;
           margin: 40px auto; padding: 0 20px; }
    li { display: flex; gap: 10px; padding: 8px 0;
         border-bottom: 1px solid #e5e7eb; }
    li.done span { text-decoration: line-through; color: #9ca3af; }
    input[type=text] { flex: 1; padding: 8px; font: inherit; }
  </style>
</head>
<body>
  <h1>My Tasks</h1>
  <form id="add"><input type="text" id="what" placeholder="Add a task…" required /></form>
  <ul id="list"></ul>
  <p><button id="save">Save into this file</button> <em id="note"></em></p>
  <script type="module" src="./app.js"><\/script>
</body>
</html>`;

const APP_SCRIPT = `// The database lives inside this file. Nothing is sent anywhere.
const dai = window.dai;
const db = await dai.openDatabase();
db.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, what TEXT, done INT DEFAULT 0)");

function render() {
  const rows = db.selectObjects("SELECT * FROM tasks ORDER BY id");
  list.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = row.done ? "done" : "";
    li.innerHTML = '<input type="checkbox" ' + (row.done ? "checked" : "") + '>' +
                   "<span>" + row.what + "</span>";
    li.querySelector("input").onchange = (e) => {
      db.exec({ sql: "UPDATE tasks SET done=? WHERE id=?", bind: [e.target.checked ? 1 : 0, row.id] });
      render();
    };
    list.appendChild(li);
  }
}

add.onsubmit = (e) => {
  e.preventDefault();
  db.exec({ sql: "INSERT INTO tasks (what) VALUES (?)", bind: [what.value] });
  what.value = "";
  render();
};

save.onclick = async () => {
  const result = await dai.saveDatabase(db);
  note.textContent = result.saved ? "Saved." : "Save cancelled.";
};

render();`;

interface Turn {
  who: 'you' | 'assistant';
  text: string;
  code?: string;
}

const TRANSCRIPT: Turn[] = [
  {
    who: 'you',
    text: 'I want a simple task list I can keep on my laptop. Nothing online, no account.',
  },
  {
    who: 'assistant',
    text:
      'Here is a small task list. It stores everything in a SQLite database that lives ' +
      'inside the file itself, so there is no server and no account.',
    code: APP_SOURCE,
  },
  { who: 'you', text: 'Great — how do I actually use it? I do not know how to put it online.' },
  {
    who: 'assistant',
    text:
      'You do not need to. Compile it into a single DAI file: the app, the database engine ' +
      'and your data end up in one document you can open by double-clicking.',
  },
];

const revealed = ref(0);
const playing = ref(false);
const buildState = ref<'idle' | 'working' | 'done' | 'error'>('idle');
const buildLog = ref<string[]>([]);
const downloadUrl = ref('');
const downloadName = 'my-tasks.dai.html';
const fingerprint = ref('');
const fileSize = ref(0);
const errorText = ref('');

const finished = computed(() => revealed.value >= TRANSCRIPT.length);

async function play(): Promise<void> {
  playing.value = true;
  revealed.value = 0;
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 300 : 900));
    revealed.value = i + 1;
  }
  playing.value = false;
}

function log(line: string): void {
  buildLog.value = [...buildLog.value, line];
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Compiles the source above into a real, signed, downloadable application. */
async function build(): Promise<void> {
  buildState.value = 'working';
  buildLog.value = [];
  errorText.value = '';

  try {
    log('Fetching the container shell and bootloader…');
    const [template, runtime] = await Promise.all([
      fetch('/runtime/template.html').then((r) => r.text()),
      fetch('/runtime/dai-runtime.js').then((r) => r.text()),
    ]);

    log('Fetching the SQLite engine (about 1.4 MB, once)…');
    const [wasm, glue] = await Promise.all([
      fetchBytes('/runtime/sqlite3.wasm'),
      fetchBytes('/runtime/sqlite3.mjs'),
    ]);

    log('Minting a signing key in this browser…');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    let binary = '';
    for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);

    log('Sealing everything into one file…');
    const built = await buildContainer({
      files: {
        'index.html': new TextEncoder().encode(APP_SOURCE),
        'app.js': new TextEncoder().encode(APP_SCRIPT),
      },
      template,
      runtime,
      appName: 'My Tasks',
      wasm,
      glue,
      signingKey: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`,
    });

    const blob = new Blob([built.html], { type: 'text/html' });
    downloadUrl.value = URL.createObjectURL(blob);
    fileSize.value = blob.size;
    fingerprint.value = built.publicKeyFingerprint ?? '';

    log(`Done — ${Math.round(blob.size / 1024)} KB, signed ${fingerprint.value.slice(0, 8)}.`);
    buildState.value = 'done';
  } catch (error) {
    errorText.value = String(error);
    buildState.value = 'error';
  }
}
</script>

<template>
  <div class="maker">
    <div class="chat">
      <header>
        <span class="tag">Recorded</span>
        <span class="muted">A conversation that already happened — this is a replay, not a live model.</span>
        <button class="link" :disabled="playing" @click="play">
          {{ revealed === 0 ? 'Play' : 'Replay' }}
        </button>
      </header>

      <p v-if="revealed === 0" class="empty muted">Press play to watch it back.</p>

      <div v-for="(turn, index) in TRANSCRIPT.slice(0, revealed)" :key="index" class="turn" :class="turn.who">
        <div class="who">{{ turn.who === 'you' ? 'You' : 'Assistant' }}</div>
        <div class="body">
          <p>{{ turn.text }}</p>
          <pre v-if="turn.code"><code>{{ turn.code }}</code></pre>
        </div>
      </div>
    </div>

    <div v-if="finished" class="step">
      <h3>This part is real</h3>
      <p>
        The code above is about to be compiled by the same compiler the command line
        uses, signed with a key created in this tab, and handed to you as a file.
        Nothing is uploaded — the build happens here.
      </p>

      <button v-if="buildState !== 'done'" :disabled="buildState === 'working'" @click="build">
        {{ buildState === 'working' ? 'Building…' : 'Build my file' }}
      </button>

      <ul v-if="buildLog.length" class="log">
        <li v-for="(line, index) in buildLog" :key="index">{{ line }}</li>
      </ul>

      <p v-if="errorText" class="bad">{{ errorText }}</p>

      <div v-if="buildState === 'done'" class="done">
        <a :href="downloadUrl" :download="downloadName" class="download">
          Download {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
        </a>
        <ol>
          <li>Open your downloads folder and double-click it. It opens in your browser.</li>
          <li>Add a task, then press <strong>Save into this file</strong>.</li>
          <li>Turn off your wifi and open it again. Everything is still there.</li>
          <li>Email it to someone. They double-click it too — no account, no install.</li>
        </ol>
        <p class="muted">
          That one file holds the app, the database engine and your tasks. It cannot
          send your data anywhere: the network is switched off inside it.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.maker { margin: 24px 0; }
.muted { color: var(--vp-c-text-2); }
.bad { color: var(--vp-c-red-1); }
.chat { border: 1px solid var(--vp-c-divider); border-radius: 12px; overflow: hidden; }
.chat header {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 16px; font-size: 13px;
  background: var(--vp-c-bg-alt); border-bottom: 1px solid var(--vp-c-divider);
}
.tag {
  padding: 2px 8px; border-radius: 999px; font-size: 11px; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--vp-c-text-1); background: var(--vp-c-default-soft);
}
.link { margin-left: auto; background: none; border: 0; cursor: pointer; color: var(--vp-c-brand-1); }
.empty { padding: 28px 16px; text-align: center; }
.turn { display: grid; grid-template-columns: 88px 1fr; gap: 12px; padding: 14px 16px; }
.turn + .turn { border-top: 1px solid var(--vp-c-divider); }
.turn.assistant { background: var(--vp-c-bg-alt); }
.who { font-size: 12px; color: var(--vp-c-text-2); padding-top: 2px; }
.body p { margin: 0 0 8px; }
.body pre {
  margin: 0; padding: 12px; max-height: 260px; overflow: auto;
  font-size: 12px; background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
.step { margin-top: 32px; }
button {
  padding: 9px 18px; font-size: 15px; border-radius: 8px; cursor: pointer;
  color: var(--vp-c-white); background: var(--vp-c-brand-1); border: 1px solid var(--vp-c-brand-1);
}
button:disabled { opacity: 0.6; cursor: default; }
.log { margin: 16px 0; padding-left: 18px; font-size: 13px; color: var(--vp-c-text-2); }
.done { margin-top: 20px; }
.download {
  display: inline-block; padding: 12px 20px; margin-bottom: 16px;
  font-size: 16px; font-weight: 600; border-radius: 8px;
  color: var(--vp-c-white) !important; background: var(--vp-c-green-1);
  text-decoration: none;
}
.done ol { margin: 0 0 12px; padding-left: 20px; }
.done li { margin: 6px 0; }
</style>
