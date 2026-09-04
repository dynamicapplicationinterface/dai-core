<script setup lang="ts">
/**
 * The make-one page: from "my AI said go here" to a file that is running.
 *
 * She arrives in one of two states. Either she has not asked her assistant
 * yet, and needs the sentence to paste; or she has, and is holding code and
 * needs somewhere to put it. The top of the page routes those two. Below it
 * is the part for somebody who wants to see one made before she asks for
 * her own — pick an app, watch it get built, open it.
 *
 * A previous version was a chat replay with three tabs of source and eight
 * paragraphs underneath it. The people this is for do not read source, and
 * they did not read the paragraphs either. The code is still here, because
 * the point is that it is real — it is just folded away until asked for.
 *
 * Everything after "Build" is real. The source is compiled by the same
 * compiler the command line uses, signed with a key minted in this tab, and
 * the file that results is a working application. Nothing is uploaded.
 */
import { computed, ref } from 'vue';
import { useFileHandoff } from './useFileHandoff.js';
import { compileInBrowser, loadRuntimeAssets } from '../../src/browser.js';
import { handOffToOpener } from '../../src/handoff-tab.js';
import { IDEAS, PROMPT } from './prompt.js';

/*
 * The examples, imported from the repository rather than copied here: the
 * same files the front page photographs and the screenshot script compiles,
 * so what she sees, what she reads and what she gets cannot drift apart.
 */
import PACKING_HTML from '../../examples/packing-list/index.html?raw';
import PACKING_CSS from '../../examples/packing-list/app.css?raw';
import CHORES_HTML from '../../examples/chore-chart/index.html?raw';
import CHORES_CSS from '../../examples/chore-chart/app.css?raw';
import DINNERS_HTML from '../../examples/meal-plan/index.html?raw';
import DINNERS_CSS from '../../examples/meal-plan/app.css?raw';

interface Choice {
  id: string;
  /** What she would have typed in the brackets. */
  ask: string;
  title: string;
  fileName: string;
  appName: string;
  shot: string;
  alt: string;
  files: { name: string; source: string }[];
}

const CHOICES: Choice[] = [
  {
    id: 'packing',
    ask: 'a packing list for our beach trip',
    title: 'Packing list',
    fileName: 'beach-trip.dai.html',
    appName: 'Beach trip',
    shot: '/shots/home-packing.png',
    alt: 'A packing list for a beach trip',
    files: [
      { name: 'index.html', source: PACKING_HTML },
      { name: 'app.css', source: PACKING_CSS },
    ],
  },
  {
    id: 'chores',
    ask: 'a chore chart for the kids',
    title: 'Chore chart',
    fileName: 'chores.dai.html',
    appName: 'Chores',
    shot: '/shots/home-chores.png',
    alt: 'A chore chart for two children',
    files: [
      { name: 'index.html', source: CHORES_HTML },
      { name: 'app.css', source: CHORES_CSS },
    ],
  },
  {
    id: 'dinners',
    ask: 'our weekly dinner plan',
    title: 'Dinner plan',
    fileName: 'this-week.dai.html',
    appName: 'This week',
    shot: '/shots/home-dinners.png',
    alt: 'A week of dinners and a shopping list',
    files: [
      { name: 'index.html', source: DINNERS_HTML },
      { name: 'app.css', source: DINNERS_CSS },
    ],
  },
];

const chosen = ref<Choice>(CHOICES[0]!);
const showCode = ref(false);
const openFile = ref(0);

function choose(choice: Choice): void {
  if (chosen.value === choice) return;
  chosen.value = choice;
  openFile.value = 0;
  // A different app is a different build; the old file is not this one.
  buildState.value = 'idle';
  buildLog.value = [];
  builtFile.value = null;
  builtBytes.value = null;
  downloadUrl.value = '';
  openState.value = 'idle';
}

/* ---- the prompt ---------------------------------------------------- */

