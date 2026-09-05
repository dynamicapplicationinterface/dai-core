/**
 * The UTS #39 confusable table this opener compares names with (spec §9.6).
 *
 * Content-hashed, so the name says which table it is and every host that
 * loads `confusables.<id>.json` computes the same skeletons from the same
 * bytes. Fetched once, in parallel with whatever else a document needs and
 * never on the first-paint path; precached by the worker like the engine, so
 * a name is compared offline as it is online.
 *
 * A host that cannot load its table still opens documents: the mixed-script
 * rule needs no table, and the skeleton rule falls back to comparing folded
 * names — weaker, and said so in the state it produces, never silently.
 */
import { CONFUSABLES_FILE } from "../../../src/confusables-id.js";
import type { ConfusableTable } from "../../../src/publisher.js";

let loading: Promise<ConfusableTable> | undefined;

/** The empty table: skeletons are then folded names, and nothing more. */
export const NO_TABLE: ConfusableTable = { unicode: "none", map: {} };

export function confusables(): Promise<ConfusableTable> {
  loading ??= fetch(new URL(CONFUSABLES_FILE, document.baseURI))
    .then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const table = (await response.json()) as ConfusableTable;
      if (typeof table?.unicode !== "string" || typeof table?.map !== "object") throw new Error("shape");
      return table;
    })
    .catch(() => NO_TABLE);
  return loading;
}
