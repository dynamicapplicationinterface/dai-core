import { expect, test } from "@playwright/test";
import { appNameFrom } from "../src/browser.js";

/**
 * The app is called what it is called.
 *
 * A person builds a watch list on the site by dropping the folder their
 * assistant gave them, and the app is called "road-to-doomsday-dai" — on the
 * open screen, on the home screen, and in the message they send somebody.
 * `.dai` names the format the file is written in. It is not part of what the
 * thing is called, and it was ending up there because the name was taken off
 * the file name as it stood.
 */
test.describe("naming an app from the file it arrived in", () => {
  test("drops the suffix, however it was worn", () => {
    expect(appNameFrom("road-to-doomsday.dai.html")).toBe("Road to doomsday");
    expect(appNameFrom("road-to-doomsday-dai")).toBe("Road to doomsday");
    expect(appNameFrom("road-to-doomsday.dai")).toBe("Road to doomsday");
    expect(appNameFrom("road_to_doomsday_dai")).toBe("Road to doomsday");
    expect(appNameFrom("packing list.zip")).toBe("Packing list");
    expect(appNameFrom("chores.html")).toBe("Chores");
  });

  test("leaves a name that is not wearing one alone", () => {
    // Only a trailing suffix is the format's. A word that happens to contain
    // those letters is somebody's app name.
    expect(appNameFrom("daily-notes")).toBe("Daily notes");
    expect(appNameFrom("dairy")).toBe("Dairy");
    expect(appNameFrom("dai-tools-for-work")).toBe("Dai tools for work");
  });

  test("takes the last part of a path, and gives nothing back when there is nothing", () => {
    expect(appNameFrom("some/where/beach-trip.dai.html")).toBe("Beach trip");
    // The caller keeps whatever it had rather than showing an empty field.
    expect(appNameFrom(".dai.html")).toBe("");
    expect(appNameFrom("dai")).toBe("");
  });
});
