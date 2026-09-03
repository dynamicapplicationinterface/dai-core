#!/usr/bin/env node
/**
 * The executable. Nothing but the entry point.
 *
 * Separate from cli.ts so that importing the command line's internals — as the
 * tests do, to exercise argument parsing — cannot run it. The previous version
 * guessed from `process.argv[1]` whether it was being executed, and guessed
 * wrong inside a test runner whose own entry point is also called cli.js.
 */
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error)}
`);
    process.exit(1);
  },
);
