/**
 * Script elements, found the way a browser's HTML tokenizer finds them.
 *
 * The runtime stamps its nonce on an application's own inline scripts, and
 * the lint refuses a script that loads from the network. Both used to find a
 * script with a pattern that wanted whitespace before an attribute, and HTML
 * also accepts a slash there: `<script/src="//h/x.js">` and
 * `<script/type="speculationrules">` read as plain inline scripts, were
 * stamped, and ran (3-H1). So both read the tags here instead, by the
 * tokenizer's own rules for start tags, attributes, comments and script data.
 *
 * What it does not model is fail-safe for the stamp. It does not track
 * RAWTEXT and RCDATA elements (a `<textarea>`, a `<style>`) or foreign
 * content, so it can take text for a tag, and a stamp on text is text; or it
 * can miss a tag the browser sees, and a script left unstamped does not run.
 * What it cannot do is read a tag the browser reads differently: a start tag,
 * once found, is read exactly as the tokenizer reads it.
 */

export interface ScriptTag {
  /** Where the `<` of the start tag is. */
  start: number;
  /** Just past the start tag's `>`. */
  end: number;
  /** By lowercased name, the first of a repeated name kept, as the parser keeps it; values as written. */
  attributes: Map<string, string>;
}

export interface ScriptTagTools {
  /** Every script start tag in `html`, in order. */
  scriptTags: (html: string) => ScriptTag[];
  /** A script whose code comes from elsewhere: `src`, or an SVG script's `href`. */
  loadsCode: (tag: ScriptTag) => boolean;
  /** Inline code the runtime may stamp. */
  stampable: (tag: ScriptTag) => boolean;
  /** `html` with ` nonce="…"` on every script `stampable` admits. */
  stampScripts: (html: string, nonce: string) => string;
  /** An attribute value with its numeric character references, and the few named ones a URL or a type needs, decoded. */
  decodeValue: (value: string) => string;
}

/**
 * The tools, made by one self-contained function.
 *
 * Self-contained because the frame's loader is serialized with `toString()`
 * and cannot reference an import (src/runtime/bootloader.ts, `frameLoader`):
 * the runtime passes this function's source into the frame, and the lint
 * imports its result below. Nothing in the body may reach outside it but the
 * language's own globals. Its source is placed inside a script element, so it
 * never spells the end of one, nor the start of a comment.
 */
