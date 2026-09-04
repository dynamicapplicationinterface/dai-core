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
import { useFileHandoff } from './useFileHandoff.js';
import { compileInBrowser, loadRuntimeAssets } from '../../src/browser.js';
import { handOffToOpener } from '../../src/handoff-tab.js';

/*
 * The example, imported from the repository rather than copied into this file.
 * It is the same source the command line compiles and the tests drive, so the
 * code shown on this page cannot drift from the file the visitor downloads.
 */
import APP_HTML from '../../examples/tasks/index.html?raw';
import APP_CSS from '../../examples/tasks/app.css?raw';
import APP_JS from '../../examples/tasks/app.js?raw';

const FILES: { name: string; source: string }[] = [
  { name: 'index.html', source: APP_HTML },
  { name: 'app.css', source: APP_CSS },
  { name: 'app.js', source: APP_JS },
];
const openFile = ref(0);

interface Turn {
  who: 'you' | 'assistant';
  text: string;
  /** Whether this turn shows the application source. */
  files?: boolean;
}

const TRANSCRIPT: Turn[] = [
  {
    who: 'you',
    text: 'I want a simple task list I can keep on my laptop. Nothing online, no account.',
  },
  {
    who: 'assistant',
    text:
      'Here is a task list with projects, priorities and tags. It keeps everything in a ' +
      'SQLite database that lives inside the file itself, so there is no server and no account.',
    files: true,
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
const builtFile = ref<File | null>(null);
const builtBytes = ref<Uint8Array | null>(null);
const openState = ref<'idle' | 'opening' | 'failed'>('idle');
const openError = ref('');

/*
 * The deployed opener, unless this page is itself local — otherwise a
 * development build hands its document to production, which works and proves
 * nothing about the code being changed.
 */
const OPENER =
  typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? 'http://localhost:5175'
    : 'https://opendai.app';

/**
 * Opens the built document in the opener directly, with no download.
 *
 * `window.open` first and synchronously: a popup opened after an await is
 * blocked, and a blocked popup is indistinguishable from a dead button.
 */
async function openInOpener(): Promise<void> {
  const bytes = builtBytes.value;
  if (!bytes) return;

  const tab = window.open(`${OPENER}/#handoff`, '_blank');
  if (!tab) {
    openState.value = 'failed';
    openError.value =
      'Your browser blocked the new tab. Allow pop-ups for this page, or download the file and open it at opendai.app.';
    return;
  }

  openState.value = 'opening';
  try {
    await handOffToOpener(tab, { name: downloadName, bytes }, { origin: OPENER, window });
    openState.value = 'idle';
  } catch (error) {
    openState.value = 'failed';
    openError.value = String((error as Error)?.message ?? error);
  }
}
const { canShareFile, share: shareBuilt, shareError } = useFileHandoff(
  builtFile,
  downloadName,
  // Carried into whatever the sheet sends this to. Somebody who is handed a
  // container and has nothing installed gets a file their system cannot name;
  // the message it arrives in is the one place an answer fits.
  'A DAI document — the app and its data in one file. Open it at opendai.app',
);

/** The build step appears once the conversation has finished replaying. */
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

/** Compiles the source above into a real, signed, downloadable application. */
async function build(): Promise<void> {
  buildState.value = 'working';
  buildLog.value = [];
  errorText.value = '';

  try {
    log('Fetching the container shell, bootloader and SQLite engine…');
    const assets = await loadRuntimeAssets();

    log('Minting a signing key in this browser…');
    log('Sealing everything into one file…');
    const built = await compileInBrowser({
      files: Object.fromEntries(FILES.map((file) => [file.name, file.source])),
      appName: 'My Tasks',
      assets,
    });

    builtBytes.value = new TextEncoder().encode(built.html);
    const blob = new Blob([built.html], { type: 'text/html' });
    builtFile.value = new File([blob], downloadName, { type: 'text/html' });
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
          <div v-if="turn.files" class="files">
            <div class="tabs">
              <button
                v-for="(file, at) in FILES"
                :key="file.name"
                :class="{ 'is-open': openFile === at }"
                @click="openFile = at"
              >
                {{ file.name }}
              </button>
            </div>
            <pre><code>{{ FILES[openFile].source }}</code></pre>
          </div>
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
        <!--
          One control, not two. Where the device can take the file directly the
          download link is the route we know does nothing there, and offering
          both asks somebody to guess which of two identical-looking buttons is
          the one that works. It appears only if the share sheet actually
          fails — which is the moment the sentence about it becomes true.
        -->
        <button class="download" type="button" :disabled="openState === 'opening'" @click="openInOpener">
          {{ openState === 'opening' ? 'Opening…' : 'Open it now' }}
        </button>
        <p v-if="openState === 'failed'" class="bad">{{ openError }}</p>

        <button v-if="canShareFile" class="download secondary" type="button" @click="shareBuilt">
          Save {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
        </button>
        <a
          v-if="!canShareFile || shareError"
          :href="downloadUrl"
          :download="downloadName"
          class="download secondary"
        >
          Download {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
        </a>

        <p v-if="shareError" class="bad">{{ shareError }}</p>

        <!--
          Was three steps beginning with Save to Files: save it, leave the
          browser, find it, pick it out of a chooser. Everybody who did that
          was doing it because the builder had no way to hand the document to
          the opener. It has one now.
        -->
        <ol v-if="canShareFile">
          <li>It opens in a new tab and runs there. Nothing is uploaded.</li>
          <li>Add a task. It is saved onto this device, and nowhere else.</li>
          <li>
            Tap <strong>Share</strong> then <strong>Add to Home Screen</strong>, and it
            becomes an app you open from your home screen with your data still in it.
          </li>
        </ol>
        <ol v-else>
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
.files { border: 1px solid var(--vp-c-divider); border-radius: 8px; overflow: hidden; }
.tabs { display: flex; background: var(--vp-c-bg); border-bottom: 1px solid var(--vp-c-divider); }
.tabs button {
  padding: 7px 14px; border: 0; background: none; cursor: pointer;
  font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--vp-c-text-2);
  border-bottom: 2px solid transparent;
}
.tabs button.is-open { color: var(--vp-c-text-1); border-bottom-color: var(--vp-c-brand-1); }
.body pre {
  margin: 0; padding: 12px; max-height: 260px; overflow: auto;
  font-size: 12px; background: var(--vp-c-bg); border: 0;
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
  text-decoration: none; border: 0; cursor: pointer; font-family: inherit;
}
/*
 * The fallback, where a device can take the file directly. Kept visible rather
 * than hidden: a download that silently does nothing is how this page failed on
 * a phone, and removing the other route would repeat that in the other
 * direction on a device we guessed wrong about.
 */
.download.secondary {
  margin-left: 12px;
  color: var(--vp-c-text-1) !important;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  font-weight: 500;
}
.done ol { margin: 0 0 12px; padding-left: 20px; }
.done li { margin: 6px 0; }
</style>
