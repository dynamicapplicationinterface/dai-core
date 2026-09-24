/**
 * The message and event names between a document's runtime and the application
 * frame it hosts, defined in one place (D69).
 *
 * Two groups, because they change under different rules.
 *
 * The opener mounts every document in its own current shell (`hostShell` in
 * `apps/runner/src/main.ts`), so the code a document carries (the kit, and the
 * author's own application) always runs against today's runtime, whatever
 * built it. A name that code sends or hears crosses versions and can never
 * change: that is `FRAME_PUBLIC`, held by `tests/frame-wire.spec.ts`.
 *
 * Everything else runs between the shell and the runtime's own frame code
 * (`bridgeMain`, `frameLoader`, `handshakeScript` in `src/runtime/bootloader.ts`).
 * Both ends ship in the same runtime bundle and are always the same version, so
 * those names can be renamed together: that is `FRAME_INTERNAL`.
 *
 * The frame code is serialised into the frame as text (`Function.toString()`),
 * where nothing imported exists, so it receives these names as an argument
 * rather than importing them. The kit is text too, and interpolates them when a
 * document is built. Authors cannot import from here at all: `src/rules.ts`
 * tells them the public names, and its anchors point at this file.
 *
 * The consistency check (each value is `dai:` and its key in kebab case, and no
 * value twice) runs at build and in tests, not here (`src/names-check.ts`).
 */

/** Names the code a document carries sends or hears. Frozen: never renamed. */
export const FRAME_PUBLIC = {
  /**
   * The event an application listens for on `window` when another copy's rows
   * have arrived. Authors are told to listen for it (`src/rules.ts`).
   */
  MERGED: "dai:merged",
  /** Posted by the kit when a person first uses a control. */
  USED: "dai:used",
  /**
   * Fired on `window` when this device is a new author for a document it wrote
   * before: its key was lost and made again (docs/identity.md, "Loss"). The kit
   * says the loss sentence on it; `window.dai.newPlayer` holds it for a kit
   * that loads after.
   */
  NEW_PLAYER: "dai:new-player",
} as const;

/** Names between the shell and the runtime's own frame code. Renamable together. */
export const FRAME_INTERNAL = {
  APPLIED: "dai:applied",
  APPLY_BATCH: "dai:apply-batch",
  APPMODE: "dai:appmode",
  AUTHORED: "dai:authored",
  AUTHORED_BATCH: "dai:authored-batch",
  AUTHORED_SINCE: "dai:authored-since",
  /** Posted from the frame on an uncaught error. Nothing acts on it today (`src/rules.ts`). */
  ERROR: "dai:error",
  FLUSH: "dai:flush",
  FLUSHED: "dai:flushed",
  FRAME_HELLO: "dai:frame-hello",
  GROUND: "dai:ground",
  /** The shell's answer: the insets the frame asked for. */
  INSETS: "dai:insets",
  /** The frame's question. Was `dai:insets?` until D69; the `?` fit no rule. */
  INSETS_ASK: "dai:insets-ask",
  MERGE: "dai:merge",
  /**
   * The frame's answer to a merge. Was `dai:merged`, the same name as the
   * event authors listen for (FRAME_PUBLIC.MERGED): one name with two meanings,
   * renamed here because this one is internal (D69).
   */
  MERGE_RESULT: "dai:merge-result",
  PAYLOAD: "dai:payload",
  /** Posted by the frame once its document has mounted; the shell latches the first. */
  READY: "dai:ready",
  REPLICA_ID: "dai:replica-id",
  REPLICA_ID_ANSWER: "dai:replica-id-answer",
  REQUEST_SHARE: "dai:request-share",
  SAVE: "dai:save",
  SAVE_STATE: "dai:save-state",
  SCHEMA: "dai:schema",
  SCHEMA_VERDICT: "dai:schema-verdict",
  SESSIONS: "dai:sessions",
  /** The frame asking the host to sign a batch header (docs/identity.md, step 3). */
  SIGN: "dai:sign",
  /** The host's signature, relayed back, or why it would not sign. */
  SIGNED: "dai:signed",
  SESSIONS_ANSWER: "dai:sessions-answer",
  TIMING: "dai:timing",
  WAITING: "dai:waiting",
  WRITE_RULES: "dai:write-rules",
  WRITE_RULES_REFUSED: "dai:write-rules-refused",
} as const;

/** Every frame name, as the frame code receives them. */
export const FRAME = { ...FRAME_PUBLIC, ...FRAME_INTERNAL } as const;
export type FrameNames = typeof FRAME;
