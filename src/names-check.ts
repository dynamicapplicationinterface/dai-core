/**
 * The consistency check for a set of message names (D68, D69, D70).
 *
 * `src/bridge.ts` and `src/frame.ts` each own a set of names. Both are checked
 * the same way: every value is what its key says it is, and no value appears
 * twice. The check used to run inside `src/bridge.ts` as the module loaded,
 * which put it into every document's runtime, where the strings are fixed by
 * the time the bundle exists and it could never fire (D70). So it lives here,
 * in a module the runtime does not import, and runs where the names can still
 * change: at build (`scripts/check-names.mjs`, in the typecheck chain) and in
 * tests (`tests/names-check.spec.ts`).
 */

/**
 * Everything wrong with a set of names, in words; empty when it is sound.
 *
 * @param sets     the owner's groups of names, by group name
 * @param expected what the value for a key must be
 * @param exceptions `group.KEY` → the reason it may differ from `expected`.
 *   Each must name a key that exists and differs, so an exception cannot
 *   outlive the thing it excused.
 */
export function nameProblems(
  sets: Readonly<Record<string, Readonly<Record<string, string>>>>,
  expected: (key: string) => string,
  exceptions: Readonly<Record<string, string>> = {},
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const used = new Set<string>();
  for (const [group, names] of Object.entries(sets)) {
    for (const [key, value] of Object.entries(names)) {
      const where = `${group}.${key}`;
      const want = expected(key);
      if (value !== want) {
        if (where in exceptions) used.add(where);
        else problems.push(`${where} is "${value}", not "${want}"`);
      }
      const earlier = seen.get(value);
      if (earlier) problems.push(`"${value}" is both ${earlier} and ${where}`);
      else seen.set(value, where);
    }
  }
  for (const where of Object.keys(exceptions)) {
    if (!used.has(where)) problems.push(`the exception for ${where} excuses nothing: it is missing or already follows the rule`);
  }
  return problems;
}

/** A bridge name's value: `DAI_HOST_` and its key. */
export const bridgeValue = (key: string): string => `DAI_HOST_${key}`;

/** A frame name's value: `dai:` and its key in lower case, words joined by hyphens. */
export const frameValue = (key: string): string => `dai:${key.toLowerCase().replace(/_/g, "-")}`;
