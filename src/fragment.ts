/**
 * Every field a link's fragment can carry, defined in one place (D56).
 *
 * A fragment is one namespace, and it had three definers in two files — the
 * inline carrier's `a` in `link.ts`, the store reference's `h k u c s` in
 * `store.ts`, and the icon's hint in `link.ts` — with nothing that saw all
 * three. The hint was given `u`, which the store reference already used for
 * its URL: an icon's address kept the hint and lost the store, and every icon
 * made from a link could not fetch its document on a device that no longer
 * held it, which is the one case the icon exists for. No single file could see
 * the collision, so no single file's tests could catch it.
 *
 * So the namespace is written here, whole, and checked where it is written:
 * this module refuses to load if two fields claim one key. The owners keep
 * their own names for their fields (`INLINE_KEY`, `REFERENCE_KEYS`,
 * `HINT_KEY`), derived from this, so no caller changes.
 *
 * One copy lives outside it: the service worker (`apps/runner/public/sw.js`)
 * is plain script and cannot import, and it writes the hint into a
 * notification's address. `tests/push-e2e.spec.ts` holds that copy to
 * `HINT_KEY` by reading the notification the worker actually shows.
 */
export const FRAGMENT_KEYS = {
  /** A document carried in the link itself (`src/link.ts`). */
  inline: { payload: "a" },
  /** A document kept in a store, named by its hash (`src/store.ts`). */
  reference: { hash: "h", key: "k", url: "u", clear: "c", session: "s" },
  /**
   * The opener's own: which document an address is probably for, written into
   * an icon's `start_url` and a notification's address, never into a link a
   * person shares. Spelled out rather than a letter, because a letter is what
   * every link field is, and this is not one.
   */
  opener: { hint: "opener-doc" },
} as const;

/**
 * Every key claimed by more than one field, with the fields that claim it.
 *
 * Empty for a namespace where each key has one owner. Exported so the check
 * can be shown to fire on a set that collides, not only to stay quiet on this
 * one: a guard only seen silent has not been seen to guard.
 */
export function fragmentCollisions(
  owners: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string[] {
  const claimed = new Map<string, string[]>();
  for (const [owner, fields] of Object.entries(owners)) {
    for (const [field, key] of Object.entries(fields)) {
      claimed.set(key, [...(claimed.get(key) ?? []), `${owner}.${field}`]);
    }
  }
  return [...claimed]
    .filter(([, fields]) => fields.length > 1)
    .map(([key, fields]) => `"${key}" is claimed by ${fields.join(" and ")}`);
}

// At the point of definition: a collision is not a warning for later.
const collisions = fragmentCollisions(FRAGMENT_KEYS);
if (collisions.length > 0) {
  throw new Error(`fragment keys collide: ${collisions.join("; ")}`);
}
