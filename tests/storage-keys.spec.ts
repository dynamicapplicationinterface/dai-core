import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { KEYS, groundKey, installAskedKey, libraryLock, opensKey, seqFloorKey } from "../src/keys.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every opener source file, read as text. */
function openerSources(): { name: string; text: string }[] {
  const dir = resolve(repo, "apps/runner/src");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ name: `apps/runner/src/${file}`, text: readFileSync(join(dir, file), "utf8") }));
}

/**
 * The opener's storage and lock keys have one definer (D73).
 *
 * Local storage, session storage and the lock manager are flat maps shared by
 * everything on the origin, and these keys were written where they were used,
 * in three files. Two keys that collide there do not fail; they overwrite each
 * other, quietly, on somebody's device. `src/keys.ts` is the one definer, and
 * this refuses a second one.
 *
 * Read as text, because the point is where a name is *written*, not what a
 * running module returns.
 */
test.describe("the opener's storage and lock keys", () => {
  test("the owner makes the keys the opener actually uses", () => {
    expect(KEYS.KEEP_AFTER_RELOAD).toBe("dai:keep-after-reload");
    expect(KEYS.IOS_RELOAD_TAKEN).toBe("dai:ios-reload-taken");
    expect(KEYS.IOS_RELOAD_CARRIED).toBe("dai:ios-reload-carried");
    expect(KEYS.MANIFEST_FALLBACK).toBe("dai:manifest-fallback");
    expect(KEYS.RESUME).toBe("dai:resume");
    expect(KEYS.PERSON_KEY).toBe("dai:person-key");
    expect(groundKey("u", "light")).toBe("dai:ground:u:light");
    expect(installAskedKey("u")).toBe("dai:install-asked:u");
    expect(opensKey("u")).toBe("dai:opens:u");
    expect(libraryLock("u")).toBe("dai:u");
    expect(seqFloorKey("u")).toBe("dai:seq-floor:u");
  });

  test("no opener file writes one of these names by hand", () => {
    const owned = [
      "dai:keep-after-reload",
      "dai:ios-reload-taken",
      "dai:ios-reload-carried",
      "dai:manifest-fallback",
      "dai:resume",
      "dai:ground:",
      "dai:install-asked:",
      "dai:opens:",
      "dai:person-key",
      "dai:seq-floor:",
    ];
    const offenders: string[] = [];
    for (const { name, text } of openerSources()) {
      for (const key of owned) {
        if (text.includes(`"${key}`) || text.includes(`\`${key}`)) offenders.push(`${name} spells ${key}`);
      }
    }
    expect(offenders, `keys spelled outside src/keys.ts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  test("and no two keys can collide", () => {
    // Every key the owner can make, for one document and one scheme: a
    // namespace is only safe if no two of its makers can produce one string.
    const uuid = "7b1f5f3e-0000-4000-8000-000000000001";
    const made = [
      KEYS.KEEP_AFTER_RELOAD,
      KEYS.IOS_RELOAD_TAKEN,
      KEYS.IOS_RELOAD_CARRIED,
      KEYS.MANIFEST_FALLBACK,
      KEYS.RESUME,
      groundKey(uuid, "light"),
      groundKey(uuid, "dark"),
      installAskedKey(uuid),
      opensKey(uuid),
      libraryLock(uuid),
      KEYS.PERSON_KEY,
      seqFloorKey(uuid),
    ];
    expect(new Set(made).size, `two of these are the same string:\n  ${made.join("\n  ")}`).toBe(made.length);
  });

  test("the head script's copy of the ground key still matches the owner", () => {
    /*
     * The one other definer, and it cannot import: the script in the shell's
     * head runs before any module, to paint the colour under the clock before
     * the first frame. It builds the key by hand. The owner's shape is held to
     * that copy here, so a rename in `src/keys.ts` cannot silently leave the
     * head script writing somewhere else.
     */
    const shell = readFileSync(resolve(repo, "apps/runner/index.html"), "utf8");
    const made = groundKey("<uuid>", "<scheme>");
    const prefix = made.slice(0, made.indexOf("<uuid>"));
    expect(shell, `the head script no longer builds ${prefix}…`).toContain(`"${prefix}"`);
  });

  test("the reading still finds the opener's files", () => {
    // A file list that goes empty would make the check above pass by looking
    // at nothing.
    const sources = openerSources();
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.some((file) => file.name.endsWith("main.ts"))).toBe(true);
  });
});
