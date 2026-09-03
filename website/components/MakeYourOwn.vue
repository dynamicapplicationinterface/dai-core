<script setup lang="ts">
/**
 * Turns code a visitor pasted from an assistant into a container they can keep.
 *
 * The compile happens here, in their tab. That is not an optimisation: a build
 * service would see every application anyone made with it, which is exactly the
 * property the format exists to remove. Anything that cannot be done in the
 * browser does not belong in this flow.
 *
 * The checks below matter more than the compile. Assistants reach for a CDN and
 * `fetch` by reflex, and under `connect-src 'none'` those fail without saying
 * anything — the visitor gets a blank page and concludes the format is broken.
 * Catching it before the download, in words that say what to do next, is the
 * difference between a tool a beginner can use and one that wastes their time.
 */
import { computed, ref } from 'vue';
import { buildContainer } from '../../src/core.js';

const PROMPT = `Build me a small self-contained app. Follow these rules exactly:

- Put everything in ONE HTML file. No separate files, no build step.
- Do NOT load anything from the internet: no CDN script or link tags, no
  fetch(), no XMLHttpRequest, no external fonts or images. Write the CSS and
  JavaScript inline. It must work with the wifi turned off.
- Any script tag that uses "await" at the top level must be type="module".
- To store data that survives closing the app, use the SQLite database that is
  already available, like this:

    const db = await window.dai.openDatabase();
    db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
    db.exec({ sql: "INSERT INTO notes (body) VALUES (?)", bind: ["hello"] });
    const rows = db.selectObjects("SELECT * FROM notes ORDER BY id");
    await window.dai.saveDatabase(db);   // writes changes back into the file

  Do not use localStorage: it stays in the browser instead of travelling with
  the file.

The app I want is: `;

/** A problem found in pasted code, phrased for somebody who did not write it. */
interface Finding {
  what: string;
  why: string;
  fix: string;
}

const source = ref('');
const promptCopied = ref(false);
const state = ref<'idle' | 'working' | 'done' | 'error'>('idle');
const errorText = ref('');
const downloadUrl = ref('');
const fileSize = ref(0);
const appName = ref('My App');

const downloadName = computed(() => {
  const slug = appName.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'my-app'}.dai.html`;
});

/**
 * Every check is a network reference of some kind. None is a style judgement:
 * each one works on a web page and silently does not work inside a container,
 * which is the only kind of problem worth stopping a beginner for.
 */
const CHECKS: { pattern: RegExp; finding: Finding }[] = [
  {
    pattern: /<script[^>]+src\s*=\s*["']https?:/i,
    finding: {
      what: 'It loads a script from the internet.',
      why: 'A container has no network access, so that script never arrives and the app does nothing.',
      fix: 'Ask your assistant to inline that library instead of loading it from a CDN, or to rewrite it without the library.',
    },
  },
  {
    pattern: /<link[^>]+href\s*=\s*["']https?:/i,
    finding: {
      what: 'It loads a stylesheet or font from the internet.',
      why: 'That request cannot be made from inside a container, so the app opens unstyled.',
      fix: 'Ask for the CSS written inline, and system fonts instead of Google Fonts.',
    },
  },
  {
    pattern: /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|EventSource/,
    finding: {
      what: 'It tries to talk to a server.',
      why: 'Containers cannot open connections at all, so the call fails and may stop everything after it.',
      fix: 'Ask your assistant to store the data in the SQLite database with window.dai instead of calling an API.',
    },
  },
  {
    pattern: /<img[^>]+src\s*=\s*["']https?:/i,
    finding: {
      what: 'It shows an image hosted somewhere else.',
      why: 'The image will not load, leaving a broken picture.',
      fix: 'Ask for an inline SVG or an emoji instead of a hosted image.',
    },
  },
  {
    pattern: /localStorage|sessionStorage|indexedDB/i,
    finding: {
      what: 'It saves data in browser storage.',
      why: 'That storage belongs to the browser, not to the file, so the data does not travel with it — email the file to somebody and it arrives empty.',
      fix: 'Ask for the data stored in the SQLite database with window.dai.openDatabase() so it lives inside the file.',
    },
  },
];

const findings = computed<Finding[]>(() => {
  if (!source.value.trim()) return [];
  return CHECKS.filter((check) => check.pattern.test(source.value)).map((check) => check.finding);
});

/**
 * A top-level `await` in a classic script is a syntax error, and the app dies
 * before it draws anything. Checked separately because it is the one mistake
 * this project has already shipped once.
 */
const needsModule = computed(() => {
  const classic = /<script(?![^>]*type\s*=\s*["']module["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = classic.exec(source.value)) !== null) {
    if (/^[^\n]*\bawait\b/m.test(match[1] ?? '')) return true;
  }
  return false;
});

const usesDatabase = computed(() => /window\.dai|dai\.openDatabase/.test(source.value));
const ready = computed(() => source.value.trim().length > 0 && state.value !== 'working');

async function copyPrompt(): Promise<void> {
  await navigator.clipboard.writeText(PROMPT);
  promptCopied.value = true;
  setTimeout(() => (promptCopied.value = false), 2000);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function build(): Promise<void> {
  state.value = 'working';
  errorText.value = '';
  try {
    const [template, runtime, wasm, glue] = await Promise.all([
      fetch('/runtime/template.html').then((r) => r.text()),
      fetch('/runtime/dai-runtime.js').then((r) => r.text()),
      fetchBytes('/runtime/sqlite3.wasm'),
      fetchBytes('/runtime/sqlite3.mjs'),
    ]);

    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    let binary = '';
    for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);

    const built = await buildContainer({
      files: { 'index.html': new TextEncoder().encode(source.value) },
      template,
      runtime,
      appName: appName.value.trim() || 'My App',
      wasm,
      glue,
      signingKey: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`,
    });

    const blob = new Blob([built.html], { type: 'text/html' });
    downloadUrl.value = URL.createObjectURL(blob);
    fileSize.value = blob.size;
    state.value = 'done';
  } catch (error) {
    errorText.value = String(error);
    state.value = 'error';
  }
}
</script>

