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
import {
  collectFiles,
  compileDirectory,
  CompileError,
  formatBytes,
  sanitizeFileName,
} from "./compile.js";
import { lintFiles, storesDataInFile } from "./lint.js";
import { parseBundle, writeBundle } from "./bundle.js";
import { auditContainer, parseContainer } from "./container.js";
import { existsSync, readFileSync, statSync } from "node:fs";

const USAGE = `dai — build and inspect DAI containers

Usage:
  dai build <directory> [options]     Package a directory into one file
  dai check <directory|bundle> [--json]
                                      Check source before building it
  dai bundle <directory>              Write the source as one pasteable file
  dai verify <file> [--json]          Check a container and report what it finds

Build options:
  -o, --out <path>        Where to write the container
                          (default: <name>.dai.html beside the source)
  -n, --name <name>       Application name, shown as the window title
  -k, --key <path|pem>    Sign with this ECDSA P-256 private key
      --seed <path>       Start from this SQLite database
      --upgrade-of <path> The container this build replaces. Compares the schema
                          being sealed against the one that container declared,
                          and refuses a build that moved it with no migration
      --uuid <uuid>       Reuse a document identity instead of minting one
      --valid-until <s>   Unix seconds after which hosts should refuse it
      --dai               Write the sectioned binary container instead of the
                          polyglot HTML. Passed by mail gateways that
                          quarantine .html, and saved without rewriting the
                          whole file.
      --thin              Leave the engine out, for a host that already holds
                          that exact copy. The manifest still covers it and the
                          signature is unchanged, so it is the same build — it
                          simply will not open where no host can supply one.
      --no-verify         Build a container that does not demand verification
      --quiet             Print only the output path

Check options:
      --json              Report the findings as JSON. Exit 0 when the source
                          will work inside a container, 1 when it will not

Bundle options:
  -o, --out <path>        Where to write it (default: stdout)

Verify options:
      --json              Report the whole audit as JSON, for a program rather
                          than a person. The exit code is unchanged: 0 intact,
                          1 refused

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
  const valued = new Set([
    "out",
    "name",
    "key",
    "seed",
    "uuid",
    "valid-until",
    "template",
    "upgrade-of",
  ]);

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
    upgradeOf: typeof flags["upgrade-of"] === "string" ? flags["upgrade-of"] : undefined,
    templatePath: typeof flags.template === "string" ? flags.template : undefined,
    documentUuid: typeof flags.uuid === "string" ? flags.uuid : undefined,
    validUntil,
    verifyIntegrity: flags.verify === false ? false : undefined,
    thin: flags.thin === true,
    sectioned: flags.dai === true,
  });

  const sectioned = flags.dai === true;
  const extension = sectioned ? ".dai" : ".dai.html";
  const out =
    typeof flags.out === "string"
      ? resolve(process.cwd(), flags.out)
      : resolve(process.cwd(), `${sanitizeFileName(result.manifest.appName)}${extension}`);

  if (sectioned) writeFileSync(out, result.dai as Uint8Array);
  else writeFileSync(out, result.html, "utf8");

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

/**
 * Checks source before it is sealed into anything.
 *
 * `verify` answers "is this container intact"; this answers the question that
 * comes before it — will this code work once it is inside one. They are
 * different failures with different audiences. A container is refused because
 * somebody changed it; source is refused because it does something a container
 * cannot do, which is not a fault so much as a fact somebody has not been told
 * yet.
 *
 * The rules are the ones the website's paste page shows and the MCP server
 * enforces, from `src/lint.ts`, because three sets of rules would be three
 * answers to one question.
 *
 * It exists for an agent as much as for a person. Something writing an
 * application unattended needs to find out that its `fetch` will never work
 * before it packages a container around it, and needs to be told in a form it
 * can act on rather than in prose.
 */
async function check(parsed: Parsed): Promise<number> {
  const target = parsed.positional[0];
  if (!target) {
    process.stderr.write("dai check needs a directory. Try: dai check ./app\n");
    return 2;
  }

  const root = resolve(process.cwd(), target);
  if (!existsSync(root)) {
    process.stderr.write(`No directory at ${root}.
