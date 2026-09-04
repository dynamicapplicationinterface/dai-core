<script setup lang="ts">
/**
 * The make-one page: from "my AI said go here" to a file that is running.
 *
 * A person arrives in one of two states. Either they have not asked their
 * assistant yet, and need the sentence to paste; or they have, and are holding
 * code and need somewhere to put it. The top of the page routes those two.
 * Below it is the part for somebody who wants to see one made before asking
 * for their own — pick an app, watch it get built, open it.
 *
 * A previous version was a chat replay with three tabs of source and eight
 * paragraphs underneath it. The people this is for do not read source, and
 * they did not read the paragraphs either. The code is still here, because
 * the point is that it is real — it is just folded away until asked for, and
 * what is shown instead is the shape of the thing: a few files go in, one
 * file comes out, and that file runs.
 *
 * Everything after "Make" is real. The source is compiled by the same
 * compiler the command line uses, signed with a key minted in this tab, and
 * the file that results is a working application. Nothing is uploaded.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useFileHandoff } from './useFileHandoff.js';
import { compileInBrowser, loadRuntimeAssets } from '../../src/browser.js';
import { handOffToOpener } from '../../src/handoff-tab.js';
import { IDEAS, PROMPT } from './prompt.js';

/*
 * The examples, imported from the repository rather than copied here: the
 * same files the front page photographs and the screenshot script compiles,
 * so what is shown, what is read and what is handed over cannot drift apart.
 */
import PACKING_HTML from '../../examples/packing-list/index.html?raw';
import PACKING_CSS from '../../examples/packing-list/app.css?raw';
import PACKING_SQL from '../../examples/packing-list/schema.sql?raw';
import CHORES_HTML from '../../examples/chore-chart/index.html?raw';
import CHORES_CSS from '../../examples/chore-chart/app.css?raw';
import CHORES_SQL from '../../examples/chore-chart/schema.sql?raw';
import DINNERS_HTML from '../../examples/meal-plan/index.html?raw';
import DINNERS_CSS from '../../examples/meal-plan/app.css?raw';
import DINNERS_SQL from '../../examples/meal-plan/schema.sql?raw';

interface Choice {
  id: string;
  /** What a person would have typed in the brackets. */
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
    title: 'packing list',
    fileName: 'beach-trip.dai.html',
    appName: 'Beach trip',
    shot: '/shots/home-packing.png',
    alt: 'A packing list for a beach trip',
    files: [
      { name: 'index.html', source: PACKING_HTML },
      { name: 'app.css', source: PACKING_CSS },
      // The tables, declared once. The compiler runs it first and records
      // its shape, so a later version cannot quietly change it.
      { name: 'schema.sql', source: PACKING_SQL },
    ],
  },
  {
    id: 'chores',
    ask: 'a chore chart for the kids',
    title: 'chore chart',
    fileName: 'chores.dai.html',
    appName: 'Chores',
    shot: '/shots/home-chores.png',
    alt: 'A chore chart for two children',
    files: [
      { name: 'index.html', source: CHORES_HTML },
      { name: 'app.css', source: CHORES_CSS },
      // The tables, declared once. The compiler runs it first and records
      // its shape, so a later version cannot quietly change it.
      { name: 'schema.sql', source: CHORES_SQL },
    ],
  },
  {
    id: 'dinners',
    ask: 'our weekly dinner plan',
    title: 'dinner plan',
    fileName: 'this-week.dai.html',
    appName: 'This week',
    shot: '/shots/home-dinners.png',
    alt: 'A week of dinners and a shopping list',
    files: [
      { name: 'index.html', source: DINNERS_HTML },
      { name: 'app.css', source: DINNERS_CSS },
      // The tables, declared once. The compiler runs it first and records
      // its shape, so a later version cannot quietly change it.
      { name: 'schema.sql', source: DINNERS_SQL },
    ],
  },
];

const chosen = ref<Choice>(CHOICES[0]!);
/** See the build section; declared here because the typing watch below reads it. */
const stage = ref(0);
const showCode = ref(false);
const openFile = ref(0);

/** "Chore chart" for a heading, "chore chart" for a sentence. */
const Title = computed(() => chosen.value.title[0]!.toUpperCase() + chosen.value.title.slice(1));

function choose(choice: Choice): void {
  if (chosen.value === choice) return;
  chosen.value = choice;
  openFile.value = 0;
  // A different app is a different build; the old file is not this one.
  stage.value = 0;
  buildState.value = 'idle';
  builtFile.value = null;
  builtBytes.value = null;
  downloadUrl.value = '';
  openState.value = 'idle';
}

/* ---- the ask, typed out ------------------------------------------- */

/*
 * The request appears the way it would in a chat: typed. It is one line and
 * takes under a second, which is enough to read as "this is what you say"
 * rather than as a label. Skipped for anyone who has asked for less motion.
 */
