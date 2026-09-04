import { expect, test } from "@playwright/test";
import { BundleError, parseBundle, writeBundle } from "../src/bundle.js";

/**
 * The format a model emits and a person pastes.
 *
 * Its whole job is to be unambiguous about where one file ends and the next
 * begins, in a shape small enough to hold in one instruction. The tests are
 * mostly about the ways that goes wrong: a marker inside a file, a path that
 * climbs out of the application, and the fenced markdown a model writes when
 * nobody has told it the format.
 */
const canonical = [
  "dai bundle v1",
  "name: Reading list",
  "",
  "--- file: index.html",
  "<!doctype html>",
  '<script type="module" src="./app.js"></script>',
  "",
  "--- file: app.js",
  "const db = await window.dai.openDatabase();",
  "",
].join("\n");

test.describe("reading a bundle", () => {
  test("reads the canonical form", () => {
    const bundle = parseBundle(canonical);

    expect(bundle.name).toBe("Reading list");
    expect(Object.keys(bundle.files).sort()).toEqual(["app.js", "index.html"]);
    expect(bundle.files["app.js"]).toBe("const db = await window.dai.openDatabase();\n");
    expect(bundle.warnings).toEqual([]);
  });

  test("keeps blank lines inside a file", () => {
    // Source is not prose: a blank line between two functions is the author's,
    // and a reader that collapsed it would be editing the code it was given.
    const bundle = parseBundle(
      ["dai bundle v1", "", "--- file: app.js", "const a = 1;", "", "const b = 2;", ""].join("\n"),
    );
    expect(bundle.files["app.js"]).toBe("const a = 1;\n\nconst b = 2;\n");
  });

  test("carries a line that looks like a marker", () => {
    /*
     * A bundle documenting bundles. Without an escape the file ends halfway
     * through and the rest becomes a file named after a sentence.
     */
    const text = [
      "dai bundle v1",
      "",
      "--- file: README.md",
      "Each file starts with a line like this:",
      "\\--- file: index.html",
      "and runs until the next one.",
      "",
    ].join("\n");

    const bundle = parseBundle(text);
    expect(Object.keys(bundle.files)).toEqual(["README.md"]);
    expect(bundle.files["README.md"]).toContain("--- file: index.html");
  });

  test("round-trips through the writer", () => {
    const files = {
      "index.html": "<!doctype html>\n",
      "app.js": "const a = 1;\n\nconst b = 2;\n",
      "README.md": "A line that says:\n--- file: trap.js\nand continues.\n",
    };

    const bundle = parseBundle(writeBundle(files, { name: "Round trip" }));
    expect(bundle.files).toEqual(files);
    expect(bundle.name).toBe("Round trip");
    expect(bundle.warnings).toEqual([]);
  });

  test("puts the entry point first", () => {
    // A person opening a bundle wants to see where the application starts.
    const text = writeBundle({ "zebra.js": "1\n", "index.html": "<!doctype html>\n" });
    const first = text.split("\n").find((line) => line.startsWith("--- file:"));
    expect(first).toBe("--- file: index.html");
  });
});

test.describe("what it refuses", () => {
  test("a path that climbs out of the application", () => {
    // The oldest archive bug there is, arriving here from an untrusted model.
    expect(() =>
      parseBundle(["dai bundle v1", "", "--- file: ../escape.js", "1", ""].join("\n")),
    ).toThrow(/climbs out/);
  });

  test("an absolute path", () => {
    expect(() =>
      parseBundle(["dai bundle v1", "", "--- file: /etc/passwd", "x", ""].join("\n")),
    ).toThrow(/absolute/);
  });

  test("a bundle with no files at all", () => {
    expect(() => parseBundle("dai bundle v1\n\nhello, I am prose\n")).toThrow(BundleError);
  });
});

test.describe("what it tolerates, and mentions", () => {
  test("fenced markdown, which is what a model writes unprompted", () => {
    /*
     * Refusing this would throw away a usable completion over punctuation. It
     * is read and the author is told, which is the useful combination: an agent
     * correcting its own output needs to know which part was wrong.
     */
    const text = [
      "Here is the application you asked for.",
      "",
      "### index.html",
      "```html",
      "<!doctype html>",
      "```",
      "",
      "### app.js",
      "```js",
      "const db = await window.dai.openDatabase();",
      "```",
      "",
      "Let me know if you would like anything changed.",
    ].join("\n");

    const bundle = parseBundle(text);
    expect(Object.keys(bundle.files).sort()).toEqual(["app.js", "index.html"]);
    expect(bundle.files["index.html"]).toBe("<!doctype html>\n");
    expect(bundle.warnings.join(" ")).toMatch(/fenced code blocks/);
  });

  test("prose around the files, which is what a chat answer is", () => {
    const bundle = parseBundle(
      [
        "Sure! Here you go:",
        "",
        "dai bundle v1",
        "",
        "--- file: index.html",
        "<!doctype html>",
        "",
      ].join("\n"),
    );

    expect(Object.keys(bundle.files)).toEqual(["index.html"]);
    // The magic was not the first line, which is worth saying without refusing.
    expect(bundle.warnings.join(" ")).toMatch(/does not begin/);
  });

  test("says when there is no way in", () => {
    const bundle = parseBundle(["dai bundle v1", "", "--- file: app.js", "1", ""].join("\n"));
    expect(bundle.warnings.join(" ")).toMatch(/open blank/);
  });
});
