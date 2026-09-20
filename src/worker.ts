/**
 * The names the page and its service worker call each other by (D72).
 *
 * A fourth `dai:` namespace, and the last one with no owner: the frame's names
 * live in `src/frame.ts`, the bridge's in `src/bridge.ts`, a link's fields in
 * `src/fragment.ts`, and these were spelled by hand in two files that cannot
 * both be changed by one edit — `apps/runner/src/main.ts`, which imports, and
 * `apps/runner/public/sw.js`, which cannot.
 *
 * **The worker cannot import this file.** It is registered as a classic
 * worker (`navigator.serviceWorker.register("./sw.js")`, no `type: "module"`)
 * and pulls its one dependency with `importScripts`. Bundling it to let it
 * import would put a build step between a person and the file they can read,
 * which is the opposite of what the worker is for. So the worker keeps its
 * literals, and `worker-names.spec` holds them to this file, exactly as
 * `kit-names.spec` holds the kit's one literal: the check is outside the
 * thing it checks, and it names what it allows.
 *
 * These are messages between two halves of this opener, not format. A rename
 * costs a deploy where page and worker disagree for one launch — the worker
 * updates on its own schedule (see `sw.js`) — so a new name is added rather
 * than an old one respelled.
 */
export const WORKER = {
  /** The page asks its worker which build it is, for the arrival line (D49/D69). */
  BUILD: "dai:worker-build",
  /** The worker tells an open page that a newer shell is cached. */
  SHELL_UPDATED: "dai:shell-updated",
  /** The worker asks the page which document it is showing, before it notifies. */
  WHICH_DOCUMENT: "dai:which-document",
  /** The worker tells the page a mailbox it watches has moved. */
  MAILBOX_MOVED: "dai:mailbox-moved",
} as const;

export type WorkerNames = typeof WORKER;
