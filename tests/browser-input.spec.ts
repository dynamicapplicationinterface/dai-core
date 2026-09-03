import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { isNoise, stripCommonPrefix, unpackZip } from "../src/browser.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * What comes back from an assistant, and what has to survive the trip.
 *
 * A model asked for a multi-file application produces a zip, because a folder
 * cannot be pasted into a chat window — and that zip almost always unpacks to a
 * wrapping directory. A container whose entry point is one level down opens
 * blank, so this is the difference between the page working and the page
 * appearing to work.
 */
test.describe("taking files in", () => {
  test("unpacks a zip and drops the wrapping folder", () => {
    const archive = zipSync({
      "my-app/index.html": encode("<h1>Hi</h1>"),
      "my-app/app.js": encode("console.log(1);"),
      "my-app/style/app.css": encode("body{}"),
    });

    const files = unpackZip(archive);

    expect(Object.keys(files).sort()).toEqual(["app.js", "index.html", "style/app.css"]);
    expect(decode(files["index.html"]!)).toBe("<h1>Hi</h1>");
  });

  test("leaves real top-level folders alone", () => {
    // Only a prefix shared by everything is a wrapper. Stripping "src" here
    // would move app.js on top of index.html.
    const files = stripCommonPrefix({
      "index.html": encode("a"),
      "src/app.js": encode("b"),
    });
    expect(Object.keys(files).sort()).toEqual(["index.html", "src/app.js"]);
  });

  test("keeps a zip that was already flat", () => {
    const files = unpackZip(zipSync({ "index.html": encode("a"), "app.js": encode("b") }));
    expect(Object.keys(files).sort()).toEqual(["app.js", "index.html"]);
  });

  test("does not confuse a shared first letter for a shared folder", () => {
    const files = stripCommonPrefix({ "app/index.html": encode("a"), "apple.js": encode("b") });
    expect(Object.keys(files).sort()).toEqual(["app/index.html", "apple.js"]);
  });

  test("ignores what the operating system leaves behind", () => {
    // Sealing .DS_Store into somebody's application would be absurd, and it
    // would show up in the manifest for anyone who looked.
    for (const junk of [
      ".DS_Store",
      "app/.DS_Store",
      "__MACOSX/._index.html",
      "node_modules/react/index.js",
      ".git/config",
      "Thumbs.db",
    ]) {
      expect(isNoise(junk), junk + " should be ignored").toBe(true);
    }

    for (const real of ["index.html", "app.js", "style/app.css", "img/logo.svg"]) {
      expect(isNoise(real), real + " should be kept").toBe(false);
    }
  });

  test("survives an empty archive without throwing", () => {
    expect(Object.keys(unpackZip(zipSync({})))).toEqual([]);
  });
});

