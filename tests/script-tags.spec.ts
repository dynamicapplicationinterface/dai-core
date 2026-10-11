import { expect, test } from "@playwright/test";
import { scriptTagTools, scriptTags, stampScripts } from "../src/script-tags.js";

/**
 * Script tags as the HTML tokenizer reads them (src/script-tags.ts, 3-H1).
 *
 * The runtime stamps its nonce on what this finds, so each case is one where a
 * pattern and the tokenizer disagree: the stamp must follow the tokenizer.
 */
const N = "abc123";
const stamped = (html: string): boolean => stampScripts(html, N).includes(`nonce="${N}"`);

test.describe("which scripts the runtime stamps", () => {
  test("an inline script, a module and an import map, in any case", () => {
    expect(stampScripts("<script>go()</script>", N)).toBe(`<script nonce="${N}">go()</script>`);
    expect(stamped('<SCRIPT TYPE="module">go()</SCRIPT>')).toBe(true);
    expect(stamped('<script type="importmap">{}</script>')).toBe(true);
    expect(stamped('<script type="text/javascript; charset=utf-8">go()</script>')).toBe(true);
    expect(stampScripts("<script type=module>go()</script>", N)).toBe(`<script type=module nonce="${N}">go()</script>`);
  });

  test("never one that loads code, whatever separates the attribute", () => {
    for (const html of [
      "<script/src=//h/x.js></script>",
      '<script/src="//h/x.js"></script>',
      '<script src="//h/x.js"></script>',
      '<script\nsrc="x.js"></script>',
      "<script type=module/src=x.js></script>",
      '<script/type="module"/src="./app.js"></script>',
      '<svg><script href="//h/x.js"></script></svg>',
      '<svg><script xlink:href="//h/x.js"></script></svg>',
    ]) {
      expect(stamped(html), html).toBe(false);
    }
  });

  test("never a speculation rules script, in any spelling", () => {
    for (const html of [
      '<script/type="speculationrules">{}</script>',
      '<script type="speculationrules">{}</script>',
      "<script type=SpeculationRules>{}</script>",
      '<script type=" speculationrules ">{}</script>',
      '<script type="speculation&#114;ules">{}</script>',
    ]) {
      expect(stamped(html), html).toBe(false);
    }
  });

  test("a repeated attribute is read once, the first, as the parser keeps it", () => {
    expect(stamped('<script type="module" type="speculationrules">go()</script>')).toBe(true);
    expect(stamped('<script type="speculationrules" type="module">{}</script>')).toBe(false);
  });

  test("a script that already has a nonce is left as written", () => {
    expect(stampScripts('<script nonce="other">go()</script>', N)).toBe('<script nonce="other">go()</script>');
  });

  test("text in a comment or in a script is not a tag", () => {
    expect(scriptTags("<!-- <script>x()</script> -->")).toEqual([]);
    expect(scriptTags("<!--><script>x()</script>")).toHaveLength(1);
    expect(scriptTags('<script>const s = "<script>";</script>')).toHaveLength(1);
    expect(scriptTags("<script>a</scriptx><script>b</script>")).toHaveLength(1);
    expect(scriptTags('<p title="<script>">x</p>')).toEqual([]);
  });

  test("a tag the input ends inside is no tag", () => {
    expect(scriptTags('<script src="x.js')).toEqual([]);
  });

  test("the tools run from their own source, as the frame runs them", () => {
    // The frame receives the function's text, not the module (frameLoader).
    const rebuilt = new Function(`return (${scriptTagTools.toString()})()`)() as ReturnType<typeof scriptTagTools>;
    expect(rebuilt.stampScripts("<script/src=//h/x.js></script><script>go()</script>", N)).toBe(
      `<script/src=//h/x.js></script><script nonce="${N}">go()</script>`,
    );
    expect(scriptTagTools.toString()).not.toMatch(/<\/script|<!--/i);
  });
});
