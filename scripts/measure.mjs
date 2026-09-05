/**
 * Tap to first run, measured (backlog 5.1).
 *
 * The number this project is judged on is seconds from tapping a link to the
 * application being usable, on a phone that has never seen it before. Nothing
 * measured that end to end: `docs/performance.md` measured the file path on a
 * desktop, which is the shape of the problem and not the number.
 *
 * This walks the paths a person actually takes and prints what each one costs:
 *
 *   inline cold    a document inside the link, first sight, empty profile
 *   inline warm    the same link again, with everything already kept
 *   reference cold a document fetched from a store, first sight
 *   reference warm the same, already kept
 *   file           a file chosen from the device, for the desktop comparison
 *
 * Cold means a fresh browser profile every time — no OPFS, no IndexedDB, no
 * HTTP cache, nothing pinned — because "cold" measured in a warm profile is
 * the number that flatters, and it is the number somebody sent a link actually
 * gets.
 *
 * What this is not: a phone, and a network. It runs headless on whatever
 * machine invokes it, so the absolute numbers are a floor rather than the
 * target. What it does give is a repeatable figure per path that moves when
 * the code moves, and the breakdown of where the time went — which is the part
 * that says what to do next. Publishing the number per release from a real
 * device needs a device to publish from, and that is a decision about spend
 * rather than an engineering step.
 *
 *   node scripts/measure.mjs             prints the table
 *   node scripts/measure.mjs --json out  also writes the raw numbers
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
// From the build rather than the source: this is a script, and `npm run
// build` is already the step before anything here is worth measuring.
import { compileDirectory } from "../dist/compile.js";
import { inlineLink } from "../dist/link.js";
import { publish } from "../dist/store.js";
import { fsStore } from "../dist/store-fs.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "apps/runner/dist");
const PORT = 5177;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** How many times each path is walked. The median is reported, not the best. */
const RUNS = 5;

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Serves the built opener and a store directory, with no logic in it. */
function serve(storeRoot) {
  return new Promise((ready) => {
    const server = spawn(
      process.execPath,
      [
        "-e",
        `const {createServer}=require("node:http"),{createReadStream,existsSync,statSync}=require("node:fs"),{join,extname}=require("node:path");
         const types={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".json":"application/json",".wasm":"application/wasm",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".webmanifest":"application/manifest+json"};
         createServer((q,s)=>{
           const path=decodeURIComponent((q.url||"/").split("?")[0]);
           if(path.startsWith("/store/")){
             const f=join(${JSON.stringify(storeRoot)},path.slice(7));
             if(!existsSync(f)){s.writeHead(404,{"access-control-allow-origin":"*"}).end();return;}
             s.writeHead(200,{"content-type":"application/octet-stream","access-control-allow-origin":"*"});
             createReadStream(f).pipe(s);return;
           }
           const rewritten=/^\\/d\\/[0-9a-f]{64}\\/?$/i.test(path)?"/":path;
           const f=join(${JSON.stringify(dist)},rewritten==="/"?"index.html":rewritten.replace(/^\\/+/,""));
           if(!f.startsWith(${JSON.stringify(dist)})||!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404).end();return;}
           s.writeHead(200,{"content-type":types[extname(f)]||"application/octet-stream"});
           createReadStream(f).pipe(s);
         }).listen(${PORT},"127.0.0.1",()=>console.log("up"));`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("up")) ready(server);
    });
  });
}

/**
 * One walk: open the address, press the card if there is one, and stop the
 * clock when the application says it is interactive.
 *
 * The clock starts at `goto`, which is the tap. The card is part of the wait
 * only to the extent that a person has to press it, and they cannot press it
 * before it is on screen — so the press is inside the measurement, and the
 * time somebody spends reading it is not, because nobody can measure that.
 */
