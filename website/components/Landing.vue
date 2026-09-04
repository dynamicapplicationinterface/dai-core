<script setup lang="ts">
/**
 * The front page.
 *
 * Written for two people who arrive confused: somebody whose assistant just
 * made them an app and said "go here", and somebody who was sent a file and
 * has no idea what it is. Neither of them knows what a database is, both are
 * in a hurry, and both are one bad sentence from leaving. A previous version
 * of this page was careful and honest and opened every section with the
 * mechanism — "the database is inside the file" — which is a sentence written
 * by someone who knows what a database is, for someone who does. Somebody's
 * wife read it and got stuck. This is the rewrite.
 *
 * The rules, so the copy does not drift back:
 *
 * - Every section is one idea: a headline, a sentence or two, one picture or
 *   one button. If she scrolls she never sees two ideas at once.
 * - Buttons say what she will get, not what she is.
 * - No word above the fold that would not come up at a grocery store.
 *   Database, container, compiler, signed, host, terminal, opener — all of
 *   them live happily in the docs, and none of them live here.
 * - Nothing the docs would have to take back. The page promises; the docs
 *   qualify.
 *
 * Every picture is a photograph of a real file, compiled and captured by
 * scripts/capture-screenshots.mjs. The three phones are three apps nobody
 * sells — dinners, chores, a packing list — because a task manager is a thing
 * engineers recognise themselves in, and she is not an engineer.
 */
import { ref } from 'vue';

/** The three phones. Real files; see examples/ for each. */
const phones = [
  { shot: '/shots/home-dinners.png', label: 'Dinners for the week', alt: 'A week of dinners and a shopping list' },
  { shot: '/shots/home-chores.png', label: 'Chores for two kids', alt: 'A chore chart for Maya and Leo' },
  { shot: '/shots/home-packing.png', label: 'Packing for the beach', alt: 'A packing list for a beach trip' },
];

import { IDEAS as ideas, PROMPT } from './prompt.js';

const copied = ref(false);

async function copyPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(PROMPT);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    // No clipboard. The text is on screen and selectable; nothing to add.
  }
}

</script>

<template>
  <div class="landing">
    <!-- ------------------------------------------------------------ hero -->
    <section class="hero">
      <h1>An app that's<br />just a file.</h1>
      <p class="lede">
        Ask your AI for the app you want. It sends you a file.
        The file <em>is</em> the app. Open it, use it, send it to anyone.
      </p>
      <div class="actions">
        <a class="button primary" href="/make-one">Make one</a>
        <!--
          The most important button on the page. Most first visits are
          somebody holding a file, and the previous page had no button for
          them at all.
        -->
        <a class="button" href="/open">Someone sent me a file</a>
      </div>
      <p class="fine">Works on your phone and your computer. Nothing to install to try it.</p>
    </section>

    <section class="gallery" aria-label="Three examples">
      <ul class="row">
        <li v-for="phone in phones" :key="phone.shot" class="phone">
          <div class="device">
            <img :src="phone.shot" :alt="phone.alt" />
          </div>
          <p class="label">{{ phone.label }}</p>
        </li>
      </ul>
      <p class="caption">Each of these is one file. Each took about two minutes to make.</p>
    </section>

    <!--
      On a phone this is the second thing she sees; on a laptop it comes after
      the four beats. Most people who arrive confused arrive on a phone,
      holding a file, and "three taps" is the answer they came for.
    -->
    <PhoneFlow class="taps" />

    <!-- ----------------------------------------------------------- beats -->
    <section class="beat with-shot">
      <div class="beat-text">
        <h2>No accounts. No sign-ups. No subscriptions.</h2>
        <p>
          The app and everything you put in it live in one file, like a photo or a
          PDF. Nothing to log into, nothing to renew, nothing to lose.
        </p>
      </div>
      <figure class="laptop">
        <img src="/shots/home-dinners-wide.png" alt="The dinner plan open on a laptop" loading="lazy" />
        <figcaption>The same file, on a laptop.</figcaption>
      </figure>
    </section>

    <section class="beat">
      <div class="beat-text centered">
        <h2>Send it like a picture.</h2>
        <p>
          Text it, email it, AirDrop it. The person you send it to gets the whole
          app, with everything in it. Change it, send it again. That's it.
        </p>
      </div>
      <!--
        Drawn, not screenshotted: a real message thread would carry somebody's
        name, carrier and battery. This follows the reader's theme.
      -->
      <figure class="thread" aria-hidden="true">
        <div class="bubble theirs">Can you send the packing list?</div>
        <div class="bubble mine">
          <span class="file">
            <span class="file-icon"></span>
            <span class="file-name">beach-trip.dai.html</span>
            <span class="file-size">790 KB</span>
          </span>
          here you go — tap it
        </div>
        <div class="bubble theirs">got it, everything's there 🏖️</div>
      </figure>
    </section>

    <section class="beat">
      <div class="beat-text centered">
        <h2>It can't send your information anywhere.</h2>
        <p>
          A DAI file isn't allowed to use the internet, and your browser holds it to
          that. And if anyone changes a file after it's made, it fails its own check
          the moment you open it. What you open is exactly what was made.
        </p>
        <a class="more" href="/tamper-proof">See for yourself →</a>
      </div>
    </section>

    <section class="beat">
      <div class="beat-text centered">
        <h2>It works without wifi.<br />It'll work in ten years.</h2>
        <p>
          No company has to stay in business for your app to keep opening. It's a
          file on your device. It's there when you need it.
        </p>
      </div>
    </section>

    <!-- --------------------------------------------------------- desktop -->
    <section class="beat with-shot desktop">
      <div class="beat-text">
        <p class="kicker">On your computer</p>
        <h2>Or make it feel like a real app.</h2>
        <p>
          Install DAI once and your files get an icon, open with a double-click, and
          save themselves. Free, and takes a minute.
        </p>
        <div class="row-actions">
          <a class="button" href="https://github.com/dynamicapplicationinterface/dai-core/releases">Get it for Mac</a>
          <a class="button" href="https://github.com/dynamicapplicationinterface/dai-core/releases">Get it for Windows</a>
        </div>
      </div>
      <figure class="laptop">
        <img src="/shots/desktop-light.png" alt="A DAI file open in its own window" loading="lazy" />
      </figure>
    </section>

    <!-- ---------------------------------------------------------- prompt -->
    <section class="prompt">
      <h2>Try it in ninety seconds.</h2>
      <p>Copy this and paste it to your AI. Change the part in brackets. You'll get a file back.</p>
      <div class="prompt-box">
        <p class="prompt-text">{{ PROMPT }}</p>
        <button type="button" class="button primary" @click="copyPrompt">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="ideas">
        <span class="ideas-label">Or try:</span>
        <span v-for="idea in ideas" :key="idea" class="idea">{{ idea }}</span>
      </p>
      <a class="button" href="/make-one">Then open it here →</a>
    </section>

    <!-- ------------------------------------------------------------ door -->
    <footer class="door">
      <p>
        <strong>For developers and IT.</strong> DAI is an open standard. Read the
        <a href="/docs/specification">specification</a>, the
        <a href="/tamper-proof">security model</a>, or build one from the
        <a href="/docs/making-files">command line</a>.
      </p>
    </footer>
  </div>
