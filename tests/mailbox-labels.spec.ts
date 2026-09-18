import { expect, test } from "@playwright/test";
import { deriveSessionMailbox } from "../src/mailbox.js";

/**
 * A session's mailbox key and address, derived as they always have been (D74).
 *
 * `src/mailbox.ts` derives both from the document key and the session id with
 * HKDF under two labels, `dai:mailbox:key:` and `dai:mailbox:id:`. Every game in
 * progress reads and writes its moves at that address, under that key. Change
 * a label and everything in this repository still agrees with itself (both
 * sides derive the same new values), while every game already in progress stops
 * receiving moves, silently: a different address, a different key, nothing
 * there.
 *
 * So these are known answers, written out in full like conformance/vectors.json:
 * a fixed root key and session id, and the key and address they must produce.
 * They were checked when written against an HKDF computed independently with
 * the two labels typed out, so they are the labels' answers, not merely today's
 * code's. The labels are private to the module; the derivation is what a game
 * depends on, so that is what is pinned.
 */
const ROOT = new Uint8Array(32).map((_, i) => i + 1);
const SESSION = new Uint8Array(16).map((_, i) => 0xa0 + i);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("a session's mailbox key and address are the ones every game in progress was made with", async () => {
  const { key, id } = await deriveSessionMailbox(ROOT, SESSION);
  expect(hex(key)).toBe("54be8a1e76676cfc959c90303860cc61fe114b60d35e09e83153dea9830ee060");
  expect(id).toBe("e0a0def69189a41b2d08bb7482c5979e1ed1c8b6f3bf2af475404ca6db248097");
});
