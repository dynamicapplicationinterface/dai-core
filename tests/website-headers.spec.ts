import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Rule {
  source: string;
  headers: { key: string; value: string }[];
}

const rules = (): Rule[] =>
  (JSON.parse(readFileSync(join(repo, "website", "vercel.json"), "utf8")) as { headers: Rule[] })
    .headers;

const cacheFor = (source: string): string | undefined =>
  rules()
    .find((rule) => rule.source === source)
    ?.headers.find((header) => header.key.toLowerCase() === "cache-control")?.value;

/**
 * What the site tells a browser it may keep, and for how long.
 *
 * One of these is a straightforward speed improvement and the other would be a
 * bug nobody could fix afterwards, which is why they are written down rather
 * than left to whoever next reads the config and notices an inconsistency.
 */
test.describe("caching", () => {
  test("hashed assets are cached for a year", () => {
    // Their names carry a hash of their contents, so a change produces a new
    // name and the old one is never requested again. Safe to keep for ever, and
    // it saves every returning visitor a revalidation round trip.
    const value = cacheFor("/assets/(.*)");
    expect(value).toContain("immutable");
    expect(value).toMatch(/max-age=\d{7,}/);
  });

  for (const path of ["/runtime/(.*)", "/shots/(.*)"]) {
    test(`${path} is not cached immutably`, () => {
      /*
       * The names here are stable and the contents are not. `sqlite3.wasm` and
       * `dai-runtime.js` are rebuilt whenever the shell or the bootloader
       * changes, and a browser told to keep them for a year would go on
       * compiling containers with a months-old runtime — in a cache we cannot
       * reach.
       *
       * When the committed copies of these went stale, one redeploy fixed it.
       * A stale copy in somebody's browser cannot be fixed at all, which is why
       * this is a test and not a comment.
       */
      const value = cacheFor(path);
      expect(
        value,
        `${path} must not be immutable: its filenames are stable and its contents are not`,
      ).toBeUndefined();
    });
  }

  test("the runtime is not swept up by a broader rule", () => {
    // A catch-all that happened to match /runtime would do the same damage as
    // naming it directly.
    for (const rule of rules()) {
      const caching = rule.headers.find((header) => header.key.toLowerCase() === "cache-control");
      if (!caching?.value.includes("immutable")) continue;
      expect(
        rule.source.startsWith("/assets/"),
        `${rule.source} caches immutably and would cover paths whose names do not change`,
      ).toBe(true);
    }
  });
});

/**
 * The headers the handoff depends on.
 *
 * "Open it now" builds a document on the website and hands it to the opener in
 * a new tab by postMessage. That needs the new tab to keep a reference to the
 * page that opened it, and Cross-Origin-Opener-Policy: same-origin — on either
 * side — cuts that reference. Both sides sent it. Nothing in either app needs
 * cross-origin isolation; the header had been copied in without a reason and
 * broke the one feature that depended on its absence.
 */
test.describe("the handoff's headers", () => {
  const coopOf = (file: string): string | undefined =>
    (JSON.parse(readFileSync(join(repo, file), "utf8")) as { headers: Rule[] }).headers
      .find((rule) => rule.source === "/(.*)")
      ?.headers.find((header) => header.key === "Cross-Origin-Opener-Policy")?.value;

  test("the opener keeps the page that opened it", () => {
    // Anything but unsafe-none severs a popup from a cross-origin opener.
    expect(coopOf("apps/runner/vercel.json")).toBe("unsafe-none");
  });

  test("the website keeps a handle on the tabs it opens", () => {
    // same-origin would disconnect the handle the moment the tab opened;
    // allow-popups keeps the site isolated and keeps the handle.
    expect(coopOf("website/vercel.json")).toMatch(/^(same-origin-allow-popups|unsafe-none)$/);
  });
});

/**
 * The opener's Content-Security-Policy.
 *
 * The opener origin holds every document a person has opened and their trust
 * pins, so it is the one origin where a second line of defence matters, and
 * for a long time it sent none: no CSP, no frame-ancestors, framable by any
 * page for clickjacking. This pins what it sends now — and, as importantly,
 * what it must not.
 *
 * It must not send `script-src` or `default-src`. A document runs in a frame
 * whose URL is `blob:`, and a blob document inherits the policy of the page
 * that made it. The shell in that frame runs one inline script under a nonce
 * minted per mount, which a static header cannot name — so a `script-src`
 * here would be inherited by the shell, fail to match its nonce, and stop
 * every document from running. Every fetch directive that *is* sent is a
 * superset of what the shell's own <meta> policy allows, so the inherited copy
 * narrows nothing there and the shell's policy stays the one that binds.
 */
test.describe("the opener's policy", () => {
  const csp = (): Record<string, string> => {
    const value = (JSON.parse(readFileSync(join(repo, "apps/runner/vercel.json"), "utf8")) as { headers: Rule[] }).headers
      .find((rule) => rule.source === "/(.*)")
      ?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
    expect(value).toBeDefined();
    return Object.fromEntries(
      value!.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
        const [name, ...rest] = d.split(/\s+/);
        return [name!, rest.join(" ")];
      }),
    );
  };

  test("cannot be framed by another origin", () => {
    expect(csp()["frame-ancestors"]).toBe("'self'");
  });

  test("sends no script-src and no default-src, because a blob: frame inherits them", () => {
    const policy = csp();
    expect(policy["script-src"]).toBeUndefined();
    expect(policy["default-src"]).toBeUndefined();
  });

  test("closes what it can without touching the shell", () => {
    const policy = csp();
    expect(policy["object-src"]).toBe("'none'");
    expect(policy["base-uri"]).toBe("'self'");
    expect(policy["form-action"]).toBe("'self'");
    // Documents come from stores at other origins, over TLS — or from the
    // person's own machine. Never plain http to anywhere else.
    expect(policy["connect-src"]).toMatch(/https:/);
    expect(policy["connect-src"].replace(/http:\/\/(localhost|127\.0\.0\.1):\*/g, "")).not.toMatch(/http:/);
  });

  test("is a superset of the shell's own policy, directive for directive", () => {
    const header = csp();
    const shell = readFileSync(join(repo, "src/template.html"), "utf8")
      .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1]!;
    for (const directive of shell.split(";").map((d) => d.trim()).filter(Boolean)) {
      const [name, ...sources] = directive.split(/\s+/);
      if (!(name! in header)) continue; // not sent: nothing inherited, nothing narrowed
      if (name === "connect-src" || name === "form-action" || name === "base-uri") continue; // the shell is stricter, by design
      for (const source of sources) {
        if (source === "'none'" || source.startsWith("'nonce-")) continue;
        expect(header[name!], `${name} must allow ${source} or the shell loses it`).toContain(source);
      }
    }
  });
});