const copied = ref(false);

async function copyPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(PROMPT);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    // No clipboard. The text is on screen and selectable.
  }
}

/* ---- the build ----------------------------------------------------- */

const buildState = ref<'idle' | 'working' | 'done' | 'error'>('idle');
const buildLog = ref<string[]>([]);
const downloadUrl = ref('');
const downloadName = computed(() => chosen.value.fileName);
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
    await handOffToOpener(tab, { name: downloadName.value, bytes }, { origin: OPENER, window });
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
  // file and has nothing installed gets a document their system cannot name;
  // the message it arrives in is the one place an answer fits.
  'A DAI document — the app and its data in one file. Open it at opendai.app',
);

function log(line: string): void {
  buildLog.value = [...buildLog.value, line];
}

/** Compiles the chosen example into a real, signed application. */
async function build(): Promise<void> {
  buildState.value = 'working';
  buildLog.value = [];
  errorText.value = '';

  try {
    log('Getting the pieces every file carries…');
    const assets = await loadRuntimeAssets();

    log('Making a key in this browser and signing with it…');
    log('Putting everything into one file…');
    const built = await compileInBrowser({
      files: Object.fromEntries(chosen.value.files.map((file) => [file.name, file.source])),
      appName: chosen.value.appName,
      assets,
    });

    builtBytes.value = new TextEncoder().encode(built.html);
    const blob = new Blob([built.html], { type: 'text/html' });
    builtFile.value = new File([blob], downloadName.value, { type: 'text/html' });
    downloadUrl.value = URL.createObjectURL(blob);
    fileSize.value = blob.size;
    fingerprint.value = built.publicKeyFingerprint ?? '';

    log(`Done — ${Math.round(blob.size / 1024)} KB.`);
    buildState.value = 'done';
  } catch (error) {
    errorText.value = String(error);
    buildState.value = 'error';
  }
}
</script>

