/**
 * The command line front end.
 *
 * Deliberately thin. Everything it knows how to do is `compileDirectory` and
 * `auditContainer`; the value it adds is argument parsing and messages a person
 * can act on. Anything cleverer than that belongs a layer down, where the other
 * wrappers can reach it too.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileDirectory, CompileError, formatBytes, sanitizeFileName } from "./compile.js";
import { auditContainer, parseContainer } from "./container.js";
import { readFileSync } from "node:fs";

const USAGE = `dai — build and inspect DAI containers

Usage:
  dai build <directory> [options]     Package a directory into one file
  dai verify <file>                   Check a container and report what it finds

Build options:
  -o, --out <path>        Where to write the container
                          (default: <name>.dai.html beside the source)
  -n, --name <name>       Application name, shown as the window title
  -k, --key <path|pem>    Sign with this ECDSA P-256 private key
      --seed <path>       Start from this SQLite database
      --uuid <uuid>       Reuse a document identity instead of minting one
      --valid-until <s>   Unix seconds after which hosts should refuse it
      --no-verify         Build a container that does not demand verification
      --quiet             Print only the output path

Examples:
  dai build ./dist
  dai build ./dist -o tasks.dai.html -n "My Tasks" -k signing-key.pem
  dai verify tasks.dai.html
`;

interface Parsed {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Long and short flags, `--flag=value` and `--flag value`, and negation via
 * `--no-x`. Hand-rolled rather than pulled in, because a build tool whose whole
 * claim is self-containment should not acquire dependencies to read `argv`.
 */
export function parseArgs(argv: string[]): Parsed {
  const aliases: Record<string, string> = { o: "out", n: "name", k: "key", h: "help" };
  const valued = new Set(["out", "name", "key", "seed", "uuid", "valid-until", "template"]);

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }

    const bare = token.replace(/^--?/, "");
    const [rawName, inlineValue] = bare.includes("=")
      ? [bare.slice(0, bare.indexOf("=")), bare.slice(bare.indexOf("=") + 1)]
      : [bare, undefined];

    const name = aliases[rawName] ?? rawName;

    if (name.startsWith("no-")) {
      flags[name.slice(3)] = false;
      continue;
    }

    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    if (valued.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new CompileError(`--${name} needs a value.`);
      }
      flags[name] = next;
      i++;
      continue;
    }

    flags[name] = true;
  }

  return { command: positional[0], positional: positional.slice(1), flags };
}

async function build(parsed: Parsed): Promise<number> {
  const source = parsed.positional[0];
  if (!source) {
    process.stderr.write("dai build needs a directory. Try: dai build ./dist\n");
    return 2;
  }

  const flags = parsed.flags;
  const quiet = flags.quiet === true;

  const validUntil =
    typeof flags["valid-until"] === "string" ? Number(flags["valid-until"]) : undefined;
  if (validUntil !== undefined && !Number.isFinite(validUntil)) {
    throw new CompileError(`--valid-until must be a number of Unix seconds.`);
  }

  const result = await compileDirectory({
    sourceDir: source,
    appName: typeof flags.name === "string" ? flags.name : undefined,
    signingKey: typeof flags.key === "string" ? flags.key : undefined,
    sqlitePath: typeof flags.seed === "string" ? flags.seed : undefined,
    templatePath: typeof flags.template === "string" ? flags.template : undefined,
    documentUuid: typeof flags.uuid === "string" ? flags.uuid : undefined,
    validUntil,
    verifyIntegrity: flags.verify === false ? false : undefined,
  });

  const out =
    typeof flags.out === "string"
      ? resolve(process.cwd(), flags.out)
      : resolve(process.cwd(), `${sanitizeFileName(result.manifest.appName)}.dai.html`);

  writeFileSync(out, result.html, "utf8");

  if (quiet) {
    process.stdout.write(`${out}\n`);
    return 0;
  }

  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  process.stdout.write(
    `${out}\n` +
      `  ${result.entryCount} entries, ${result.engine}\n` +
      `  document ${result.documentUuid}\n` +
      `  ${
        result.publicKeyFingerprint
          ? `signed ${result.publicKeyFingerprint}`
          : "unsigned — anyone can modify this and rebuild the digests"
      }\n` +
      `  ${formatBytes(Buffer.byteLength(result.html))}\n`,
  );

  return 0;
}

async function verify(parsed: Parsed): Promise<number> {
  const target = parsed.positional[0];
  if (!target) {
    process.stderr.write("dai verify needs a file. Try: dai verify tasks.dai.html\n");
    return 2;
  }

  const path = resolve(process.cwd(), target);
  const report = await auditContainer(parseContainer(readFileSync(path, "utf8")));

  if (report.unavailable) {
    process.stderr.write(`${report.unavailable}\n`);
    return 1;
  }

  const failed = report.entries.filter((entry) => entry.status !== "ok");

  process.stdout.write(
    `${path}\n` +
      `  ${report.ok ? "intact" : "FAILED"}\n` +
      `  document ${report.documentUuid}\n` +
      `  ${report.entries.length} entries, ${failed.length} not matching\n` +
      `  shell ${report.shell.status}\n` +
      `  signature ${report.signature.status}` +
      `${report.signature.fingerprint ? ` (${report.signature.fingerprint})` : ""}\n` +
      `  expiry ${report.expiry.status}\n`,
  );

  for (const entry of failed) {
    process.stdout.write(`  ${entry.status}: ${entry.name}\n`);
  }

  // The exit code is the point: this is what a build pipeline branches on.
  return report.ok ? 0 : 1;
}

export async function run(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  if (parsed.flags.help || !parsed.command) {
    process.stdout.write(USAGE);
    return parsed.command ? 0 : 2;
  }

  try {
    switch (parsed.command) {
      case "build":
        return await build(parsed);
      case "verify":
        return await verify(parsed);
      default:
        process.stderr.write(`Unknown command: ${parsed.command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    // A CompileError is something the caller can fix, so it is reported as a
    // sentence. Anything else is a bug here and keeps its stack.
    if (error instanceof CompileError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
