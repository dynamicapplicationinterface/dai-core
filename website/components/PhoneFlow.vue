<script setup lang="ts">
/**
 * How a container works on a phone.
 *
 * The honest version of this is three sentences long and one of them is a
 * limitation, so it is drawn rather than written: three phones, three captions,
 * done. A paragraph explaining that iOS cannot execute a file from storage is a
 * paragraph nobody finishes.
 *
 * Drawn in SVG rather than screenshotted. Screenshots of a phone date, carry
 * somebody's battery percentage and carrier, and need retaking every time the
 * opener's header moves; these follow the site's own colours and the reader's
 * theme.
 */
/*
 * The public address, and the public word.
 *
 * "Open" rather than "run": a person opens a document, and a message telling
 * somebody to *run* a file they were sent reads as the thing everybody is
 * trained to delete. The code calls this the runner because that is what it
 * technically is — a host that runs a container — and nothing a stranger reads
 * says so.
 */
const OPENER = 'https://run.dynamicapplicationinterface.io';

/** A home screen: three across, two down, and one of them is the app. */
const grid = [0, 1, 2, 3, 4, 5].map((index) => ({
  key: index,
  x: 44 + (index % 3) * 42,
  y: 62 + Math.floor(index / 3) * 58,
  mine: index === 0,
}));
</script>

<template>
  <section class="phones">
    <header>
      <p class="kicker">On a phone</p>
      <h2>Files can’t run themselves here</h2>
      <p class="lede">
        A phone will show you a file but won’t execute one. The opener is a small
        page that opens your container and keeps it — the app stays yours, the
        data stays on the device.
      </p>
    </header>

    <ol class="steps">
      <li class="step">
        <figure>
          <svg viewBox="0 0 200 300" role="img" aria-label="Saving the file from the share sheet">
            <g class="phone">
              <rect class="body" x="16" y="12" width="168" height="276" rx="28" />
              <rect class="bezel" x="24" y="20" width="152" height="260" rx="21" />
              <rect class="notch" x="80" y="26" width="40" height="7" rx="3.5" />
            </g>

            <!-- The file, then the sheet rising over it. -->
            <g class="file">
              <rect class="card" x="60" y="52" width="80" height="62" rx="10" />
              <rect class="row" x="72" y="70" width="40" height="6" rx="3" />
              <rect class="row dim" x="72" y="83" width="54" height="5" rx="2.5" />
              <rect class="row dim" x="72" y="94" width="30" height="5" rx="2.5" />
            </g>

            <g class="sheet-group">
              <rect class="sheet" x="32" y="140" width="136" height="132" rx="18" />
              <rect class="grabber" x="90" y="150" width="20" height="4" rx="2" />
              <rect class="option" x="44" y="168" width="112" height="30" rx="9" />
              <rect class="glyph" x="54" y="176" width="14" height="14" rx="4" />
              <rect class="row" x="78" y="180" width="52" height="7" rx="3.5" />
              <rect class="option quiet" x="44" y="206" width="112" height="26" rx="9" />
              <rect class="row dim" x="78" y="215" width="42" height="6" rx="3" />
              <rect class="option quiet" x="44" y="240" width="112" height="26" rx="9" />
              <rect class="row dim" x="78" y="249" width="58" height="6" rx="3" />
            </g>
          </svg>
        </figure>
        <p><span class="n">1</span><strong>Save it.</strong> Share → Save to Files.</p>
      </li>

      <li class="step">
        <figure>
          <svg viewBox="0 0 200 300" role="img" aria-label="The opener running the container">
            <g class="phone">
              <rect class="body" x="16" y="12" width="168" height="276" rx="28" />
              <rect class="bezel" x="24" y="20" width="152" height="260" rx="21" />
              <rect class="notch" x="80" y="26" width="40" height="7" rx="3.5" />
            </g>

            <rect class="row" x="40" y="52" width="54" height="8" rx="4" />
            <rect class="pill" x="112" y="47" width="48" height="18" rx="9" />

            <!-- One container, ready to run, and the shelf behind it. -->
            <rect class="card lift" x="38" y="86" width="124" height="58" rx="14" />
            <rect class="glyph big" x="52" y="100" width="30" height="30" rx="9" />
            <rect class="row" x="92" y="105" width="46" height="7" rx="3.5" />
            <rect class="row dim" x="92" y="119" width="60" height="5" rx="2.5" />

            <rect class="card faint" x="38" y="156" width="124" height="52" rx="14" />
            <rect class="glyph faint" x="52" y="169" width="26" height="26" rx="8" />
            <rect class="row dim" x="88" y="175" width="40" height="6" rx="3" />
            <rect class="row dim" x="88" y="188" width="56" height="5" rx="2.5" />

            <g class="seal">
              <circle cx="150" cy="99" r="11" />
              <path class="tick" d="M145 99l4 4 7-8" />
            </g>
          </svg>
        </figure>
        <p><span class="n">2</span><strong>Open it.</strong> The opener checks it, then runs it.</p>
      </li>

      <li class="step">
        <figure>
          <svg viewBox="0 0 200 300" role="img" aria-label="The app kept on the home screen">
            <g class="phone">
              <rect class="body" x="16" y="12" width="168" height="276" rx="28" />
              <rect class="bezel home-ground" x="24" y="20" width="152" height="260" rx="21" />
              <rect class="notch" x="80" y="26" width="40" height="7" rx="3.5" />
            </g>

            <!-- A home screen, with one icon that is yours. -->
            <g class="icons">
              <g v-for="cell in grid" :key="cell.key">
                <rect
                  class="app"
                  :class="{ mine: cell.mine }"
                  :x="cell.x"
                  :y="cell.y"
                  width="30"
                  height="30"
                  rx="9"
                />
                <path v-if="cell.mine" class="tick" :d="`M${cell.x + 8} ${cell.y + 15}l5 5 9-10`" />
                <rect
                  class="label"
                  :class="{ mine: cell.mine }"
                  :x="cell.x + 4"
                  :y="cell.y + 35"
                  width="22"
                  height="4"
                  rx="2"
                />
              </g>
            </g>

            <rect class="dock" x="38" y="228" width="124" height="42" rx="14" />
            <rect class="home" x="80" y="278" width="40" height="4" rx="2" />
          </svg>
        </figure>
        <p><span class="n">3</span><strong>Keep it.</strong> It reopens where you left off.</p>
      </li>
    </ol>

    <div class="cta">
      <div>
        <p class="cta-title">The opener</p>
        <p class="cta-address">run.dynamicapplicationinterface.io</p>
        <p class="cta-note">
          Nothing to install, nothing uploaded. Your containers stay on the device.
          Sent one and not sure what it is? <a href="/open">Start here</a>.
        </p>
      </div>
      <a class="button primary" :href="OPENER">Open a file</a>
    </div>
  </section>
