import { expect, test } from "@playwright/test";
import { canHandOff, handOff, type ShareCapableNavigator } from "../src/handoff.js";

/**
 * How a built file gets from a page onto the device it is being read on.
 *
 * On iOS an anchor with a `download` attribute pointing at a blob URL does
 * nothing at all — no save, no error, no navigation — so the site offered a
 * button that appeared to work and handed over nothing. Nobody could get a file
 * onto a phone, which also meant nobody could put one into the runner, and the
 * runner is the whole of the mobile story.
 *
 * These check the decision, not the platform. iOS cannot be reproduced here and
 * a test claiming to would be worse than none: what is checked is that the
 * share route is offered exactly when the device says it can take the file, and
 * that somebody dismissing the sheet is not reported as a failure.
 */
const file = () => new File(["<!doctype html>"], "my-tasks.dai.html", { type: "text/html" });

test.describe("deciding whether to offer the share sheet", () => {
  test("offers it when the device says it can take the file", () => {
    const nav: ShareCapableNavigator = { share: async () => {}, canShare: () => true };
    expect(canHandOff(nav, file())).toBe(true);
  });

  test("declines when the device shares but not files", () => {
    // Desktop browsers with a share sheet and no file support land here.
    // Offering them a button that throws trades one dead end for another.
    expect(canHandOff({ share: async () => {}, canShare: () => false }, file())).toBe(false);
  });

  test("declines when there is no share support at all", () => {
    expect(canHandOff({}, file())).toBe(false);
  });

  test("declines when nothing has been built yet", () => {
    expect(canHandOff({ share: async () => {}, canShare: () => true }, null)).toBe(false);
  });
});

test.describe("handing the file over", () => {
  test("passes the file and the name to the sheet", async () => {
    const calls: { files?: File[]; title?: string; text?: string }[] = [];
    const subject = file();

    const result = await handOff(
      {
        canShare: () => true,
        share: async (data) => {
          calls.push(data);
        },
      },
      subject,
      "my-tasks.dai.html",
    );

    expect(result).toEqual({ shared: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.files?.[0]).toBe(subject);
    expect(calls[0]!.title).toBe("my-tasks.dai.html");
  });

  test("says nothing when the person dismisses the sheet", async () => {
    // The sheet raises the same exception whether it failed or was dismissed.
    const result = await handOff(
      {
        share: async () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          throw error;
        },
      },
      file(),
      "x",
    );

    expect(result).toEqual({ shared: false });
  });

  test("points at the download link when the sheet actually fails", async () => {
    const result = await handOff(
      {
        share: async () => {
          throw new Error("not allowed");
        },
      },
      file(),
      "x",
    );

    expect(result.shared).toBe(false);
    expect(result.error).toContain("download link");
  });

  test("never claims a file was delivered by a device that cannot", async () => {
    // Reporting success here is the failure this whole change is about: a
    // person told their file was saved, with no file anywhere.
    const result = await handOff({}, file(), "x");
    expect(result.shared).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("carries a sentence for somebody whose computer cannot name the file", async () => {
    /*
     * A recipient with nothing installed gets an attachment their system offers
     * no way to open and no way to identify. The message it arrives in is the
     * only place an answer fits, so the sentence travels with the file.
     */
    const calls: { text?: string }[] = [];
    const result = await handOff(
      { canShare: () => true, share: async (data) => void calls.push(data) },
      file(),
      "my-tasks.dai.html",
      "A DAI document. Open it at example.test/open",
    );

    expect(result.shared).toBe(true);
    expect(calls[0]!.text).toContain("example.test/open");
  });

  test("sends no text field at all when there is nothing to say", async () => {
    // An empty string in a share sheet is a blank line in somebody's message.
    const calls: Record<string, unknown>[] = [];
    await handOff(
      { canShare: () => true, share: async (data) => void calls.push(data) },
      file(),
      "x",
    );

    expect("text" in calls[0]!).toBe(false);
  });
});