<template>
  <div class="maker">
    <!-- ------------------------------------------------------- two doors -->
    <section class="doors">
      <div class="door">
        <p class="kicker">Haven't asked yet?</p>
        <h2>Copy this to your AI.</h2>
        <div class="prompt-box">
          <p class="prompt-text">{{ PROMPT }}</p>
          <button type="button" class="primary" @click="copyPrompt">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <p class="ideas">
          <span class="ideas-label">Change the part in brackets to anything:</span>
          <span v-for="idea in IDEAS" :key="idea" class="idea">{{ idea }}</span>
        </p>
      </div>

      <div class="door">
        <p class="kicker">Already have the code?</p>
        <h2>Turn it into a file.</h2>
        <p class="door-text">
          Paste what your assistant gave you, or drop in the folder or zip. It
          becomes a file right here — nothing is uploaded.
        </p>
        <a class="primary as-link" href="/make-your-own">Paste my code →</a>
      </div>
    </section>

    <!-- ---------------------------------------------------------- choose -->
    <section class="try">
      <header class="try-head">
        <p class="kicker">Or see one made first</p>
        <h2>Pick one. Watch it become a file.</h2>
      </header>

      <ul class="choices" role="list">
        <li v-for="choice in CHOICES" :key="choice.id">
          <button
            type="button"
            class="choice"
            :class="{ 'is-chosen': chosen === choice }"
            :aria-pressed="chosen === choice"
            @click="choose(choice)"
          >
            <span class="device"><img :src="choice.shot" :alt="choice.alt" loading="lazy" /></span>
            <span class="choice-title">{{ choice.title }}</span>
          </button>
        </li>
      </ul>

      <!--
        The conversation, as one exchange. It is a replay and says so: scripting
        it is fine for a tour and dishonest the moment it pretends to be live.
      -->
      <div class="chat" aria-label="What was asked">
        <div class="turn you">
          <span class="who">You</span>
          <p>Make me a DAI app for <mark>{{ chosen.ask }}</mark>.</p>
        </div>
        <div class="turn assistant">
          <span class="who">AI</span>
          <p>
            Here it is — {{ chosen.files.length }} short files.
            <button type="button" class="link" @click="showCode = !showCode">
              {{ showCode ? 'Hide the code' : 'Show the code' }}
            </button>
          </p>
          <div v-if="showCode" class="files">
            <div class="tabs">
              <button
                v-for="(file, at) in chosen.files"
                :key="file.name"
                type="button"
                :class="{ 'is-open': openFile === at }"
                @click="openFile = at"
              >
                {{ file.name }}
              </button>
            </div>
            <pre><code>{{ chosen.files[openFile]?.source }}</code></pre>
          </div>
        </div>
      </div>

      <!-- ----------------------------------------------------------- build -->
      <div class="step">
        <p class="real">
          <strong>This part is real.</strong> The code is turned into a file here, in your
          browser. Nothing is uploaded.
        </p>

        <button
          v-if="buildState !== 'done'"
          type="button"
          class="primary big"
          :disabled="buildState === 'working'"
          @click="build"
        >
          {{ buildState === 'working' ? 'Building…' : `Build the ${chosen.title.toLowerCase()}` }}
        </button>

        <ul v-if="buildLog.length && buildState !== 'done'" class="log">
          <li v-for="(line, index) in buildLog" :key="index">{{ line }}</li>
        </ul>

        <p v-if="errorText" class="bad">{{ errorText }}</p>

        <div v-if="buildState === 'done'" class="done">
          <p class="done-line">
            Done. <strong>{{ downloadName }}</strong> — {{ Math.round(fileSize / 1024) }} KB, one file.
          </p>

          <div class="done-actions">
            <button type="button" class="primary big" :disabled="openState === 'opening'" @click="openInOpener">
              {{ openState === 'opening' ? 'Opening…' : 'Open it now' }}
            </button>
            <button v-if="canShareFile" type="button" class="download secondary" @click="shareBuilt">
              Save {{ downloadName }}
            </button>
            <a
              v-if="!canShareFile || shareError"
              :href="downloadUrl"
              :download="downloadName"
              class="download secondary"
            >
              Download {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
            </a>
          </div>
          <p v-if="openState === 'failed'" class="bad">{{ openError }}</p>
          <p v-if="shareError" class="bad">{{ shareError }}</p>

          <p class="after">
            It opens in a new tab and runs there. Add something, and it's saved on this
            device and nowhere else. On a phone, tap <strong>Share</strong> then
            <strong>Add to Home Screen</strong> to keep it.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.maker { margin: 8px 0 0; }

.kicker {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

h2 {
  margin: 0 0 14px !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 1.6rem !important;
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.15;
  text-wrap: balance;
}

/* ------------------------------------------------------------- doors */

.doors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.door {
  padding: 26px 26px 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background: var(--vp-c-bg-soft);
  display: flex;
  flex-direction: column;
}

.door-text { margin: 0 0 18px; color: var(--vp-c-text-2); line-height: 1.6; }

/* Stacked. Beside the text, the button escaped the card at every width the card
   is actually shown at. */
.prompt-box {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  padding: 14px 14px 14px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg);
}

.prompt-text { margin: 0; font-size: 14.5px; line-height: 1.5; user-select: all; overflow-wrap: anywhere; }
.prompt-box .primary { align-self: flex-end; }

.ideas {
  margin: 14px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}

.ideas-label { flex-basis: 100%; color: var(--vp-c-text-3); }

.idea {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}

/* ----------------------------------------------------------- buttons */

.primary {
  display: inline-block;
  padding: 10px 18px;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  border-radius: 999px;
  border: 1px solid var(--vp-c-brand-1);
  background: var(--vp-c-brand-1);
  color: #fff !important;
  text-decoration: none !important;
  cursor: pointer;
  white-space: nowrap;
}

.primary:hover { background: var(--vp-c-brand-2); border-color: var(--vp-c-brand-2); }
.primary:disabled { opacity: 0.6; cursor: default; }
.primary.big { padding: 13px 26px; font-size: 16px; }
.as-link { align-self: flex-start; margin-top: auto; }

.link {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--vp-c-brand-1);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* ------------------------------------------------------------ choose */

.try { margin-top: 64px; }
.try-head { max-width: 34rem; }

.choices {
  list-style: none;
  margin: 22px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.choice {
  width: 100%;
  padding: 12px 12px 14px;
  border: 2px solid var(--vp-c-divider);
  border-radius: 22px;
  background: var(--vp-c-bg);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}

.choice:hover { transform: translateY(-2px); border-color: var(--vp-c-text-3); }

.choice.is-chosen {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 4px var(--vp-c-brand-soft);
}

.device {
  display: block;
  width: 100%;
  padding: 5px;
  border-radius: 20px;
  background: #101318;
}

.dark .device { background: #2a2f3a; }

.device img {
  display: block;
  width: 100%;
  border-radius: 16px;
  aspect-ratio: 390 / 560;
  object-fit: cover;
  object-position: top;
}

.choice-title { font-weight: 600; color: var(--vp-c-text-1); }
.choice.is-chosen .choice-title { color: var(--vp-c-brand-1); }

/* -------------------------------------------------------------- chat */

.chat {
  margin-top: 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  overflow: hidden;
}

.turn { display: grid; grid-template-columns: 48px 1fr; gap: 12px; padding: 14px 18px; }
.turn + .turn { border-top: 1px solid var(--vp-c-divider); }
.turn.assistant { background: var(--vp-c-bg-alt); }
.who { font-size: 12px; font-weight: 600; color: var(--vp-c-text-3); padding-top: 3px; }
.turn p { margin: 0; line-height: 1.55; }
mark { background: var(--vp-c-brand-soft); color: inherit; padding: 1px 5px; border-radius: 5px; }

.files { margin-top: 12px; border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden; }
.tabs { display: flex; background: var(--vp-c-bg); border-bottom: 1px solid var(--vp-c-divider); }
.tabs button {
  padding: 7px 14px; border: 0; background: none; cursor: pointer;
  font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--vp-c-text-2);
  border-bottom: 2px solid transparent;
}
.tabs button.is-open { color: var(--vp-c-text-1); border-bottom-color: var(--vp-c-brand-1); }
.files pre { margin: 0; padding: 12px; max-height: 320px; overflow: auto; font-size: 12px; background: var(--vp-c-bg); border: 0; }

/* ------------------------------------------------------------- build */

.step { margin-top: 26px; }
.real { margin: 0 0 14px; color: var(--vp-c-text-2); }
.real strong { color: var(--vp-c-text-1); }
.log { margin: 14px 0 0; padding-left: 18px; font-size: 13.5px; color: var(--vp-c-text-2); }
.bad { color: var(--vp-c-red-1); margin: 10px 0 0; }

.done { margin-top: 4px; }
.done-line { margin: 0 0 14px; font-size: 1.05rem; }
.done-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }

.download.secondary {
  display: inline-block;
  padding: 12px 20px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1) !important;
  text-decoration: none !important;
  font: inherit;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}

.after { margin: 18px 0 0; color: var(--vp-c-text-2); line-height: 1.6; max-width: 34rem; }

@media (max-width: 760px) {
  .doors { grid-template-columns: 1fr; }
  .choices { gap: 10px; }
  .choice { padding: 6px 6px 10px; border-radius: 16px; }
  .device { padding: 3px; border-radius: 13px; }
  .device img { border-radius: 10px; aspect-ratio: 390 / 500; }
  .choice-title { font-size: 13px; }
  .turn { grid-template-columns: 36px 1fr; padding: 12px 14px; }
}
</style>
