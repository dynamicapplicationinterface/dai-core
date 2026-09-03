<script setup lang="ts">
/**
 * The landing page.
 *
 * Built as a component rather than markdown because the default home layout
 * cannot give this much air, and air is the design. Two audiences arrive here —
 * somebody whose assistant just wrote them an app, and somebody deciding
 * whether their staff may use one — and they need opposite things, so the page
 * forks in the first screen instead of trying to address both at once.
 *
 * Every image is a photograph of the running application, captured from a real
 * container by scripts/capture-screenshots.mjs. Illustrating a claim about
 * files that work with a drawing would undercut the claim.
 */
const uses = [
  {
    kicker: "Nothing to set up",
    title: "The database is inside the file",
    body:
      "No servers, no hosting, no accounts. Real SQLite is compiled in, so an app you make " +
      "in the morning is a document you can use in the afternoon.",
    shot: "/shots/app-compose.png",
    alt: "Adding a task, with project, priority and tag fields open",
  },
  {
    kicker: "Safe to hand over",
    title: "It has nothing to call out with",
    body:
      "A container declares its permitted connections as none, and the browser enforces that: " +
      "no requests, no sockets, no popups. Every byte is fingerprinted too, so a file that has " +
      "been altered is detectable and a host that checks will refuse to run it.",
    shot: "/shots/app-dark.png",
    alt: "The same application in dark mode",
    link: { text: "Break one yourself", href: "/tamper-proof" },
  },
  {
    kicker: "It goes where you go",
    title: "Email it, and it just opens",
    body:
      "On a laptop with no wifi, on a machine with nothing installed, in ten years. " +
      "Your data travels inside the same file, so there is no account to lose.",
    shot: "/shots/app-empty.png",
    alt: "The application with an empty task list",
  },
];

const routes = [
  {
    name: "The desktop app",
    detail: "Drop in a folder, get a file. No terminal, ever.",
    href: "/desktop",
  },
  {
    name: "In your browser",
    detail: "Nothing to install at all.",
    href: "/make-your-own",
  },
  {
    name: "With an assistant",
    detail: "Describe it. The model writes it; the compiler seals it.",
    href: "/docs/making-files#with-an-assistant",
  },
  {
    name: "Command line",
    detail: "npx dai build ./dist",
    href: "/docs/making-files#from-the-command-line",
  },
  {
    name: "Vite plugin",
    detail: "React, Vue, Svelte — anything with a build.",
    href: "/docs/making-files#from-a-vite-project",
  },
];
</script>

<template>
  <div class="landing">
    <section class="hero">
      <h1>An app that's<br />just a file.</h1>
      <!--
        The headline is the hook, not the claim: anyone can write a single HTML
        file. The kicker carries what one of those cannot do — keep its data,
        prove it has not been altered, and travel without a server.
      -->
      <p class="kick">
        With its database inside.<br />
        Sealed, offline, and yours to send.
      </p>
      <p class="lede">
        Ask an assistant for the app you want. Two minutes later you have a file
        you can email to anyone.
      </p>
      <div class="actions">
        <a class="button primary" href="/make-one">I made something with AI</a>
        <a class="button" href="/tamper-proof">My team wants to use these</a>
      </div>

      <figure class="stage">
        <img src="/shots/app-light.png" alt="A task application running from a single file" />
        <figcaption>
          A real application, running from one 800&nbsp;KB file with nothing installed.
        </figcaption>
      </figure>
    </section>

    <section
      v-for="(use, index) in uses"
      :key="use.title"
      class="use"
      :class="{ flipped: index % 2 === 1 }"
    >
      <div class="use-text">
        <p class="kicker">{{ use.kicker }}</p>
        <h2>{{ use.title }}</h2>
        <p>{{ use.body }}</p>
        <a v-if="use.link" class="more" :href="use.link.href">{{ use.link.text }} →</a>
      </div>
      <figure class="use-shot">
        <img :src="use.shot" :alt="use.alt" loading="lazy" />
      </figure>
    </section>

    <section class="desktop">
      <div class="desktop-text">
        <p class="kicker">The desktop app</p>
        <h2>For people who never open a terminal</h2>
        <p>
          Install it once and DAI files become documents: they get their own
          icon, open on double-click, and run in a clean window instead of a
          browser tab. Saving writes straight back into the file, with no
          download prompt.
        </p>
        <p>
          It builds them too. Drop in a folder or a zip from your assistant and
          it compiles and signs on your machine — the same compiler as
          everything else, no command line anywhere.
        </p>
        <div class="desktop-actions">
          <a class="button primary" href="/desktop">What it does</a>
          <a class="button" href="https://github.com/dynamicapplicationinterface/dai-core/releases">Download</a>
        </div>
      </div>
      <figure class="use-shot">
        <img src="/shots/desktop-create.png" alt="The desktop app's create dialog" loading="lazy" />
      </figure>
    </section>

    <PhoneFlow class="section-gap" />

    <section class="routes">
      <h2>Five ways to make one</h2>
      <p class="routes-note">All of them run the same compiler. There is no lite version.</p>
      <div class="route-grid">
        <a v-for="route in routes" :key="route.name" class="route" :href="route.href">
          <span class="route-name">{{ route.name }}</span>
          <span class="route-detail">{{ route.detail }}</span>
        </a>
      </div>
    </section>

    <section class="closing">
      <h2>Start with one you can hold</h2>
      <p>Ninety seconds, nothing installed, and the file is yours.</p>
      <a class="button primary" href="/make-one">Make one</a>
    </section>
  </div>
