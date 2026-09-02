<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  parseContainer,
  verifyContainer,
  type ParsedContainer,
  type VerifiedContainer,
} from '../../src/container.js';
import { sha256Hex, toBase64 } from '../../src/core.js';

interface EntryAudit {
  name: string;
  size: number;
  expectedHash: string;
  computedHash: string;
  matches: boolean;
  isSigned: boolean;
}

interface PlaygroundState {
  fileName: string;
  fileSize: number;
  parsed: ParsedContainer;
  verified?: VerifiedContainer;
  entries: EntryAudit[];
  status: 'valid' | 'unsigned' | 'expired' | 'tampered' | 'unsupported_crypto' | 'corrupt';
  statusBadgeText: string;
  statusBadgeClass: string;
  errorDetail?: string;
  rawPayloadFingerprint?: string;
}

const isSecure = ref(true);
const isDragging = ref(false);
const isLoading = ref(false);
const state = ref<PlaygroundState | null>(null);
const rawExpanded = ref(false);

onMounted(() => {
  isSecure.value = typeof window !== 'undefined' && window.isSecureContext && !!window.crypto?.subtle;
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function auditCartridgeHtml(html: string, fileName: string, fileSize: number): Promise<void> {
  isLoading.value = true;
  state.value = null;

  try {
    // 1. Run parseContainer first to unpack the zip and inspect the manifest JSON and file tree
    let parsed: ParsedContainer;
    try {
      parsed = parseContainer(html);
    } catch (parseErr: any) {
      state.value = {
        fileName,
        fileSize,
        parsed: null as any,
        entries: [],
        status: 'corrupt',
        statusBadgeText: 'Corrupt / Unreadable (PAYLOAD_UNREADABLE)',
        statusBadgeClass: 'badge-red',
        errorDetail: parseErr?.message || String(parseErr),
      };
      return;
    }

    // 2. Compute and audit individual entry digests
    const entries: EntryAudit[] = [];
    const manifest = parsed.manifest;
    let hasDigestMismatch = false;

    for (const [name, bytes] of Object.entries(parsed.archive)) {
      if (name === 'runtime/manifest.json') continue;
      const expected = manifest.hashes?.[name] || '';
      let computed = '';
      let matches = false;

      if (window.crypto?.subtle) {
        computed = await sha256Hex(bytes);
        matches = computed === expected;
      } else {
        computed = '(WebCrypto unavailable)';
        matches = false;
      }

      if (!matches && expected) {
        hasDigestMismatch = true;
      }

      const isSigned = !!(manifest.signedEntries && manifest.signedEntries[name]);

      entries.push({
        name,
        size: bytes.byteLength,
        expectedHash: expected,
        computedHash: computed,
        matches,
        isSigned,
      });
    }

    // Check for files declared in manifest but missing in archive
    if (manifest.hashes) {
      for (const [name, expected] of Object.entries(manifest.hashes)) {
        if (!parsed.archive[name]) {
          hasDigestMismatch = true;
          entries.push({
            name,
            size: 0,
            expectedHash: expected,
            computedHash: '(missing from archive)',
            matches: false,
            isSigned: !!(manifest.signedEntries && manifest.signedEntries[name]),
          });
        }
      }
    }

    // Sort entries: entries with problems first, then alphabetical
    entries.sort((a, b) => {
      if (a.matches !== b.matches) return a.matches ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    // 3. Run verifyContainer against crypto.subtle to compute the cryptographic verdict
    let verified: VerifiedContainer | undefined = undefined;
    let status: PlaygroundState['status'] = 'valid';
    let statusBadgeText = 'Valid Signature (AUTHENTIC)';
    let statusBadgeClass = 'badge-green';
    let errorDetail: string | undefined = undefined;

    if (!window.crypto?.subtle) {
      status = 'unsupported_crypto';
      statusBadgeText = 'Insecure Context (UNSUPPORTED_CRYPTO)';
      statusBadgeClass = 'badge-amber';
      errorDetail = 'WebCrypto is unavailable: verifyContainer requires a secure context (HTTPS or localhost).';
    } else {
      try {
        verified = await verifyContainer(html);
        if (verified.signature === 'unsigned') {
          status = 'unsigned';
          statusBadgeText = 'Valid (Unsigned Container)';
          statusBadgeClass = 'badge-blue';
        } else {
          status = 'valid';
          statusBadgeText = 'Valid Signature (AUTHENTIC)';
          statusBadgeClass = 'badge-green';
        }
      } catch (verifyErr: any) {
        errorDetail = verifyErr?.message || String(verifyErr);
        const errLower = errorDetail.toLowerCase();

        if (errLower.includes('expired')) {
          status = 'expired';
          statusBadgeText = 'Expired (KEY_EXPIRED)';
          statusBadgeClass = 'badge-amber';
        } else if (
          errLower.includes('does not match') ||
          errLower.includes('modified') ||
          errLower.includes('missing') ||
          hasDigestMismatch
        ) {
          status = 'tampered';
          statusBadgeText = 'Tampered (DIGEST_MISMATCH)';
          statusBadgeClass = 'badge-red';
        } else if (errLower.includes('not authentic') || errLower.includes('signature')) {
          status = 'tampered';
          statusBadgeText = 'Signature Mismatch (UNVERIFIED_SIGNATURE)';
          statusBadgeClass = 'badge-red';
        } else if (errLower.includes('webcrypto is unavailable')) {
          status = 'unsupported_crypto';
          statusBadgeText = 'Insecure Context (UNSUPPORTED_CRYPTO)';
          statusBadgeClass = 'badge-amber';
        } else {
          status = 'tampered';
          statusBadgeText = 'Verification Failed';
          statusBadgeClass = 'badge-red';
        }
      }
    }

    state.value = {
      fileName,
      fileSize,
      parsed,
      verified,
      entries,
      status,
      statusBadgeText,
      statusBadgeClass,
      errorDetail,
    };
  } finally {
    isLoading.value = false;
  }
}

async function handleFileBytes(bytes: Uint8Array, fileName: string): Promise<void> {
  const prefix = new TextDecoder().decode(bytes.slice(0, 1024));
  if (
    prefix.includes('<!doctype html>') ||
    prefix.includes('<html') ||
    prefix.includes('id="dai-payload"')
  ) {
    const html = new TextDecoder().decode(bytes);
    await auditCartridgeHtml(html, fileName, bytes.byteLength);
  } else {
    // If it's a raw zip archive without HTML shell, synthesize a container shell so parseContainer can inspect it
    const base64Payload = toBase64(bytes);
    const syntheticHtml = `<!doctype html>
<html>
  <head>
    <meta name="dai-integrity" content="required">
  </head>
  <body>
    <' + 'script id="dai-payload">' + base64Payload + '<' + '/script>'
  </body>
</html>`;
    await auditCartridgeHtml(syntheticHtml, fileName, bytes.byteLength);
  }
}

function handleFileSelect(e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];
  loadFile(file);
}

function handleDrop(e: DragEvent) {
  isDragging.value = false;
  if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
  const file = e.dataTransfer.files[0];
  loadFile(file);
}

function loadFile(file: File) {
  const reader = new FileReader();
  reader.onload = (evt) => {
    if (evt.target?.result instanceof ArrayBuffer) {
      handleFileBytes(new Uint8Array(evt.target.result), file.name);
    }
  };
  reader.readAsArrayBuffer(file);
}

async function loadSampleCartridge() {
  isLoading.value = true;
  try {
    const res = await fetch('/demo.dai');
    if (!res.ok) throw new Error('Could not fetch sample cartridge.');
    const buf = await res.arrayBuffer();
    await handleFileBytes(new Uint8Array(buf), 'demo.dai');
  } catch (err: any) {
    alert('Failed to load sample: ' + err.message);
    isLoading.value = false;
  }
}
</script>

<template>
  <div class="playground-container">
    <!-- Secure Context Warning -->
    <div v-if="!isSecure" class="secure-context-banner">
      <div class="banner-icon">⚠️</div>
      <div class="banner-body">
        <strong>Insecure Context Detected:</strong>
        <code>crypto.subtle</code> is only available in Secure Contexts (HTTPS or localhost).
        Opening this documentation site directly via <code>file://</code> restricts WebCrypto verification. Serve over HTTP/localhost or deploy to Vercel for full in-browser verification.
      </div>
    </div>

    <!-- Dropzone Area -->
    <div
      class="dropzone"
      :class="{ 'is-dragging': isDragging, 'is-loading': isLoading }"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="handleDrop"
    >
      <input
        type="file"
        id="fileInput"
        class="file-input"
        accept=".dai,.html,.dai.html"
        @change="handleFileSelect"
      />
      <label for="fileInput" class="dropzone-label">
        <div class="drop-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" x2="12" y1="3" y2="15"/>
          </svg>
        </div>
        <div class="drop-text">
          <p class="primary-text">Drag & drop any <code>.dai</code> or <code>.dai.html</code> file here</p>
          <p class="secondary-text">Inspects manifest via <code>parseContainer</code>, then audits digests & signatures via <code>verifyContainer</code></p>
        </div>
      </label>

      <div class="sample-action">
        <span class="divider-text">— or —</span>
        <button type="button" class="btn-sample" @click="loadSampleCartridge" :disabled="isLoading">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
          Load Verified Sample Cartridge (demo.dai)
        </button>
      </div>
    </div>

    <!-- Loading Indicator -->
    <div v-if="isLoading" class="loading-state">
      <div class="spinner"></div>
      <p>Unpacking payload with <code>parseContainer</code> and auditing cryptographic digests…</p>
    </div>

    <!-- Audit Dashboard -->
    <div v-if="state && !isLoading" class="report-card">
      <div class="report-header">
        <div class="title-group">
          <h3 class="app-title">{{ state.parsed?.manifest?.appName || 'Unrecognized Cartridge' }}</h3>
          <span class="file-meta">{{ state.fileName }} &bull; {{ formatBytes(state.fileSize) }}</span>
        </div>
        <div :class="['status-badge', state.statusBadgeClass]">
          {{ state.statusBadgeText }}
        </div>
      </div>

      <!-- Diagnostic Banner if verification failed -->
      <div v-if="state.errorDetail" class="error-banner">
        <strong>Verification Diagnostic:</strong> {{ state.errorDetail }}
      </div>

      <!-- Manifest Metadata Grid (Populated from parseContainer) -->
      <div class="meta-grid" v-if="state.parsed?.manifest">
        <div class="meta-item">
          <span class="meta-label">Document UUID</span>
          <span class="meta-value"><code>{{ state.parsed.manifest.documentUuid }}</code></span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Created At (Timestamp)</span>
          <span class="meta-value">{{ state.parsed.manifest.createdAt }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Integrity Policy</span>
          <span class="meta-value"><code>{{ state.parsed.integrityPolicy }}</code> (Shell)</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Signed Expiration (validUntil)</span>
          <span class="meta-value" :class="{ 'text-expired': state.status === 'expired' }">
            {{ state.parsed.manifest.validUntil ? new Date(state.parsed.manifest.validUntil * 1000).toISOString() : 'Perpetual (No Expiry)' }}
          </span>
        </div>
        <div class="meta-item" v-if="state.parsed.publicKeyFingerprint">
          <span class="meta-label">Publisher Key Fingerprint</span>
          <span class="meta-value"><code>{{ state.parsed.publicKeyFingerprint }}</code></span>
        </div>
        <div class="meta-item" v-if="state.parsed.publicKey">
          <span class="meta-label">Claimed Public Key (SPKI)</span>
          <span class="meta-value"><code>{{ state.parsed.publicKey.slice(0, 24) }}…</code></span>
        </div>
      </div>

      <!-- Individual Archive Entries Table -->
      <div class="entries-section" v-if="state.entries.length > 0">
        <div class="entries-header">
          <h4>Sealed Archive Entries ({{ state.entries.length }})</h4>
          <span class="entries-subtext">Verified bidirectional matching with <code>runtime/manifest.json</code></span>
        </div>
        <div class="table-wrapper">
          <table class="entries-table">
            <thead>
              <tr>
                <th>Entry Path</th>
                <th>Size</th>
                <th>Covered By Signature</th>
                <th>Digest Status</th>
                <th>SHA-256 Digest</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in state.entries" :key="entry.name" :class="{ 'row-fail': !entry.matches }">
                <td class="cell-path">
                  <code>{{ entry.name }}</code>
                </td>
                <td>{{ formatBytes(entry.size) }}</td>
                <td>
                  <span v-if="entry.isSigned" class="signed-tag">Signed</span>
                  <span v-else class="unsigned-tag">Unsigned</span>
                </td>
                <td>
                  <span v-if="entry.matches" class="entry-ok">Matched</span>
                  <span v-else class="entry-fail">Mismatch</span>
                </td>
                <td class="cell-hash"><code>{{ entry.computedHash }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Raw Manifest JSON Inspector -->
      <div class="raw-manifest-section" v-if="state.parsed?.manifest">
        <button class="btn-toggle-raw" @click="rawExpanded = !rawExpanded">
          {{ rawExpanded ? 'Hide Raw Manifest' : 'Inspect runtime/manifest.json' }}
        </button>
        <pre v-if="rawExpanded" class="manifest-json"><code>{{ JSON.stringify(state.parsed.manifest, null, 2) }}</code></pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playground-container {
  margin: 24px 0 40px;
}
.secure-context-banner {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  margin-bottom: 20px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 1.5;
}
.banner-icon {
  font-size: 20px;
  flex-shrink: 0;
}
.dropzone {
  border: 2px dashed var(--vp-c-border);
  border-radius: 12px;
  padding: 36px 20px;
  text-align: center;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.2s, background-color 0.2s;
  cursor: pointer;
  position: relative;
}
.dropzone.is-dragging {
  border-color: var(--vp-c-brand-1);
  background-color: var(--vp-c-brand-soft);
}
.file-input {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.dropzone-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}
.drop-icon {
  color: var(--vp-c-brand-1);
}
.primary-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin: 0 0 4px;
}
.secondary-text {
  font-size: 13px;
  color: var(--vp-c-text-2);
  margin: 0;
}
.sample-action {
  margin-top: 18px;
  position: relative;
  z-index: 10;
}
.divider-text {
  display: block;
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin-bottom: 10px;
}
.btn-sample {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: all 0.2s;
}
.btn-sample:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin: 32px 0;
  color: var(--vp-c-text-2);
}
.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--vp-c-border);
  border-top-color: var(--vp-c-brand-1);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.report-card {
  margin-top: 24px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  padding: 24px;
}
.report-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--vp-c-border);
  flex-wrap: wrap;
}
.app-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}
.file-meta {
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.status-badge {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 700;
  border-radius: 9999px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.badge-green {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.badge-blue {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.badge-amber {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.badge-red {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.error-banner {
  margin: 16px 0 0;
  padding: 12px 16px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  color: #ef4444;
  font-size: 13px;
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  padding: 20px 0;
  border-bottom: 1px solid var(--vp-c-border);
}
.meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.meta-label {
  font-size: 12px;
  color: var(--vp-c-text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.meta-value {
  font-size: 13px;
  color: var(--vp-c-text-1);
  word-break: break-all;
}
.text-expired {
  color: #f59e0b;
  font-weight: 600;
}
.entries-section {
  margin-top: 20px;
}
.entries-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}
.entries-header h4 {
  margin: 0;
  font-size: 15px;
  color: var(--vp-c-text-1);
}
.entries-subtext {
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.table-wrapper {
  overflow-x: auto;
}
.entries-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.entries-table th,
.entries-table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--vp-c-border);
}
.entries-table th {
  color: var(--vp-c-text-2);
  font-weight: 600;
  background: var(--vp-c-bg);
}
.row-fail {
  background: rgba(239, 68, 68, 0.05);
}
.cell-path code {
  color: var(--vp-c-brand-1);
}
.cell-hash code {
  font-size: 11px;
  word-break: break-all;
}
.signed-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}
.unsigned-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-3);
}
.entry-ok {
  color: #10b981;
  font-weight: 600;
}
.entry-fail {
  color: #ef4444;
  font-weight: 600;
}
.raw-manifest-section {
  margin-top: 20px;
}
.btn-toggle-raw {
  font-size: 13px;
  color: var(--vp-c-brand-1);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-weight: 500;
}
.manifest-json {
  margin-top: 12px;
  padding: 16px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  font-size: 12px;
  overflow-x: auto;
}
</style>