const typed = ref('');
let typing: ReturnType<typeof setInterval> | undefined;

function typeOut(text: string): void {
  clearInterval(typing);
  const still =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (still) {
    typed.value = text;
    if (stage.value === 0) stage.value = 1;
    return;
  }
  typed.value = '';
  let at = 0;
  typing = setInterval(() => {
    at += 1;
    typed.value = text.slice(0, at);
    if (at >= text.length) {
      clearInterval(typing);
      // The request has been made, so the files are in hand: the first stop
      // lights before anyone presses anything, and the button takes it from
      // there.
      if (stage.value === 0) stage.value = 1;
    }
  }, 22);
}

watch(() => chosen.value.ask, typeOut, { immediate: true });
onBeforeUnmount(() => clearInterval(typing));

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

/**
 * How far along the picture is: 0 nothing yet, 1 the files are in hand,
 * 2 they are becoming one file, 3 the file exists, 4 it is open and running.
 */
const buildState = ref<'idle' | 'working' | 'done' | 'error'>('idle');
const downloadUrl = ref('');
const downloadName = computed(() => chosen.value.fileName);
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
    stage.value = 4;
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compiles the chosen example into a real, signed application. */
async function build(): Promise<void> {
  buildState.value = 'working';
  errorText.value = '';

  try {
    // The stages are held on screen for a moment each. The compile itself
    // takes well under a second, and a picture that flashes through three
    // states in that time shows nothing.
    stage.value = 1;
    const assets = await loadRuntimeAssets();
    await pause(300);

    stage.value = 2;
    const built = await compileInBrowser({
      files: Object.fromEntries(chosen.value.files.map((file) => [file.name, file.source])),
      appName: chosen.value.appName,
      assets,
    });
    await pause(700);

    builtBytes.value = new TextEncoder().encode(built.html);
    const blob = new Blob([built.html], { type: 'text/html' });
    builtFile.value = new File([blob], downloadName.value, { type: 'text/html' });
    downloadUrl.value = URL.createObjectURL(blob);
    fileSize.value = blob.size;

    stage.value = 3;
    buildState.value = 'done';
  } catch (error) {
    errorText.value = String(error);
    buildState.value = 'error';
    stage.value = 0;
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
        <p class="kicker">Already have the files?</p>
        <h2>Turn them into your app.</h2>
        <p class="door-text">
          Paste what your assistant gave you, or drop in the folder or zip. It
          becomes one file right here — nothing is uploaded.
        </p>
        <a class="primary as-link" href="/make-your-own">Get my app →</a>
      </div>
    </section>

    <!-- ---------------------------------------------------------- choose -->
    <section class="try">
      <header class="try-head">
        <span class="or">or</span>
        <h2 class="try-title">Try one right here.</h2>
        <p class="try-lede">Nothing to ask, nothing to paste. Pick one and watch it become a file.</p>
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
            <span class="choice-title">{{ choice.title[0]!.toUpperCase() + choice.title.slice(1) }}</span>
          </button>
        </li>
      </ul>

      <!--
        The conversation, as one exchange. It is a replay and looks like one:
        scripting it is fine for a tour and dishonest the moment it pretends
        to be live.
      -->
      <div class="chat" aria-label="What was asked">
        <div class="turn you">
          <span class="who">You</span>
          <div class="said">
            <p>Make me a DAI app for <mark>{{ typed }}</mark><span class="caret" aria-hidden="true"></span></p>
          </div>
        </div>
        <div class="turn assistant">
          <span class="who">AI</span>
          <div class="said">
            <p>
              Here you go — {{ chosen.files.length }} files.
              <button type="button" class="link" @click="showCode = !showCode">
                {{ showCode ? 'Hide them' : 'Peek inside' }}
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
      </div>

      <!-- ----------------------------------------------------------- build -->
      <div class="step">
        <!--
          The shape of what happens, as a picture: a few files go in, one
          file comes out, that file runs. Each stop lights as the build reaches
          it, so "building" is something a person watches rather than a word
          on a button.
        -->
        <ol class="pipeline" :data-stage="stage" aria-label="What happens">
          <li class="stop" :class="{ lit: stage >= 1, now: stage === 1 }">
            <span class="glyph files-glyph" aria-hidden="true">
              <i v-for="file in chosen.files" :key="file.name"></i>
            </span>
            <span class="stop-name">{{ chosen.files.length }} files from your AI</span>
          </li>
          <li class="arrow" :class="{ lit: stage >= 2 }" aria-hidden="true"></li>
          <li class="stop" :class="{ lit: stage >= 2, now: stage === 2 }">
            <span class="glyph one-glyph" aria-hidden="true"><i></i></span>
            <span class="stop-name">One DAI file</span>
          </li>
          <li class="arrow" :class="{ lit: stage >= 3 }" aria-hidden="true"></li>
          <li class="stop" :class="{ lit: stage >= 3, now: stage >= 3 }">
            <span class="glyph run-glyph" aria-hidden="true"><i></i></span>
            <span class="stop-name">Your {{ chosen.title }}, running</span>
          </li>
        </ol>

        <button
          v-if="buildState !== 'done'"
          type="button"
          class="primary big"
          :disabled="buildState === 'working'"
          @click="build"
        >
          {{ buildState === 'working' ? 'Making it…' : `Make my ${chosen.title}` }}
        </button>
        <p v-if="buildState !== 'done'" class="real">
          This part is real. It's made here, in your browser. Nothing is uploaded.
        </p>

        <p v-if="errorText" class="bad">{{ errorText }}</p>

        <div v-if="buildState === 'done'" class="done">
          <p class="done-line">
            Your {{ chosen.title }} is ready. <span class="muted">{{ downloadName }} · {{ Math.round(fileSize / 1024) }} KB · one file</span>
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
.muted { color: var(--vp-c-text-3); font-weight: 400; }

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

/* Stacked. Beside the text, the button escaped the card at every width the
   card is actually shown at. */
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

.ideas { margin: 14px 0 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 13px; }
.ideas-label { flex-basis: 100%; color: var(--vp-c-text-3); }
.idea { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--vp-c-divider); color: var(--vp-c-text-2); }

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
.primary.big { padding: 14px 28px; font-size: 17px; }
.as-link { align-self: flex-start; margin-top: auto; }

.link {
  background: none; border: 0; padding: 0; font: inherit;
  color: var(--vp-c-brand-1); cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
}

/*
 * The docs layout caps every paragraph and list at a reading measure and
 * leaves it on the left, which is right for prose and wrong inside a section
 * where everything else is centred: the picture, the button and the line
 * under it all sat left of centre.
 */
.try p,
.try ol,
.try ul,
.step p,
.step ol { max-width: none; margin-left: auto; margin-right: auto; }

/* ------------------------------------------------------------ choose */

/*
 * A band, so the break from "go do something" to "or stay here" is a thing
 * the eye finds without reading. The first version marked it with a small
 * uppercase label, which is the size of thing people scroll past.
 */
.try {
  margin: 56px -24px 0;
  padding: 40px 24px 44px;
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
}

.try-head { text-align: center; max-width: 34rem; margin: 0 auto; }

.or {
  display: inline-grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: 14px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.try-title { font-size: 2.1rem !important; margin-bottom: 8px !important; }
.try-lede { margin: 0; color: var(--vp-c-text-2); font-size: 1.05rem; }

/*
 * Narrow and tall, so they read as phones. At the width they first shipped
 * they read as iPads, and the three cards came out at three heights because
 * each picture's height was its own business.
 */
.choices {
  list-style: none;
  margin: 28px auto 0;
  padding: 0;
  max-width: 560px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: stretch;
  gap: 16px;
}

/* The docs theme spaces list items with margin-top on every one after the
   first, which made the first card sit higher than the other two. */
.choices li { display: flex; margin: 0; }

.choice {
  width: 100%;
  height: 100%;
  padding: 10px 10px 14px;
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

.choice:hover { border-color: var(--vp-c-text-3); }
.choice.is-chosen { border-color: var(--vp-c-brand-1); box-shadow: 0 0 0 4px var(--vp-c-brand-soft); }

.device {
  display: block; position: relative; width: 100%; aspect-ratio: 390 / 760;
  border-radius: 20px; background: #101318; overflow: hidden;
}
.dark .device { background: #2a2f3a; }
.device img {
  position: absolute; inset: 5px; width: calc(100% - 10px); height: calc(100% - 10px);
  border-radius: 16px; object-fit: cover; object-position: top;
}

.choice-title { font-weight: 600; color: var(--vp-c-text-1); }
.choice.is-chosen .choice-title { color: var(--vp-c-brand-1); }

/* -------------------------------------------------------------- chat */

.chat {
  max-width: 720px;
  margin: 22px auto 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  overflow: hidden;
  background: var(--vp-c-bg);
}

/* Two columns, two children. A third child fell into the narrow column and
   rendered the code forty pixels wide. */
.turn { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 12px; padding: 14px 18px; }
.turn + .turn { border-top: 1px solid var(--vp-c-divider); }
.turn.assistant { background: var(--vp-c-bg-soft); }
.who { font-size: 12px; font-weight: 600; color: var(--vp-c-text-3); padding-top: 3px; }
.said { min-width: 0; }
.said p { margin: 0; line-height: 1.55; }
mark { background: var(--vp-c-brand-soft); color: inherit; padding: 1px 5px; border-radius: 5px; }

.caret {
  display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: -0.15em;
  background: var(--vp-c-text-2); animation: blink 1s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .caret { display: none; } }

.files { margin-top: 12px; border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden; }
.tabs { display: flex; background: var(--vp-c-bg); border-bottom: 1px solid var(--vp-c-divider); }
.tabs button {
  padding: 7px 14px; border: 0; background: none; cursor: pointer;
  font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--vp-c-text-2);
  border-bottom: 2px solid transparent;
}
.tabs button.is-open { color: var(--vp-c-text-1); border-bottom-color: var(--vp-c-brand-1); }
.files pre { margin: 0; padding: 12px; max-height: 320px; overflow: auto; font-size: 12px; background: var(--vp-c-bg); border: 0; }

/* ---------------------------------------------------------- pipeline */

.step { max-width: 720px; margin: 28px auto 0; text-align: center; }

.pipeline {
  list-style: none;
  margin: 0 0 24px;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr 40px 1fr 40px 1fr;
  align-items: center;
  gap: 4px;
}

.pipeline li { margin: 0; }
.stop { display: flex; flex-direction: column; align-items: center; gap: 10px; opacity: 0.45; transition: opacity 0.3s; }
.stop.lit { opacity: 1; }

.glyph {
  position: relative;
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background: var(--vp-c-bg);
  border: 1.5px solid var(--vp-c-divider);
  transition: border-color 0.3s, box-shadow 0.3s;
}
.stop.lit .glyph { border-color: var(--vp-c-brand-1); }
.stop.now .glyph { box-shadow: 0 0 0 5px var(--vp-c-brand-soft); }

/* Two small sheets, fanned. */
.files-glyph { display: block; }
.files-glyph i {
  position: absolute; left: 50%; top: 50%;
  width: 22px; height: 28px; border-radius: 4px;
  background: var(--vp-c-bg); border: 1.5px solid var(--vp-c-text-3);
  transform: translate(-60%, -50%) rotate(-8deg);
}
.files-glyph i + i { transform: translate(-40%, -50%) rotate(8deg); }
.stop.lit .files-glyph i { border-color: var(--vp-c-brand-1); }

/* One sheet, the corner turned. */
.one-glyph i {
  width: 26px; height: 32px; border-radius: 4px;
  background: var(--vp-c-brand-soft); border: 1.5px solid var(--vp-c-brand-1);
  clip-path: polygon(0 0, 70% 0, 100% 25%, 100% 100%, 0 100%);
}

/* A play mark. */
.run-glyph i {
  width: 0; height: 0;
  border-left: 18px solid var(--vp-c-brand-1);
  border-top: 11px solid transparent; border-bottom: 11px solid transparent;
  margin-left: 4px;
}

.stop-name { font-size: 13.5px; font-weight: 500; color: var(--vp-c-text-2); line-height: 1.3; }
.stop.lit .stop-name { color: var(--vp-c-text-1); }

.arrow { height: 2px; background: var(--vp-c-divider); border-radius: 2px; transition: background 0.3s; }
.arrow.lit { background: var(--vp-c-brand-1); }

.real { margin: 12px 0 0; font-size: 14px; color: var(--vp-c-text-3); }
.bad { color: var(--vp-c-red-1); margin: 10px 0 0; }

.done { margin-top: 4px; }
.done-line { margin: 0 0 14px; font-size: 1.15rem; font-weight: 600; }
.done-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; align-items: center; }

.download.secondary {
  display: inline-block; padding: 12px 20px; border-radius: 999px;
  border: 1px solid var(--vp-c-border); background: var(--vp-c-bg);
  color: var(--vp-c-text-1) !important; text-decoration: none !important;
  font: inherit; font-size: 15px; font-weight: 500; cursor: pointer;
}

.after { margin: 18px auto 0; color: var(--vp-c-text-2); line-height: 1.6; max-width: 34rem; }

@media (max-width: 760px) {
  .doors { grid-template-columns: 1fr; }
  .try { margin: 44px -24px 0; padding: 32px 18px 36px; }
  .try-title { font-size: 1.7rem !important; }
  .choices { gap: 10px; }
  .choice { padding: 6px 6px 10px; border-radius: 16px; }
  .device { border-radius: 13px; aspect-ratio: 390 / 640; }
  .device img { inset: 3px; width: calc(100% - 6px); height: calc(100% - 6px); border-radius: 10px; }
  .choice-title { font-size: 13px; }
  .turn { grid-template-columns: 36px minmax(0, 1fr); padding: 12px 14px; }
  .pipeline { grid-template-columns: 1fr 18px 1fr 18px 1fr; }
  .glyph { width: 52px; height: 52px; border-radius: 14px; }
  .stop-name { font-size: 12px; }
}
</style>
