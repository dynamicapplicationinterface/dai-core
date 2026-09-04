import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * There is one container compiler, and these tests are what keep it that way.
 *
 * The format has five front ends — the Vite plugin, the command line, the
 * website, the desktop app and eventually an MCP server — and the temptation
 * each time is to reach for fflate directly rather than route through the core.
 * Nothing would break immediately. They would drift: a different compression
 * level, a manifest field set in one place and not another, and eventually a
 * container that verifies under one tool and is refused by another. By then the
 * cause is five commits back in whichever wrapper was updated last.
 *
 * So the rule is mechanical: only core.ts and container.ts may zip, hash or
 * sign. Everything else gathers bytes and calls in.
 */
const ENGINE_FILES = [
  // The compiler and the verifier. These are the only places the container
  // format is actually implemented.
  "src/core.ts",
  "src/container.ts",
  // The two shared doors onto it: one resolving assets on a filesystem, one
  // fetching them in a page and minting the throwaway identity a browser has to
  // use. They are allowed to touch WebCrypto because centralising that is the
  // entire reason they exist.
  "src/compile.ts",
  "src/browser.ts",
];

/** What it means to be doing the container's own work. */
const ENGINE_WORK: { name: string; pattern: RegExp }[] = [
  { name: "zipping", pattern: /\bzipSync\s*\(|\bunzipSync\s*\(|from ["']fflate["']/ },
  { name: "hashing", pattern: /crypto\.subtle\.digest\s*\(/ },
  { name: "signing", pattern: /crypto\.subtle\.(?:sign|verify|importKey|exportKey)\s*\(/ },
];

async function sourceFiles(dir: string, extensions: string[]): Promise<string[]> {
  const files = await collectFiles(resolve(repo, dir));
  return files
    .filter((file) => extensions.some((extension) => file.entry.endsWith(extension)))
    .filter((file) => !file.entry.includes("node_modules"))
    .map((file) => file.absolute);
}

test.describe("one engine", () => {
  test("no wrapper zips, hashes or signs on its own", async () => {
    const wrappers = [
      ...(await sourceFiles("src", [".ts"])),
      ...(await sourceFiles("website/components", [".vue"])),
      // The desktop app is a front end like any other, and was the one place
      // this guard did not look. It had grown its own compile call, which built
      // containers with no SQLite engine at all.
      ...(await sourceFiles("apps/desktop/src", [".ts"])),
    ].filter((file) => {
      const rel = relative(repo, file).split("\\").join("/");
      // The bootloader is not a wrapper: it is the verifier, and it runs inside
      // the container where it cannot import anything.
      return !ENGINE_FILES.includes(rel) && !rel.startsWith("src/runtime/");
    });

    const offences: string[] = [];
    for (const file of wrappers) {
      const source = readFileSync(file, "utf8");
      for (const work of ENGINE_WORK) {
        if (work.pattern.test(source)) {
          offences.push(`${relative(repo, file)} is ${work.name} directly`);
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });

  test("one definition of what breaks inside a container", async () => {
    // The paste page, the command line and the MCP server all tell people what
    // will not work once a file is sealed. Three copies of that list would
    // disagree within a month, and a model would be told its code was fine by
    // one tool and unusable by another.
    const callers = [
      "website/components/MakeYourOwn.vue",
      "src/mcp.ts",
      "apps/desktop/src/main.ts",
    ];
    for (const file of callers) {
      const source = readFileSync(resolve(repo, file), "utf8");
      expect(/lintSource|lintFiles/.test(source), `${file} does not use the shared lint`).toBe(
        true,
      );
      // Looks for the shape of a check list — a `pattern:` holding a regex —
      // rather than for the words themselves. Both files legitimately mention
      // localStorage and CDNs in prose: one in a comment, one in the guidance
      // it gives a model. Matching on vocabulary flagged the documentation and
      // would have pushed someone to make it vaguer to appease a test.
      expect(
        /pattern:\s*\//.test(source),
        `${file} looks like it has grown its own copy of the checks`,
      ).toBe(false);
    }
  });

  test("one recipe, wherever it is read", async () => {
    // A person pastes it into a chat, the MCP server hands it to a model, and
    // the website publishes it. Separate copies would end with a model told one
    // thing by the tool and another by the page, and no way to tell which it
    // was following.
    const readers = [
      "src/mcp.ts",
      "website/components/MakeYourOwn.vue",
      "website/components/Recipe.vue",
    ];
    for (const file of readers) {
      const source = readFileSync(resolve(repo, file), "utf8");
      expect(/recipe\.js/.test(source), `${file} does not import the shared recipe`).toBe(true);
    }
  });

  test("the recipe still teaches what a model must know", async () => {
    const { RECIPE } = await import("../src/recipe.js");
    // Losing any of these turns the server into something that produces blank
    // apps, and nobody finds out until a person opens one.
    expect(RECIPE).toMatch(/no network|NO NETWORK/i);
    expect(RECIPE).toMatch(/window\.dai\.openDatabase/);
    expect(RECIPE).toMatch(/saveDatabase/);
    expect(RECIPE).toMatch(/type="module"/);
    expect(RECIPE).toMatch(/localStorage/);
    expect(RECIPE).toMatch(/index\.html/);
    // The shape it should hand the application back in. Without this a model
    // invents a layout per answer, and whoever receives it copies files out of
    // a chat window by hand.
    expect(RECIPE).toContain("dai bundle v1");
    expect(RECIPE).toContain("--- file: ");
    // The shortcut that removes most of the code a model gets wrong. A recipe
    // that stopped mentioning it would quietly go back to asking for a state
    // machine.
    expect(RECIPE).toContain("dai-kit.js");
    expect(RECIPE).toContain("<dai-rows");
  });

  test("the bundle the recipe describes is the bundle the reader accepts", async () => {
    /*
     * The instruction and the parser are two statements of one format, written
     * in different places, and the day they disagree is a day every completion
     * is rejected for following the instructions.
     */
    const { RECIPE } = await import("../src/recipe.js");
    const { parseBundle } = await import("../src/bundle.js");

    // The example out of the recipe itself, completed just enough to be a
    // bundle rather than an illustration.
    // From the opening fence to the closing one, exactly as a model would
    // write it and a person would paste it.
    const opening = RECIPE.indexOf("```text");
    const closing = RECIPE.indexOf("```", RECIPE.indexOf("dai bundle v1"));
    const example = RECIPE.slice(opening, closing + 3).replace("…", "<title>Example</title>");

    const bundle = parseBundle(`${example}\n`);
    expect(Object.keys(bundle.files).sort()).toEqual(["app.js", "icon.svg", "index.html"]);
    expect(bundle.name).toBe("Reading list");
  });

  test("every front end reaches the compiler through one of two doors", async () => {
    // Node-side callers go through compile.ts, browser-side ones through
    // browser.ts. Two doors, both opening onto the same room.
    const frontEnds: Record<string, RegExp> = {
      "src/index.ts": /from "\.\/compile\.js"/,
      "src/cli.ts": /from "\.\/compile\.js"/,
      "src/mcp.ts": /from "\.\/compile\.js"/,
      "website/components/MakeYourOwn.vue": /from '\.\.\/\.\.\/src\/browser\.js'/,
      "website/components/MakerWalkthrough.vue": /from '\.\.\/\.\.\/src\/browser\.js'/,
      "website/components/TamperProof.vue": /from '\.\.\/\.\.\/src\/container\.js'/,
      "apps/desktop/src/main.ts": /from "\.\.\/\.\.\/\.\.\/src\/browser\.js"/,
    };

    for (const [file, expected] of Object.entries(frontEnds)) {
      const source = readFileSync(resolve(repo, file), "utf8");
      expect(expected.test(source), `${file} does not import the shared compiler`).toBe(true);
    }
  });
});