</template>

<style scoped>
.phones {
  max-width: 1080px;
  margin: 0 auto;
  padding: 8px 0 8px;
}

header {
  max-width: 34rem;
}

.kicker {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

h2 {
  margin: 0;
  font-size: clamp(1.7rem, 3.4vw, 2.3rem);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
}

.lede {
  margin: 14px 0 0;
  font-size: 1.02rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.steps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 28px;
  margin: 40px 0 0;
  padding: 0;
  list-style: none;
  counter-reset: step;
}

.step p {
  margin: 16px 2px 0;
  font-size: 0.95rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.step strong {
  color: var(--vp-c-text-1);
}

figure {
  margin: 0;
  padding: 22px 0 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
  display: flex;
  justify-content: center;
}

svg {
  width: 70%;
  max-width: 200px;
  height: auto;
}

/* ------------------------------------------------------ the drawings */

/*
 * A phone has to read as a phone at 120px wide, which a single hairline
 * rectangle does not. The body is a filled bezel with a screen inside it, so
 * the silhouette survives being small and being inverted in dark mode.
 */
.body {
  fill: var(--vp-c-text-1);
  opacity: 0.09;
}

.bezel {
  fill: var(--vp-c-bg);
}

.notch {
  fill: var(--vp-c-text-1);
  opacity: 0.22;
}

.card,
.sheet,
.option,
.pill,
.dock,
.app {
  fill: var(--vp-c-bg-soft);
}

.card,
.sheet {
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
}

.lift {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-brand-1);
  stroke-opacity: 0.45;
}

.row {
  fill: var(--vp-c-text-1);
  opacity: 0.78;
}

.row.dim {
  fill: var(--vp-c-text-1);
  opacity: 0.28;
}

.glyph,
.pill {
  fill: var(--vp-c-brand-1);
  opacity: 0.2;
}

.glyph.big {
  opacity: 0.28;
}

.option {
  fill: var(--vp-c-brand-1);
  opacity: 0.1;
}

.option.quiet {
  fill: var(--vp-c-text-1);
  opacity: 0.05;
}

.grabber {
  fill: var(--vp-c-text-1);
  opacity: 0.2;
}

.faint {
  opacity: 0.4;
}

.seal circle {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-brand-1);
  stroke-width: 1.5;
}

.tick {
  fill: none;
  stroke: var(--vp-c-brand-1);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* The home screen: one icon is the app, the rest are the phone's own. */
.home-ground {
  fill: var(--vp-c-bg-soft);
}

.app {
  fill: var(--vp-c-text-1);
  opacity: 0.08;
}

.app.mine {
  fill: var(--vp-c-brand-1);
  opacity: 0.16;
}

.icons .tick {
  stroke-width: 2.6;
}

.label {
  fill: var(--vp-c-text-1);
  opacity: 0.14;
}

.label.mine {
  opacity: 0.4;
}

.dock {
  fill: var(--vp-c-text-1);
  opacity: 0.05;
}

.home {
  fill: var(--vp-c-text-1);
  opacity: 0.25;
}

/* The step number, kept in the caption rather than floated on the artwork:
   the drawings are already carrying the sequence. */
.n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 8px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 12px;
  font-weight: 700;
  vertical-align: 1px;
}

/* -------------------------------------------------------------- cta */

.cta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
  margin-top: 34px;
  padding: 22px 26px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
}

.cta-address {
  margin: 4px 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  color: var(--vp-c-brand-1);
}

.cta-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.cta-note {
  margin: 6px 0 0;
  max-width: 40rem;
  font-size: 0.95rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.button {
  display: inline-block;
  padding: 12px 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 15px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  text-decoration: none;
  white-space: nowrap;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}

.button.primary {
  color: #fff;
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.button.primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
  transform: translateY(-1px);
}

@media (max-width: 860px) {
  .steps {
    grid-template-columns: 1fr;
    gap: 20px;
  }

  .step {
    display: grid;
    grid-template-columns: 96px 1fr;
    align-items: center;
    gap: 18px;
  }

  figure {
    padding: 12px 0 6px;
  }

  svg {
    width: 100%;
  }

  .step p {
    margin: 0;
  }
}
</style>
