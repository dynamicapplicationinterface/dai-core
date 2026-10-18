/**
 * The changeset log's declaration (R-O; src/changesets.ts), apart from the
 * module that writes it, so the compiler can declare it without the runtime's
 * bundle taking the capture and projection code with it.
 */

/** The log table: one row per save, its payload the save's changeset. */
export const CHANGES_LOG = "_cs_log";

/** What the compiler appends to the schema of a document with no session policy. */
export const CHANGES_DECLARATION = `\n-- dai:replicated\nCREATE TABLE IF NOT EXISTS ${CHANGES_LOG} (payload BLOB NOT NULL);\n`;