async function walk(browser, address, { cold, file }) {
  const context = cold
    ? await browser.newContext()
    : (walk.context ??= await browser.newContext());
  const page = await context.newPage();

  const started = Date.now();
  await page.goto(address);
  if (file) await page.setInputFiles("#file", file);

  const card = page.locator("#card-open");
  await Promise.race([
    card.waitFor({ state: "visible", timeout: 60_000 }).then(() => card.click()),
    page.locator("body.loaded").waitFor({ timeout: 60_000 }),
  ]).catch(() => {});
  await page.locator("body.loaded").waitFor({ timeout: 60_000 });

  /*
   * The clock stops at interactive, not at mounted.
   *
   * `body.loaded` is this app saying it has handed the document to its frame.
   * The document is not usable until the application inside it says so, and
   * the gap between the two is exactly the part a person is still waiting
   * through — stopping at the earlier mark would be measuring our half and
   * calling it the number.
   */
  await page
    .waitForFunction(
      () => window.__daiTimings?.some((entry) => entry.phase === "interactive"),
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => {});
  const usable = Date.now() - started;

  const phases = await page.evaluate(() => ({
    host: window.__daiHostTimings ?? [],
    container: window.__daiTimings ?? [],
  }));

  await page.close();
  if (cold) await context.close();
  return { usable, phases };
}

async function main() {
  if (!existsSync(dist)) {
    console.error("Build the opener first: npx vite build --config apps/runner/vite.config.ts apps/runner");
    process.exit(1);
  }

  const storeRoot = mkdtempSync(join(tmpdir(), "dai-measure-"));
  const built = await compileDirectory({
    sourceDir: join(repo, "examples/chore-chart"),
    root: repo,
    appName: "Chore chart",
  });
  const filePath = join(storeRoot, "chore-chart.dai.html");
  writeFileSync(filePath, built.html, "utf8");

  const server = await serve(storeRoot);
  const browser = await chromium.launch();

  try {
    // The shell this sender can rebuild, so the compact carrier may leave it
    // out of the link. Read from the build, which is where the opener's is.
    const host = {
      template: readFileSync(join(repo, "dist/template.html"), "utf8"),
      runtime: readFileSync(join(repo, "dist/dai-runtime.js"), "utf8"),
    };
    const inline = await inlineLink(built.html, ORIGIN, host);
    const { sealed } = await publish(
      built.html,
      fsStore({ root: storeRoot, baseUrl: `${ORIGIN}/store` }),
      ORIGIN,
    );
    const reference =
      `${ORIGIN}/d/${sealed.hash}` +
      `#h=${sealed.hash}&u=${encodeURIComponent(`${ORIGIN}/store/${sealed.hash}`)}&k=${sealed.key}`;

    const paths = [
      inline && { name: "inline cold", address: inline, cold: true },
      inline && { name: "inline warm", address: inline, cold: false },
      { name: "reference cold", address: reference, cold: true },
      { name: "reference warm", address: reference, cold: false },
      { name: "file", address: ORIGIN, cold: true, file: filePath },
    ].filter(Boolean);

    const results = [];
    for (const path of paths) {
      const runs = [];
      let phases = { host: [], container: [] };
      for (let n = 0; n < RUNS; n += 1) {
        const one = await walk(browser, path.address, path);
        runs.push(one.usable);
        phases = one.phases;
      }
      results.push({ name: path.name, ms: median(runs), runs, phases });
    }

    const width = Math.max(...results.map((r) => r.name.length));
    console.log("\ntap to usable, median of " + RUNS + " — headless, local, no network delay\n");
    for (const result of results) {
      const inside = result.phases.container.map((p) => `${p.phase} ${Math.round(p.at)}`).join("  ");
      console.log(
        `  ${result.name.padEnd(width)}  ${String(Math.round(result.ms)).padStart(5)} ms   ${inside}`,
      );
    }
    console.log(
      "\n  A floor, not the target: this machine, headless, with the store on " +
        "localhost.\n  The number that matters is the same walk on a mid-range " +
        "Android over cellular.\n",
    );

    const jsonAt = process.argv.indexOf("--json");
    if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
      writeFileSync(
        resolve(process.cwd(), process.argv[jsonAt + 1]),
        JSON.stringify({ measuredAt: new Date().toISOString(), runs: RUNS, results }, null, 2) + "\n",
        "utf8",
      );
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