`);
    return 2;
  }

  /*
   * A directory or a bundle, because both are things somebody has in hand.
   * The source arrives from a model as one pasteable file far more often than
   * as a directory, and asking somebody to unpack it before it can be checked
   * puts the unpacking before the checking.
   */
  const bundled = !statSync(root).isDirectory();
  const sources: Record<string, string> = {};
  const warnings: string[] = [];
  // Everything that would go into the container, not only what the lint
  // reads. "2 files" for a directory holding three was a count of the wrong
  // thing.
  let fileCount = 0;

  if (bundled) {
    const bundle = parseBundle(readFileSync(root, "utf8"));
    warnings.push(...bundle.warnings);
    for (const [name, body] of Object.entries(bundle.files)) sources[name] = body;
    fileCount = Object.keys(bundle.files).length;
  } else {
    const collected = await collectFiles(root);
    fileCount = collected.length;
    for (const file of collected) {
      if (!/\.(?:html?|m?js|ts|css)$/i.test(file.entry)) continue;
      sources[file.entry] = readFileSync(file.absolute, "utf8");
    }
  }

  const findings = lintFiles(sources);
  const entry = Object.keys(sources).some((name) => name === "index.html");
  const stores = Object.values(sources).some((source) => storesDataInFile(source));

  if (parsed.flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          source: root,
          ok: findings.length === 0 && entry,
          warnings,
          files: Object.keys(sources).sort(),
          hasEntryPoint: entry,
          // Not a failure. An application that keeps nothing is a legitimate
          // thing to build; it is worth reporting because "my data vanished"
          // is what somebody says afterwards when it was never being kept.
          storesDataInTheFile: stores,
          findings: findings.map((finding) => ({
            file: finding.file,
            id: finding.id,
            what: finding.what,
            why: finding.why,
            fix: finding.fix,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return findings.length === 0 && entry ? 0 : 1;
  }

  process.stdout.write(`${root}
  ${fileCount} files
`);

  for (const warning of warnings) process.stdout.write(`  ${warning}
`);

  if (!entry) {
    process.stdout.write("  no index.html — the container will open blank\n");
  }
  if (!stores) {
    process.stdout.write("  nothing stored through window.dai — data will not travel\n");
  }

  for (const finding of findings) {
    process.stdout.write(`
  ${finding.file}: ${finding.what}
    ${finding.why}
    ${finding.fix}
`);
  }

  if (findings.length === 0 && entry) process.stdout.write("  ready to build\n");

  return findings.length === 0 && entry ? 0 : 1;
}

/**
 * Writes a directory as one pasteable file.
 *
 * The direction people actually need is the other one — a model writes a
 * bundle and somebody builds it — but a format nothing emits is a format
 * nobody can check their reader against. This is also how the recipe's example
 * stays honest: it is generated from an application that runs.
 */
async function bundle(parsed: Parsed): Promise<number> {
  const target = parsed.positional[0];
  if (!target) {
    process.stderr.write("dai bundle needs a directory. Try: dai bundle ./app\n");
    return 2;
  }

  const root = resolve(process.cwd(), target);
  if (!existsSync(root)) {
    process.stderr.write(`No directory at ${root}.\n`);
    return 2;
  }

  const files: Record<string, string> = {};
  for (const file of await collectFiles(root)) {
    files[file.entry] = readFileSync(file.absolute, "utf8");
  }

  const text = writeBundle(files, {
    name: typeof parsed.flags.name === "string" ? parsed.flags.name : undefined,
  });

  if (typeof parsed.flags.out === "string") {
    writeFileSync(resolve(process.cwd(), parsed.flags.out), text, "utf8");
    process.stdout.write(`${resolve(process.cwd(), parsed.flags.out)}
`);
  } else {
    process.stdout.write(text);
  }

  return 0;
}

async function verify(parsed: Parsed): Promise<number> {
  const target = parsed.positional[0];
  if (!target) {
    process.stderr.write("dai verify needs a file. Try: dai verify tasks.dai.html\n");
    return 2;
  }

  const path = resolve(process.cwd(), target);
  // Read as bytes, not text: the sectioned form is a binary and decoding it as
  // UTF-8 would corrupt it before the reader ever saw the magic.
  const report = await auditContainer(parseContainer(new Uint8Array(readFileSync(path))));

  /*
   * The same verdict, in a shape a program can branch on.
   *
   * The exit code says whether a container is intact; anything wanting to know
   * *why* has had to parse prose written for a person, which is how a tool ends
   * up depending on the wording of a sentence. An agent that builds containers
   * needs the reasons, and so does anything reporting on a directory of them.
   *
   * This is the audit as it stands rather than a second opinion about it: the
   * same function a host calls, serialised.
   */
  if (parsed.flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          file: path,
          ok: report.ok,
          documentUuid: report.documentUuid,
          integrityPolicy: report.integrityPolicy,
          shell: report.shell.status,
          signature: {
            status: report.signature.status,
            fingerprint: report.signature.fingerprint ?? null,
            reason: report.signature.reason ?? null,
          },
          expiry: {
            status: report.expiry.status,
            validUntil: report.expiry.validUntil ?? null,
          },
          entries: report.entries.map((entry) => ({
            name: entry.name,
            status: entry.status,
            expected: entry.expected ?? null,
            actual: entry.actual ?? null,
          })),
          sections: report.sections ?? null,
          unavailable: report.unavailable ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return report.unavailable || !report.ok ? 1 : 0;
  }

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
      case "check":
        return await check(parsed);
      case "bundle":
        return await bundle(parsed);
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