<template>
  <div class="make">
    <section>
      <h2>1. Ask an assistant for what you want</h2>
      <p>
        Copy this, paste it into ChatGPT, Claude or Gemini, and finish the last
        line with the thing you want — a workout log, a recipe box, a tracker
        for your sourdough starter. The instructions tell it how to write
        something that works inside a file.
      </p>
      <button class="secondary" @click="copyPrompt">
        {{ promptCopied ? 'Copied' : 'Copy the prompt' }}
      </button>
      <details>
        <summary>See what it says</summary>
        <pre><code>{{ PROMPT }}</code></pre>
      </details>
    </section>

    <section>
      <h2>2. Paste what it gives you back</h2>
      <p class="muted">
        The whole HTML file. This never leaves your browser — there is no server
        in this page, which is rather the point.
      </p>

      <label class="name">
        Call it
        <input v-model="appName" type="text" placeholder="My App" />
      </label>

      <textarea v-model="source" spellcheck="false" placeholder="Paste the code here…" />

      <div v-if="source.trim()" class="checks">
        <div v-if="findings.length === 0 && !needsModule" class="clear">
          <strong>Nothing here looks like it will break.</strong>
          <span v-if="usesDatabase">
            It saves into the file, so it will remember things between openings.
          </span>
          <span v-else>
            It does not save anything, so it starts fresh every time — fine for a
            calculator, not for a list.
          </span>
        </div>

        <template v-else>
          <p class="warn"><strong>Some of this will not work inside a file.</strong></p>

          <div v-if="needsModule" class="finding">
            <p class="what">It uses <code>await</code> in a plain script tag.</p>
            <p class="why">That is a syntax error, so the app opens completely blank.</p>
            <p class="fix">
              Ask your assistant to add <code>type="module"</code> to the script tag.
            </p>
          </div>

          <div v-for="(finding, index) in findings" :key="index" class="finding">
            <p class="what">{{ finding.what }}</p>
            <p class="why">{{ finding.why }}</p>
            <p class="fix">{{ finding.fix }}</p>
          </div>

          <p class="muted">
            You can build it anyway. These are warnings, not rules, and you may
            know something the check does not.
          </p>
        </template>
      </div>
    </section>

    <section>
      <h2>3. Take your file</h2>
      <button :disabled="!ready" @click="build">
        {{ state === 'working' ? 'Building…' : 'Build my file' }}
      </button>

      <p v-if="errorText" class="bad">{{ errorText }}</p>

      <div v-if="state === 'done'" class="result">
        <a :href="downloadUrl" :download="downloadName" class="download">
          Download {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
        </a>
        <p>
          Double-click it. It opens in your browser, works with the wifi off, and
          you can send it to anyone.
        </p>
        <p class="muted">
          It was signed with a key created in this tab and then thrown away. That
          proves the file has not been altered since you built it. It does not
          prove who built it — for that you need a key you keep, which is what the
          <a href="/docs/quickstart">command line tool</a> is for.
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.make { margin: 24px 0; }
section { margin-bottom: 44px; }
h2 { border: 0; padding: 0; margin: 0 0 8px; font-size: 20px; }
.muted { color: var(--vp-c-text-2); }
.bad { color: var(--vp-c-red-1); }
.name { display: block; margin: 16px 0 8px; font-size: 14px; color: var(--vp-c-text-2); }
.name input {
  margin-left: 8px; padding: 6px 10px; font: inherit;
  border: 1px solid var(--vp-c-divider); border-radius: 6px;
  background: var(--vp-c-bg); color: var(--vp-c-text-1);
}
textarea {
  width: 100%; min-height: 260px; padding: 12px;
  font-family: var(--vp-font-family-mono); font-size: 12px; line-height: 1.5;
  color: var(--vp-c-text-1); background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider); border-radius: 8px;
}
details { margin-top: 12px; }
details pre {
  padding: 12px; font-size: 12px; border-radius: 8px; white-space: pre-wrap;
  background: var(--vp-c-bg-alt); border: 1px solid var(--vp-c-divider);
}
.checks { margin-top: 16px; }
.clear {
  padding: 12px 16px; border-radius: 8px;
  background: var(--vp-c-green-soft); border: 1px solid var(--vp-c-green-1);
}
.warn { color: var(--vp-c-yellow-1); margin-bottom: 12px; }
.finding {
  padding: 12px 16px; margin-bottom: 10px; border-radius: 8px;
  background: var(--vp-c-bg-alt); border: 1px solid var(--vp-c-divider);
}
.finding p { margin: 0 0 4px; font-size: 14px; }
.finding .what { font-weight: 600; }
.finding .why { color: var(--vp-c-text-2); }
.finding .fix { margin-bottom: 0; }
button {
  padding: 9px 18px; font-size: 15px; border-radius: 8px; cursor: pointer;
  color: var(--vp-c-white); background: var(--vp-c-brand-1); border: 1px solid var(--vp-c-brand-1);
}
button.secondary { color: var(--vp-c-text-1); background: transparent; border-color: var(--vp-c-divider); }
button:disabled { opacity: 0.55; cursor: default; }
.result { margin-top: 20px; }
.download {
  display: inline-block; padding: 12px 20px; margin-bottom: 14px;
  font-size: 16px; font-weight: 600; border-radius: 8px;
  color: var(--vp-c-white) !important; background: var(--vp-c-green-1);
  text-decoration: none;
}
</style>
