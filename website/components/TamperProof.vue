<script setup lang="ts">
/**
 * Tamper detection, demonstrated rather than described.
 *
 * Everything on screen is computed in the visitor's browser from real bytes:
 * the digests are SHA-256 of the actual entries, and the verdict comes from the
 * same `auditContainer` a desktop host runs. An animation would have been
 * easier and would have proven nothing — the point is that the visitor breaks
 * the file themselves and watches the check catch it.
 */
import { computed, onMounted, ref } from 'vue';
import {
  auditContainer,
  parseContainer,
  replacePayload,
  type AuditReport,
} from '../../src/container.js';
import { sha256Hex } from '../../src/core.js';

const EDITABLE = 'app/index.html';

const loading = ref(true);
const loadError = ref('');
const originalHtml = ref('');
const archive = ref<Record<string, Uint8Array>>({});
const report = ref<AuditReport | null>(null);

/** The entry the visitor edits, decoded for display. */
const source = ref('');
const pristineSource = ref('');
const liveDigest = ref('');
const busy = ref(false);

const edited = computed(() => source.value !== pristineSource.value);
const expectedDigest = computed(
  () => report.value?.entries.find((e) => e.name === EDITABLE)?.expected ?? '',
);
const digestMatches = computed(
  () => liveDigest.value !== '' && liveDigest.value === expectedDigest.value,
);

async function refreshLiveDigest(): Promise<void> {
  liveDigest.value = await sha256Hex(new TextEncoder().encode(source.value));
}

/** Rebuilds the container around the edited entry and audits the result. */
async function reaudit(): Promise<void> {
  busy.value = true;
  try {
    const next = { ...archive.value, [EDITABLE]: new TextEncoder().encode(source.value) };
    // Repacked without touching the manifest, so the digests go stale exactly
    // as they would for somebody editing the file with a text editor.
    const rebuilt = replacePayload(parseContainer(originalHtml.value), next);
    report.value = await auditContainer(parseContainer(rebuilt));
  } finally {
    busy.value = false;
  }
}

async function reset(): Promise<void> {
  source.value = pristineSource.value;
  await refreshLiveDigest();
  await reaudit();
}

onMounted(async () => {
  try {
    const response = await fetch('/sample-intact.dai');
    if (!response.ok) throw new Error(`sample-intact.dai → HTTP ${response.status}`);
    originalHtml.value = await response.text();
    archive.value = parseContainer(originalHtml.value).archive;

    pristineSource.value = new TextDecoder().decode(archive.value[EDITABLE]);
    source.value = pristineSource.value;

    report.value = await auditContainer(parseContainer(originalHtml.value));
    await refreshLiveDigest();
  } catch (error) {
    loadError.value = String(error);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="tamper">
    <p v-if="loading" class="muted">Loading the sample cartridge…</p>
    <p v-else-if="loadError" class="bad">{{ loadError }}</p>

    <template v-else>
      <div class="verdict" :class="report?.ok ? 'ok' : 'bad'">
        <strong>{{ report?.ok ? 'This cartridge is intact' : 'This cartridge has been altered' }}</strong>
        <span v-if="report?.ok">
          Every entry matches the digest recorded when it was sealed.
        </span>
        <span v-else>
          {{ report?.entries.filter((e) => e.status !== 'ok').length }} entry no longer
          matches the digest recorded when it was sealed, so a host will refuse to run it.
        </span>
      </div>

      <h3>Change something</h3>
      <p class="muted">
        This is the real <code>{{ EDITABLE }}</code> from inside the file. Edit any
        character and watch its fingerprint move away from the one the manifest
        recorded. Nothing here is pre-recorded: the hash is computed in your browser
        as you type.
      </p>

      <textarea v-model="source" spellcheck="false" @input="refreshLiveDigest" />

      <dl class="digests">
        <dt>Sealed as</dt>
        <dd><code>{{ expectedDigest.slice(0, 32) }}…</code></dd>
        <dt>Currently</dt>
        <dd>
          <code :class="digestMatches ? 'ok-text' : 'bad-text'">
            {{ liveDigest.slice(0, 32) }}…
          </code>
        </dd>
      </dl>

      <div class="actions">
        <button :disabled="busy" @click="reaudit">
          {{ busy ? 'Checking…' : 'Re-check the cartridge' }}
        </button>
        <button v-if="edited" class="secondary" :disabled="busy" @click="reset">
          Put it back
        </button>
      </div>

      <h3>What the check found</h3>
      <table class="entries">
        <thead>
          <tr><th>Entry</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in report?.entries" :key="entry.name">
            <td><code>{{ entry.name }}</code></td>
            <td>
              <span :class="entry.status === 'ok' ? 'pill ok' : 'pill bad'">
                {{ entry.status }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="note">
        <p>
          <strong>The signature is still valid, and that is not a bug.</strong>
          The signature attests to what the publisher <em>claimed</em> each entry
          should contain. The digests check whether the file still
          <em>matches</em> those claims. Editing a file breaks the second without
          touching the first, which is why a host checks both — and why a signature
          alone was never enough.
        </p>
        <p class="muted">
          Signature: <code>{{ report?.signature.status }}</code> ·
          publisher <code>{{ report?.signature.fingerprint ?? 'unsigned' }}</code>
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tamper { margin: 24px 0; }
.muted { color: var(--vp-c-text-2); }
.verdict {
  display: flex; flex-direction: column; gap: 4px;
  padding: 16px 20px; border-radius: 10px; margin-bottom: 28px;
  border: 1px solid var(--vp-c-divider);
}
.verdict.ok { background: var(--vp-c-green-soft); border-color: var(--vp-c-green-1); }
.verdict.bad { background: var(--vp-c-red-soft); border-color: var(--vp-c-red-1); }
textarea {
  width: 100%; min-height: 190px; padding: 12px;
  font-family: var(--vp-font-family-mono); font-size: 12px; line-height: 1.5;
  color: var(--vp-c-text-1); background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider); border-radius: 8px;
}
.digests { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0; }
.digests dt { color: var(--vp-c-text-2); font-size: 13px; }
.digests dd { margin: 0; font-size: 13px; }
.ok-text { color: var(--vp-c-green-1); }
.bad-text { color: var(--vp-c-red-1); }
.actions { display: flex; gap: 10px; margin: 16px 0 32px; }
button {
  padding: 8px 16px; font-size: 14px; border-radius: 8px; cursor: pointer;
  color: var(--vp-c-white); background: var(--vp-c-brand-1); border: 1px solid var(--vp-c-brand-1);
}
button.secondary { color: var(--vp-c-text-1); background: transparent; border-color: var(--vp-c-divider); }
button:disabled { opacity: 0.6; cursor: default; }
.entries { width: 100%; border-collapse: collapse; font-size: 13px; }
.entries th { text-align: left; color: var(--vp-c-text-2); font-weight: 500; padding: 6px 0; }
.entries td { padding: 6px 0; border-top: 1px solid var(--vp-c-divider); }
.pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.pill.ok { color: var(--vp-c-green-1); background: var(--vp-c-green-soft); }
.pill.bad { color: var(--vp-c-red-1); background: var(--vp-c-red-soft); }
.note { margin-top: 28px; padding: 16px 20px; border-radius: 10px;
        background: var(--vp-c-bg-alt); border: 1px solid var(--vp-c-divider); }
.note p { margin: 0 0 8px; }
.note p:last-child { margin-bottom: 0; }
</style>
