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
import { useFileHandoff } from './useFileHandoff.js';
import { compileInBrowser, isNoise, stripCommonPrefix, unpackZip } from '../../src/browser.js';
import { lintFiles, storesDataInFile, type Finding } from '../../src/lint.js';
import { RECIPE_AS_PROMPT as PROMPT } from '../../src/recipe.js';

interface Loaded {
  name: string;
  bytes: Uint8Array;
}

/*
 * Files first, pasting second. A real application is several files, and a model
 * that has written one hands it over as a folder or a zip, because a folder is
 * not something you can paste into a chat window. Asking for a single pasted
 * document meant asking people to flatten their app by hand before they could
 * use this at all.
 */
const files = ref<Loaded[]>([]);
const source = ref('');
const dragging = ref(false);
const promptCopied = ref(false);
const state = ref<'idle' | 'working' | 'done' | 'error'>('idle');
const errorText = ref('');
const downloadUrl = ref('');
const builtFile = ref<File | null>(null);
const fileSize = ref(0);
const appName = ref('My App');

const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();

const downloadName = computed(() => {
  const slug = appName.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'my-app'}.dai.html`;
});
const { canShareFile, share, shareError } = useFileHandoff(builtFile, downloadName);

/** What the checks can read. Binary files are not worth decoding. */
const readable = computed<Record<string, string>>(() => {
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  for (const file of files.value) {
    if (/\.(?:html?|m?js|ts|css)$/i.test(file.name)) out[file.name] = decoder.decode(file.bytes);
  }
  if (files.value.length === 0 && source.value.trim()) out['index.html'] = source.value;
  return out;
});

const findings = computed<(Finding & { file: string })[]>(() => lintFiles(readable.value));

// Separated because these two break an app outright, while the rest only
// degrade one — worth saying first, and worth saying differently.
const blocking = computed(() =>
  findings.value.filter(
    (finding) => finding.id === 'await-in-classic-script' || finding.id === 'cdn-script',
  ),
);
const warnings = computed(() =>
  findings.value.filter((finding) => !blocking.value.includes(finding)),
);

const hasEntry = computed(() =>
  files.value.length > 0
    ? files.value.some((file) => file.name === 'index.html')
    : source.value.trim().length > 0,
);

const anything = computed(() => files.value.length > 0 || source.value.trim().length > 0);
const totalSize = computed(() => files.value.reduce((sum, file) => sum + file.bytes.byteLength, 0));
const usesDatabase = computed(() =>
  Object.values(readable.value).some((text) => storesDataInFile(text)),
);
const ready = computed(() => hasEntry.value && state.value !== 'working');

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

async function accept(list: FileList | null): Promise<void> {
  if (!list || list.length === 0) return;
  state.value = 'idle';
  errorText.value = '';

  const picked = [...list];

  // A single archive is the common case: it is what an assistant produces when
  // asked for more than one file.
  if (picked.length === 1 && /\.zip$/i.test(picked[0]!.name)) {
    try {
      const unpacked = unpackZip(new Uint8Array(await picked[0]!.arrayBuffer()));
      files.value = Object.entries(unpacked)
        .filter(([name]) => !isNoise(name))
        .map(([name, bytes]) => ({ name, bytes }));
      if (appName.value === 'My App') appName.value = picked[0]!.name.replace(/\.zip$/i, '');
    } catch (error) {
      errorText.value = `That zip could not be read: ${String(error)}`;
    }
    return;
  }

  const loaded: Record<string, Uint8Array> = {};
  for (const file of picked) {
    // webkitRelativePath is set when a folder was chosen, so nesting survives.
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (isNoise(path)) continue;
    loaded[path] = new Uint8Array(await file.arrayBuffer());
  }

  files.value = Object.entries(stripCommonPrefix(loaded)).map(([name, bytes]) => ({ name, bytes }));

  const folder = (picked[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (appName.value === 'My App' && folder && folder.includes('/')) {
    appName.value = folder.split('/')[0]!;
  }
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  void accept(event.dataTransfer?.files ?? null);
}

function clearFiles(): void {
  files.value = [];
  state.value = 'idle';
  if (fileInput.value) fileInput.value.value = '';
  if (folderInput.value) folderInput.value.value = '';
}

async function copyPrompt(): Promise<void> {
  await navigator.clipboard.writeText(PROMPT);
  promptCopied.value = true;
  setTimeout(() => (promptCopied.value = false), 2000);
}

async function build(): Promise<void> {
  state.value = 'working';
  errorText.value = '';
  try {
    const payload: Record<string, Uint8Array | string> =
      files.value.length > 0
        ? Object.fromEntries(files.value.map((file) => [file.name, file.bytes]))
        : { 'index.html': source.value };

    const built = await compileInBrowser({
      files: payload,
      appName: appName.value.trim() || 'My App',
    });

    const blob = new Blob([built.html], { type: 'text/html' });
    builtFile.value = new File([blob], downloadName.value, { type: 'text/html' });
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
      <h2>1. Ask an assistant</h2>
      <p>
        Copy this, paste it into ChatGPT, Claude or Gemini, and finish the last
        line with what you want — a workout log, a recipe box, a tracker for
        your sourdough starter. Then ask it for the files, or for a zip.
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
      <h2>2. Bring the files</h2>
      <p class="muted">
        A folder, or the zip it gave you. Nothing is uploaded — the file is built
        here in this tab, which is rather the point.
      </p>

      <div
        class="drop"
        :class="{ dragging, filled: files.length > 0 }"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <template v-if="files.length === 0">
          <p class="drop-title">Drop a folder or a zip here</p>
          <div class="drop-actions">
            <button class="secondary" @click="fileInput?.click()">Choose files</button>
            <button class="secondary" @click="folderInput?.click()">Choose a folder</button>
          </div>
        </template>

        <template v-else>
          <div class="loaded-head">
            <strong>{{ files.length }} files · {{ size(totalSize) }}</strong>
            <button class="quiet" @click="clearFiles">Clear</button>
          </div>
          <ul class="loaded">
            <li
              v-for="file in files"
              :key="file.name"
              :class="{ entry: file.name === 'index.html' }"
            >
              <code>{{ file.name }}</code>
              <span>{{ size(file.bytes.byteLength) }}</span>
            </li>
          </ul>
        </template>
      </div>

      <input
        ref="fileInput"
        type="file"
        multiple
        hidden
        @change="accept(($event.target as HTMLInputElement).files)"
      />
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        hidden
        @change="accept(($event.target as HTMLInputElement).files)"
      />

      <details class="paste">
        <summary>Or paste a single HTML file</summary>
        <textarea v-model="source" spellcheck="false" placeholder="Paste the code here…" />
      </details>

      <label class="name">
        Call it
        <input v-model="appName" type="text" placeholder="My App" />
      </label>

      <div v-if="anything" class="checks">
        <div v-if="files.length > 0 && !hasEntry" class="finding blocking">
          <p class="what">There is no index.html.</p>
          <p class="why">A container opens index.html first, so this would show nothing.</p>
          <p class="fix">Rename your main page to index.html and drop the files in again.</p>
        </div>

        <div v-if="findings.length === 0 && hasEntry" class="clear">
          <strong>Nothing here looks like it will break.</strong>
          <span v-if="usesDatabase">
            It saves into the file, so it will remember things between openings.
          </span>
          <span v-else>
            It does not save anything, so it starts fresh every time — fine for a
            calculator, not for a list.
          </span>
        </div>

        <template v-else-if="findings.length > 0">
          <p class="warn"><strong>Some of this will not work inside a file.</strong></p>

          <div
            v-for="(finding, index) in [...blocking, ...warnings]"
            :key="index"
            class="finding"
            :class="{ blocking: blocking.includes(finding) }"
          >
            <p class="what"><code>{{ finding.file }}</code> — {{ finding.what }}</p>
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
        <!-- One control. See MakerWalkthrough: the second appears only if the
             share sheet fails, because until then it is a button we know does
             nothing on this device. -->
        <button v-if="canShareFile" class="download" type="button" @click="share">
          Save {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
        </button>
        <a
          v-if="!canShareFile || shareError"
          :href="downloadUrl"
          :download="downloadName"
          class="download"
          :class="{ secondary: canShareFile }"
        >
          Download {{ downloadName }} ({{ Math.round(fileSize / 1024) }} KB)
        </a>
        <p v-if="shareError" class="bad">{{ shareError }}</p>
        <p v-if="canShareFile">
          Choose <strong>Save to Files</strong>, then open
          <a href="https://run.dynamicapplicationinterface.io">the runner</a> and pick it
          there. A phone cannot run a file straight from storage, so the runner is what
          opens it.
        </p>
        <p v-else>
          Double-click it. It opens in your browser, works with the wifi off, and
          you can send it to anyone.
        </p>
        <p class="muted">
          It was signed with a key created in this tab and then thrown away. That
          proves the file has not been altered since you built it. It does not
          prove who built it — for that you need a key you keep, which is what the
          <a href="/docs/making-files">command line</a> is for.
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
.drop {
  padding: 26px 22px;
  border: 1.5px dashed var(--vp-c-divider);
  border-radius: 12px;
  text-align: center;
  transition: border-color 0.15s, background 0.15s;
}

.drop.dragging { border-color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.drop.filled { padding: 14px 16px; border-style: solid; text-align: left; }
.drop-title { margin: 0 0 16px; font-weight: 600; }
.drop-actions { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }

.loaded-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.loaded { margin: 0; padding: 0; list-style: none; max-height: 220px; overflow-y: auto; }
.loaded li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.loaded li.entry code { color: var(--vp-c-brand-1); font-weight: 600; }
.loaded code { font-size: 12.5px; }

.paste { margin-top: 14px; }
.paste summary { cursor: pointer; font-size: 14px; color: var(--vp-c-text-2); }

button.quiet { border: 0; background: none; font-size: 13px; color: var(--vp-c-text-3); cursor: pointer; }
.finding.blocking { border-color: var(--vp-c-red-1); }

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