</template>

<style scoped>
/*
 * One idea per screen, and a lot of air between them. The type is the site's;
 * the colour comes from the apps in the pictures, which is deliberate — each
 * is somebody else's, and the page is only the frame.
 */
.landing {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 24px 72px;
  display: flex;
  flex-direction: column;
}

/* ------------------------------------------------------------------ hero */

.hero {
  padding: 88px 0 24px;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: clamp(2.8rem, 8vw, 5rem);
  font-weight: 700;
  line-height: 1.02;
  letter-spacing: -0.045em;
  text-wrap: balance;
}

.lede {
  max-width: 32rem;
  margin: 26px auto 0;
  font-size: clamp(1.1rem, 2.2vw, 1.35rem);
  line-height: 1.5;
  color: var(--vp-c-text-1);
  text-wrap: balance;
}

.lede em { font-style: normal; font-weight: 650; }

.actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
}

.fine {
  margin: 18px 0 0;
  font-size: 14px;
  color: var(--vp-c-text-3);
}

.button {
  display: inline-block;
  padding: 13px 26px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 15.5px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}

.button:hover { border-color: var(--vp-c-text-3); transform: translateY(-1px); }

.button.primary {
  color: #fff;
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.button.primary:hover { background: var(--vp-c-brand-2); border-color: var(--vp-c-brand-2); }

/* --------------------------------------------------------------- gallery */

.gallery { padding: 48px 0 0; }

.row {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 28px;
  align-items: end;
}

.phone { margin: 0; text-align: center; }

/* Lift the middle one, the way three phones sit in a hand. */
.phone:nth-child(2) { transform: translateY(-18px); }

.device {
  padding: 9px;
  border-radius: 40px;
  background: #101318;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.3),
    0 30px 60px -10px rgba(16, 21, 31, 0.35);
}

.dark .device { background: #2a2f3a; }

.device img {
  display: block;
  width: 100%;
  border-radius: 31px;
  /* The shots are tall; the frame shows the top and the page below decides. */
  aspect-ratio: 390 / 700;
  object-fit: cover;
  object-position: top;
}

.label {
  margin: 16px 0 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.caption {
  margin: 36px 0 0;
  text-align: center;
  font-size: 15px;
  color: var(--vp-c-text-3);
}

/* ----------------------------------------------------------------- beats */

.beat {
  padding: 104px 0 0;
}

.beat-text { max-width: 34rem; }

.beat-text.centered {
  margin: 0 auto;
  text-align: center;
}

.beat h2 {
  margin: 0 0 16px;
  font-size: clamp(1.7rem, 3.6vw, 2.5rem);
  font-weight: 650;
  line-height: 1.12;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
  text-wrap: balance;
}

.beat p {
  margin: 0;
  font-size: 1.12rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}

.kicker {
  margin: 0 0 10px !important;
  font-size: 12px !important;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1) !important;
}

.more {
  display: inline-block;
  margin-top: 20px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.with-shot {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  align-items: center;
  gap: 56px;
}

.laptop {
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 21, 31, 0.05), 0 20px 50px rgba(16, 21, 31, 0.1);
}

.dark .laptop { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 20px 50px rgba(0, 0, 0, 0.4); }

.laptop img { display: block; width: 100%; }

.laptop figcaption {
  padding: 12px 18px;
  font-size: 13px;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-alt);
  border-top: 1px solid var(--vp-c-divider);
}

.row-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 24px; }

