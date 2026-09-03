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
    const callers = ["website/components/MakeYourOwn.vue", "src/mcp.ts"];
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
    };

    for (const [file, expected] of Object.entries(frontEnds)) {
      const source = readFileSync(resolve(repo, file), "utf8");
      expect(expected.test(source), `${file} does not import the shared compiler`).toBe(true);
    }
  });
});
