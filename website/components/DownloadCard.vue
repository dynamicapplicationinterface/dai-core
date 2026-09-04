<script setup lang="ts">
const downloadUrl = '/dai-docs.dai';
const fileName = 'dai-docs.dai';

/*
 * Opening beats downloading, on a phone by a wide margin.
 *
 * Downloading it puts the file in Downloads and the person in the position of
 * leaving the browser, finding it in a Files app, and working out what opens
 * it — three steps, each of which somebody abandons. The opener takes an
 * address, so the same file can simply be run: one tap, and they are in it.
 *
 * The download stays, because a file you can keep is the point of the format.
 * It is just no longer the thing being asked of somebody who has not yet seen
 * one work.
 */
const openUrl =
  'https://opendai.app/?open=' +
  encodeURIComponent('https://www.dynamicapplicationinterface.io/dai-docs.dai');
</script>

<template>
  <div class="download-card">
    <div class="card-icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>
        <path d="m9 12 2 2 4-4"></path>
        <path d="M12 3v5"></path>
      </svg>
    </div>
    <div class="card-body">
      <div class="badge-row">
        <span class="pill-spec">Air-Gapped Container</span>
        <span class="pill-size">Standalone .dai</span>
      </div>
      <h3 class="card-title">Download Offline Spec Cartridge</h3>
      <p class="card-desc">
        The complete DAI protocol specification bundled as an authentic, signed, air-gapped container with embedded offline search and SQLite schema. Zero external dependencies.
      </p>
      <div class="card-actions">
        <a :href="openUrl" class="btn-primary">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Open it now
        </a>
        <a :href="downloadUrl" :download="fileName" class="btn-secondary">
          Download <code>dai-docs.dai</code>
        </a>
        <a href="/playground" class="btn-secondary">
          Inspect in Playground &rarr;
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.download-card {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  padding: 24px;
  margin: 32px 0;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.download-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 4px 20px rgba(59, 130, 246, 0.08);
}
.card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 10px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  flex-shrink: 0;
}
.card-body {
  flex: 1;
}
.badge-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.pill-spec {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}
.pill-size {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-2);
}
.card-title {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}
.card-desc {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  font-size: 14px;
  font-weight: 600;
  color: #fff !important;
  background-color: var(--vp-c-brand-1);
  border-radius: 8px;
  text-decoration: none !important;
  transition: background-color 0.2s;
}
.btn-primary:hover {
  background-color: var(--vp-c-brand-2);
}
.btn-secondary {
  display: inline-flex;
  align-items: center;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1) !important;
  background-color: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  text-decoration: none !important;
  transition: border-color 0.2s;
}
.btn-secondary:hover {
  border-color: var(--vp-c-brand-1);
}
@media (max-width: 640px) {
  .download-card {
    flex-direction: column;
  }
}
</style>