/* The message thread. */
.thread {
  max-width: 26rem;
  margin: 40px auto 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bubble {
  max-width: 82%;
  padding: 11px 15px;
  border-radius: 20px;
  font-size: 15.5px;
  line-height: 1.4;
}

.bubble.theirs {
  align-self: flex-start;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-bottom-left-radius: 6px;
}

.bubble.mine {
  align-self: flex-end;
  background: var(--vp-c-brand-1);
  color: #fff;
  border-bottom-right-radius: 6px;
}

.file {
  display: grid;
  grid-template-columns: 34px 1fr;
  grid-template-rows: auto auto;
  column-gap: 10px;
  align-items: center;
  margin: 0 0 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.16);
}

.file-icon {
  grid-row: 1 / 3;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #fff;
  position: relative;
}

.file-icon::after {
  content: "";
  position: absolute;
  inset: 9px 8px;
  border-radius: 3px;
  background: var(--vp-c-brand-1);
  opacity: 0.85;
}

.file-name { font-weight: 600; font-size: 14px; }
.file-size { font-size: 12.5px; opacity: 0.85; }

/* ---------------------------------------------------------------- prompt */

.prompt {
  padding: 120px 0 0;
  text-align: center;
}

.prompt h2 {
  margin: 0 0 12px;
  font-size: clamp(1.9rem, 4vw, 2.6rem);
  font-weight: 650;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
}

.prompt > p {
  max-width: 32rem;
  margin: 0 auto;
  color: var(--vp-c-text-2);
  font-size: 1.08rem;
  line-height: 1.6;
}

.prompt-box {
  max-width: 40rem;
  margin: 28px auto 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 16px 16px 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 18px;
  background: var(--vp-c-bg-soft);
  text-align: left;
}

.prompt-text {
  flex: 1;
  margin: 0;
  font-size: 15.5px;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  user-select: all;
}

.prompt-box .button { flex: 0 0 auto; padding: 11px 20px; }

.ideas {
  max-width: 40rem;
  margin: 18px auto 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  font-size: 14px;
}

/*
 * On its own line. Inline with the chips, the label and the first chip filled
 * the first row and the rest spilled underneath in a shape that changed with
 * every screen width.
 */
.ideas-label { flex-basis: 100%; color: var(--vp-c-text-3); margin-bottom: 2px; }

.idea {
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}

.prompt > .button { margin-top: 32px; }

/* ------------------------------------------------------------------ door */

.door {
  margin-top: 120px;
  padding-top: 28px;
  border-top: 1px solid var(--vp-c-divider);
  text-align: center;
}

.door p {
  margin: 0;
  font-size: 14px;
  color: var(--vp-c-text-3);
  line-height: 1.6;
}

.door strong { color: var(--vp-c-text-2); font-weight: 600; }
.door a { color: var(--vp-c-text-2); text-decoration: underline; text-underline-offset: 3px; }

/* ---------------------------------------------------------------- order */

.taps { order: 10; margin-top: 104px; }
.desktop { order: 11; }
.prompt { order: 12; }
.door { order: 13; }

/* ------------------------------------------------------------ responsive */

@media (max-width: 860px) {
  .hero { padding: 56px 0 20px; }

  .row { gap: 14px; }
  .phone:nth-child(2) { transform: none; }
  .device { padding: 5px; border-radius: 22px; }
  .device img { border-radius: 18px; aspect-ratio: 390 / 620; }
  .label { font-size: 13px; margin-top: 10px; }

  .with-shot { grid-template-columns: 1fr; gap: 28px; }

  .beat { padding-top: 72px; }

  /* Three taps, right after the phones: she is probably holding one. */
  .taps { order: 0; margin-top: 72px; }

  .prompt { padding-top: 80px; }
  .prompt-box { flex-direction: column; align-items: stretch; }
  .prompt-box .button { text-align: center; }

  .door { margin-top: 80px; }
}
</style>