export function scriptTagTools(): ScriptTagTools {
  const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
  const isAlpha = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);

  /*
   * A tag's attributes, read from just after its name up to and including its
   * `>`, or null when the input ends inside the tag (the tokenizer drops it).
   * A slash between attributes is read as whitespace: the self-closing state
   * hands anything but `>` back to the attribute-name state.
   */
  function readAttributes(s: string, from: number): { end: number; attributes: Map<string, string> } | null {
    const attributes = new Map<string, string>();
    let i = from;
    for (;;) {
      while (i < s.length && (isSpace(s[i]) || s[i] === "/")) i++;
      if (i >= s.length) return null;
      if (s[i] === ">") return { end: i + 1, attributes };
      // An attribute name runs to whitespace, a slash, `>` or `=`; its first
      // character is part of it whatever it is, `=` included.
      let name = s.charAt(i++);
      while (i < s.length && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") name += s.charAt(i++);
      while (i < s.length && isSpace(s[i])) i++;
      let value = "";
      if (s[i] === "=") {
        i++;
        while (i < s.length && isSpace(s[i])) i++;
        if (i >= s.length) return null;
        const quote = s[i];
        if (quote === '"' || quote === "'") {
          const close = s.indexOf(quote, i + 1);
          if (close < 0) return null;
          value = s.slice(i + 1, close);
          i = close + 1;
        } else if (quote !== ">") {
          // Unquoted: to whitespace or `>`. A slash is part of the value.
          const start = i;
          while (i < s.length && !isSpace(s[i]) && s[i] !== ">") i++;
          value = s.slice(start, i);
        }
      }
      const key = name.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, value);
    }
  }

  /* Where a comment whose `<` is at `i` ends, by the tokenizer's comment states. */
  function commentEnd(s: string, i: number): number {
    const body = i + 4;
    if (s[body] === ">") return body + 1;
    if (s.startsWith("->", body)) return body + 2;
    const ends = [s.indexOf("-->", body), s.indexOf("--!>", body)].filter((at) => at >= 0);
    if (ends.length === 0) return s.length;
    const at = Math.min(...ends);
    return at + (s.startsWith("-->", at) ? 3 : 4);
  }

  /* Past a bogus comment (`<!x`, `<?x`, `</ x`): to the next `>`. */
  function bogusEnd(s: string, i: number): number {
    const close = s.indexOf(">", i);
    return close < 0 ? s.length : close + 1;
  }

  /* Where script data from `i` ends: at an end tag named script, followed by whitespace, a slash or `>`. */
  function scriptDataEnd(s: string, i: number): number {
    const lower = s.toLowerCase();
    const close = "<" + "/" + "script";
    for (let at = lower.indexOf(close, i); at >= 0; at = lower.indexOf(close, at + 1)) {
      const next = s[at + close.length];
      if (next === undefined || isSpace(next) || next === "/" || next === ">") return at;
    }
    return s.length;
  }

  /* After a tag name that starts at `from`: where the name ends. */
  function nameEnd(s: string, from: number): number {
    let at = from;
    while (at < s.length && !isSpace(s[at]) && s[at] !== "/" && s[at] !== ">") at++;
    return at;
  }

  function scriptTags(html: string): ScriptTag[] {
    const tags: ScriptTag[] = [];
    let i = 0;
    while (i < html.length) {
      const open = html.indexOf("<", i);
      if (open < 0) break;
      const next = html[open + 1];
      if (next === "!") {
        i = html.startsWith("!--", open + 1) ? commentEnd(html, open) : bogusEnd(html, open);
      } else if (next === "?") {
        i = bogusEnd(html, open);
      } else if (next === "/") {
        if (isAlpha(html[open + 2])) {
          const read = readAttributes(html, nameEnd(html, open + 2));
          if (!read) break;
          i = read.end;
        } else if (html[open + 2] === ">") i = open + 3;
        else i = bogusEnd(html, open);
      } else if (isAlpha(next)) {
        const at = nameEnd(html, open + 1);
        const read = readAttributes(html, at);
        if (!read) break;
        i = read.end;
        if (html.slice(open + 1, at).toLowerCase() === "script") {
          tags.push({ start: open, end: read.end, attributes: read.attributes });
          i = scriptDataEnd(html, read.end);
        }
      } else {
        i = open + 1;
      }
    }
    return tags;
  }

  function loadsCode(tag: ScriptTag): boolean {
    return tag.attributes.has("src") || tag.attributes.has("href") || tag.attributes.has("xlink:href");
  }

  // The JavaScript MIME types (HTML, "JavaScript MIME type").
  const JAVASCRIPT = [
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
  ];

  /*
   * No `src` or `href`, no nonce of its own, and a type that is absent, empty,
   * a JavaScript type, `module` or `importmap`. Anything else is left as
   * written: a speculation rules script in any spelling, a character
   * reference included, is none of these, and a data block needs no nonce.
   */
  function stampable(tag: ScriptTag): boolean {
    if (loadsCode(tag) || tag.attributes.has("nonce")) return false;
    const type = tag.attributes.get("type");
    if (type === undefined) return true;
    const essence = (type.split(";")[0] ?? "").trim().toLowerCase();
    return essence === "" || essence === "module" || essence === "importmap" || JAVASCRIPT.indexOf(essence) >= 0;
  }

  function stampScripts(html: string, nonce: string): string {
    let out = "";
    let from = 0;
    for (const tag of scriptTags(html)) {
      if (!stampable(tag)) continue;
      out += html.slice(from, tag.end - 1) + ' nonce="' + nonce + '">';
      from = tag.end;
    }
    return out + html.slice(from);
  }

  const NAMED: Record<string, string> = { amp: "&", colon: ":", sol: "/", period: ".", quot: '"', apos: "'", lt: "<", gt: ">", Tab: "\t", NewLine: "\n" };
  function decodeValue(value: string): string {
    return value.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));?/g, (whole: string, hex?: string, dec?: string, name?: string) => {
      if (hex) return String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
      if (dec) return String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff));
      return (name && Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : undefined) ?? whole;
    });
  }

  return { scriptTags, loadsCode, stampable, stampScripts, decodeValue };
}

export const { scriptTags, loadsCode, stampable, stampScripts, decodeValue } = scriptTagTools();