</template>

<style scoped>
.landing {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 24px 96px;
}

/* ------------------------------------------------------------------ hero */

.hero {
  padding: 84px 0 40px;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: clamp(2.6rem, 7vw, 4.6rem);
  font-weight: 700;
  line-height: 1.03;
  letter-spacing: -0.045em;
}

.kick {
  max-width: 30rem;
  margin: 22px auto 0;
  font-size: clamp(1.25rem, 2.4vw, 1.6rem);
  font-weight: 550;
  line-height: 1.35;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.lede {
  max-width: 30rem;
  margin: 18px auto 0;
  font-size: 1.05rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
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
  transition: border-color 0.15s, transform 0.15s;
}

.button:hover {
  border-color: var(--vp-c-text-3);
  transform: translateY(-1px);
}

.button.primary {
  color: #fff;
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.button.primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}

.section-gap {
  margin: 96px 0 0;
}

.stage {
  margin: 64px 0 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(16, 21, 31, 0.05), 0 30px 70px rgba(16, 21, 31, 0.12);
}

.dark .stage {
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5), 0 30px 70px rgba(0, 0, 0, 0.45);
}

.stage img {
  display: block;
  width: 100%;
}

figcaption {
  padding: 14px 20px;
  font-size: 13px;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-alt);
  border-top: 1px solid var(--vp-c-divider);
}

/* ------------------------------------------------------------- use cases */

.use {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  align-items: center;
  gap: 56px;
  padding: 88px 0;
}

/*
 * Flipping the order alone left the screenshot in the narrow column, so every
 * other image rendered at half size. The column widths swap with it.
 */
.use.flipped {
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
}

.use.flipped .use-text {
  order: 2;
}

.kicker {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

.use h2 {
  margin: 0 0 14px;
  font-size: 2rem;
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
}

.use p {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.more {
  display: inline-block;
  margin-top: 16px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.use-shot {
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 21, 31, 0.05), 0 20px 50px rgba(16, 21, 31, 0.1);
}

.dark .use-shot {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 20px 50px rgba(0, 0, 0, 0.4);
}

.use-shot img {
  display: block;
  width: 100%;
}

/* --------------------------------------------------------------- desktop */

.desktop {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  align-items: center;
  gap: 56px;
  padding: 40px 0 88px;
}

.desktop h2 {
  margin: 0 0 14px;
  font-size: 2rem;
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
}

.desktop p {
  margin: 0 0 14px;
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.desktop-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }

/* ---------------------------------------------------------------- routes */

.routes {
  padding: 40px 0 24px;
  text-align: center;
}

.routes h2 {
  margin: 0;
  font-size: 2rem;
  font-weight: 650;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
}

.routes-note {
  margin: 10px 0 36px;
  color: var(--vp-c-text-3);
}

.route-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px;
  text-align: left;
}

.route {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  text-decoration: none;
  transition: border-color 0.15s, transform 0.15s;
}

.route:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.route-name {
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.route-detail {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--vp-c-text-3);
}

/* --------------------------------------------------------------- closing */

.closing {
  padding: 96px 0 24px;
  text-align: center;
}

.closing h2 {
  margin: 0;
  font-size: 2.2rem;
  font-weight: 650;
  letter-spacing: -0.03em;
  border: 0;
  padding: 0;
}

.closing p {
  margin: 12px 0 28px;
  color: var(--vp-c-text-2);
}

/* ------------------------------------------------------------ responsive */

@media (max-width: 860px) {
  .use {
    grid-template-columns: 1fr;
    gap: 28px;
    padding: 56px 0;
  }

  .use.flipped .use-text {
    order: 0;
  }

  .desktop {
    grid-template-columns: 1fr;
    gap: 28px;
    padding: 24px 0 56px;
  }

  .hero {
    padding: 52px 0 24px;
  }

  .stage {
    margin-top: 44px;
  }
}
</style>
