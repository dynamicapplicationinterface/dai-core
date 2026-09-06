/**
 * An MCP server, so an assistant can produce a container directly.
 *
 * This is the channel that matters most for people who do not write software.
 * Every other route asks them to move code by hand: copy it out of a chat, save
 * it, run something, or paste it into a page. Here they say what they want, and
 * the model writes the app and seals it without their touching a file.
 *
 * That makes the tool descriptions load-bearing. They are the only place the
 * model learns that a container has no network, that storage goes through
 * window.dai, and that top-level await needs a module script. Written well,
 * nobody ever sees a warning; written badly, the model produces a blank app and
 * the person blames the format. They are documentation for a reader that cannot
 * ask a follow-up question, and should be edited with that in mind.
 *
 * The protocol is spoken directly rather than through the official SDK. dai-core
 * is a library other projects install, and a JSON-RPC dialect this small does
 * not justify putting an SDK into everyone's dependency tree. The subset is
 * exactly: initialize, tools/list, tools/call, and ping.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { compileDirectory, CompileError, formatBytes, packagedAsset, sanitizeFileName } from "./compile.js";
import { SchemaError } from "./schema.js";
import { applicationFiles, auditContainer, looksSectioned, parseContainer } from "./container.js";
import { writeBundle } from "./bundle.js";
import { SCHEMA_ENTRY } from "./core.js";
import { advisory, breaking, lintFiles } from "./lint.js";
import { RECIPE } from "./recipe.js";
import { lastLine, linkFor, type Host } from "./sender.js";
import type { Store } from "./store.js";
import { storeFromEnvironment as storeFromEnv } from "./env.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const SERVER_NAME = "dai";
export const SERVER_VERSION = "0.1.0";

/** What we implement. Echoed back to a client that asks for something else. */
export const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "create_dai_app",
    description:
      "Compile application files into a single .dai.html container: one file holding the app, " +
      "a SQLite engine and its data, which opens by double-clicking in any browser with nothing " +
      "installed, works offline, and cannot send data anywhere.\n\n" +
      RECIPE,
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "object",
          description:
            "File contents keyed by path relative to the app root. Must include index.html. " +
            "Example: {\"index.html\": \"<!doctype html>…\", \"app.js\": \"…\"}",
          additionalProperties: { type: "string" },
        },
        appName: {
          type: "string",
          description: "Shown as the window title and used for the file name.",
        },
        outputPath: {
          type: "string",
          description:
            "Where to write the container, relative to the working directory. " +
            "Defaults to <appName>.dai.html.",
        },
        signingKeyPath: {
          type: "string",
          description:
            "Optional PKCS#8 PEM private key to sign with. Without one the container is " +
            "still tamper-evident but carries no publisher identity.",
        },
        preview: {
          type: "boolean",
          description:
            "Whether a link to this app may show its name and publisher in a chat preview. " +
            "Defaults to true, because a link somebody is about to send should say what it " +
            "is. Pass false for anything the person would not want named in a message before " +
            "they have sent it.",
        },
        supersedes: {
          type: "string",
          description:
            "The uuid of the document this replaces, as `document:` in a bundle from " +
            "get_dai_source. Use it when you are rebuilding an app whose file you do not have " +
            "on disk. A host that holds that document adopts its data under the same publisher " +
            "key; without it, the result is a different document and the person starts empty.",
        },
        upgradeOf: {
          type: "string",
          description:
            "When rebuilding an app that already exists — a second version, a change the " +
            "person asked for — the path of the existing .dai.html or .dai. The build then " +
            "checks that the data shape did not move without a migration, and refuses if it " +
            "did, because the old file holds the person's data and the new code would " +
            "silently ignore it. Always pass this when there is a previous file.",
        },
      },
      required: ["files", "appName"],
    },
  },
  {
    name: "check_dai_app",
    description:
      "Check application source for things that work on a web page but fail silently inside a " +
      "container. Use this before create_dai_app when adapting existing code.\n\n" +
      RECIPE,
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "object",
          description: "File contents keyed by path.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["files"],
    },
  },
  {
    name: "get_dai_source",
    description:
      "Read the application source back out of an existing .dai.html or .dai, as one bundle. " +
      "Use this whenever the person wants an app they already have changed, rather than " +
      "writing it again from memory: you get the files that were sealed into it, plus the " +
      "document's identity.\n\n" +
      "The bundle header carries `document:` and `schema:`. Pass the document value back as " +
      "`supersedes` on create_dai_app, and pass the original file as `upgradeOf` when you have " +
      "its path. That is what makes the result the next version of their app — a host brings " +
      "their existing data across — instead of a new app with a similar name and an empty " +
      "database.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the container to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "verify_dai_app",
    description:
      "Check an existing .dai.html file: whether every entry still matches the digest recorded " +
      "when it was sealed, whether the shell is untouched, and whether its signature is valid.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the container." },
      },
      required: ["path"],
    },
  },
];

/**
 * The store this server publishes to, when one is configured.
 *
 * A filesystem store is the honest default for a server running on somebody's
 * machine: the directory is theirs, whatever serves it is theirs, and nothing
 * about it belongs to this project. `DAI_STORE_DIR` names the directory and
 * `DAI_STORE_BASE` the URL it appears under; without the second, links name a
 * `file:` URL only this machine can follow, which is right for a local test
 * and useless to send, and is said so.
 */
async function storeFromEnvironment(): Promise<Store | undefined> {
  // One resolver, shared with the command line, so a machine that can publish
  // from one can publish from the other and neither invents its own rules
  // about where a credential comes from. See `src/env.ts`.
  return storeFromEnv();
}

/** The shell this server can rebuild, so a link may leave it out. */
function senderHost(): Host {
  return {
    template: readFileSync(packagedAsset("template.html"), "utf8"),
    runtime: readFileSync(packagedAsset("dai-runtime.js"), "utf8"),
  };
}

export interface ServerOptions {
  /**
   * The directory the server may read and write within.
   *
   * A boundary rather than a convenience: this process runs on someone's
   * machine, and the arguments come from a model acting on a conversation it
   * may not fully control. Without a root, "outputPath" is an arbitrary file
   * write. Paths are resolved and checked against it before anything is opened.
   */
  root: string;
}

/**
 * Refused because it would escape the root.
 *
 * Three ways out, and the first two were open. `path.relative` between two
 * Windows drives — `C:\root` and `D:\evil` — returns the absolute target,
 * which does not start with `..`, and resolving it against the root gives it
 * back unchanged; the same for a UNC path. So the check that looked for `..`
 * let a model write to any drive on the machine. The absolute case is now
 * refused by name. The third way is a symlink inside the root pointing out
 * of it, which is closed by comparing real paths where the target exists.
 */
function withinRoot(root: string, target: string): string {
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  const escapes = rel.startsWith("..") || isAbsolute(rel) || resolve(root, rel) !== absolute;
  const realRoot = existsSync(root) ? realpathSync.native(root) : root;
  const realTarget = existsSync(absolute) ? realpathSync.native(absolute) : undefined;
  const escapesByLink =
    realTarget !== undefined &&
    (relative(realRoot, realTarget).startsWith("..") || isAbsolute(relative(realRoot, realTarget)));
  if (escapes || escapesByLink) {
    throw new CompileError(
      `Refusing to touch ${absolute}: it is outside ${root}, which this server is limited to.`,
    );
  }
  return absolute;
}

function text(body: string, isError = false): unknown {
  return { content: [{ type: "text", text: body }], isError };
}

function describe(findings: ReturnType<typeof lintFiles>): string {
  return findings
    .map((finding) => `- ${finding.file}: ${finding.what} ${finding.why}\n  Fix: ${finding.fix}`)
    .join("\n");
}

async function createApp(
  options: ServerOptions,
  params: Record<string, unknown>,
): Promise<unknown> {
  const files = params.files as Record<string, string> | undefined;
  const appName = typeof params.appName === "string" ? params.appName : undefined;

  if (!files || typeof files !== "object" || Object.keys(files).length === 0) {
    return text("create_dai_app needs a files object mapping paths to contents.", true);
  }
  if (!appName) {
    return text("create_dai_app needs an appName.", true);
  }
  if (!Object.keys(files).includes("index.html")) {
    return text(
      "There is no index.html, so the container would open blank. Name the entry point " +
        "index.html.",
      true,
    );
  }

  // Refused rather than warned about: the model can fix this before anything is
  // written, and a container that silently does nothing is the worst outcome
  // for a person who cannot read the code to find out why.
  const findings = breaking(lintFiles(files));
  /*
   * What is refused rather than warned about.
   *
   * Each of these leaves the person holding a file that looks finished and is
   * not: a blank page, a page with no styling it was written to have, or
   * buttons that do nothing when pressed. A model can fix any of them and call
   * again in seconds, which is why this path refuses where the website and the
   * desktop app only warn — there, a person is present to judge, and it is
   * their code.
   */
  const fatal = findings.filter(
    (finding) =>
      finding.id === "await-in-classic-script" ||
      finding.id === "cdn-script" ||
      finding.id === "inline-event-handler",
  );
  if (fatal.length > 0) {
    return text(
      `This will not work inside a container:\n${describe(fatal)}\n\n` +
        `Fix these and call create_dai_app again.`,
      true,
    );
  }

  // Staged in a temporary directory because the compiler reads from a tree.
  const staging = mkdtempSync(resolve(tmpdir(), "dai-mcp-"));
  let result: Awaited<ReturnType<typeof compileDirectory>>;
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = withinRoot(staging, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    result = await compileDirectory({
    sourceDir: staging,
    root: options.root,
    appName,
    signingKey:
      typeof params.signingKeyPath === "string"
        ? withinRoot(options.root, params.signingKeyPath)
        : undefined,
    upgradeOf:
      typeof params.upgradeOf === "string" ? withinRoot(options.root, params.upgradeOf) : undefined,
    // Names the predecessor without needing its file: what a bundle carries
    // back from get_dai_source when the original is not on this disk (4.2).
    supersedes: typeof params.supersedes === "string" ? params.supersedes : undefined,
    });
  } finally {
    // The model's files, in the clear, under a temporary directory nothing
    // ever swept: a review found them accumulating. Gone with the call.
    rmSync(staging, { recursive: true, force: true });
  }

  const outputPath = withinRoot(
    options.root,
    typeof params.outputPath === "string"
      ? params.outputPath
      : `${sanitizeFileName(appName)}.dai.html`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, result.html, "utf8");

  const warnings = findings.filter((finding) => !fatal.includes(finding));

  /*
   * Whether a link may say what this app is called (§3.3).
   *
   * On by default: the assistant is making something for a person to send, and
   * a preview is what makes a sent link legible to whoever receives it — and
   * off is one parameter away. A server deployed where that default is wrong
   * sets DAI_PREVIEW_DEFAULT=off, and then a caller has to ask for a preview
   * rather than remember to refuse one.
   */
  const preview =
    typeof params.preview === "boolean"
      ? params.preview
      : process.env.DAI_PREVIEW_DEFAULT !== "off";

  /*
   * The link, last (backlog 2.5).
   *
   * A file is the thing; a link is how it reaches somebody with a phone. The
   * assistant's last line is therefore the link, because the last line is what
   * a person copies — and when there cannot be one, the last line says why in
   * a sentence they can act on.
   */
  const handoff = await linkFor(result.html, {
    opener: process.env.DAI_OPENER,
    host: senderHost(),
    store: await storeFromEnvironment(),
    preview,
  });

  return text(
    `Wrote ${outputPath}\n` +
      `${formatBytes(Buffer.byteLength(result.html))}, ${result.entryCount} entries, ${result.engine}\n` +
      `document ${result.documentUuid}\n` +
      /*
       * What this replaces, said out loud (backlog 4.2).
       *
       * A second version built with `upgradeOf` names the document it
       * supersedes in its signed set, and a host that holds that document
       * brings its data across under the same publisher key. That is the
       * difference between an improved app and a stranger with a similar
       * name, and it is invisible unless the tool that made it says so — an
       * assistant reporting "made a new app" when it made a successor is the
       * one sentence that would make somebody expect their data to be gone.
       */
      (result.manifest.supersedes
        ? `replaces ${result.manifest.supersedes} — a host that has it brings its data across, ` +
          `under the same key, and keeps the old one as it was\n`
        : "") +
      `${
        result.publicKeyFingerprint
          ? `signed ${result.publicKeyFingerprint}`
          : "unsigned — tamper-evident, but it carries no publisher identity"
      }\n\n` +
      `Tell the user they can open this file by double-clicking it. It runs in any browser ` +
      `with nothing installed, works offline, and can be sent to other people as it is.` +
      (warnings.length > 0 ? `\n\nWorth fixing:\n${describe(warnings)}` : "") +
      (result.warnings.length > 0 ? `\n\n${result.warnings.join("\n")}` : "") +
      `\n\n${lastLine(handoff)}`,
  );
}

/**
 * The source back out of a container, as a bundle (backlog 4.2).
 *
 * "Modify this app" is the whole reason this exists. A person has a document
 * that works and wants one thing different about it, and the way through used
 * to be describing it again from scratch — which produces a new application
 * with a new identity, no succession, and a host that will not bring their
 * data across, because nothing the assistant was given said this was a second
 * version of anything.
 *
 * So the bundle header carries the document's uuid and the digest of the
 * schema it was built against. The uuid is what `supersedes` needs; the digest
 * is enough to notice that a rewrite moved the data shape, which is the
 * question that decides whether a migration is required.
 *
 * Only the application's own files come back. The engine, the shell and the
 * runtime belong to the host, they are not what anybody wants to edit, and
 * putting a megabyte of SQLite in front of a model is a way to lose the part
 * that matters.
 */
async function getSource(options: ServerOptions, params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.path !== "string") {
    return text("get_dai_source needs a path.", true);
  }

  const target = withinRoot(options.root, params.path);
  if (!existsSync(target)) {
    return text(`No such file: ${target}`, true);
  }

  const bytes = new Uint8Array(readFileSync(target));
  const container = parseContainer(looksSectioned(bytes) ? bytes : new TextDecoder().decode(bytes));

  const decoder = new TextDecoder();
  const files: Record<string, string> = {};
  const binary: string[] = [];
  for (const [name, content] of Object.entries(applicationFiles(container.archive))) {
    // Text only. A bundle is text, and a font or a photograph handed to a
    // model as mojibake is worse than one it is simply told about.
    const decoded = decoder.decode(content);
    if (decoded.includes("\u0000")) binary.push(name);
    else files[name] = decoded;
  }

  const schemaEntry = container.archive[SCHEMA_ENTRY];
  const schema = schemaEntry
    ? (JSON.parse(decoder.decode(schemaEntry)) as { digest?: string }).digest
    : undefined;

  const uuid = container.manifest.documentUuid;
  const bundle = writeBundle(files, {
    name: container.manifest.appName,
    documentUuid: uuid,
    schema,
  });

  const lines = [
    target,
    `${Object.keys(files).length} files, document ${uuid}`,
    ...(binary.length > 0
      ? [
          `Left out because they are not text: ${binary.join(", ")}. ` +
            "Keep them by passing the original file as upgradeOf.",
        ]
      : []),
    "",
    `When you build the changed version, pass supersedes: "${uuid}" so it replaces this ` +
      "document instead of becoming a new one" +
      (schema ? `, and keep the schema at ${schema} or add a migration` : "") +
      ".",
    "",
    bundle,
  ];

  return text(lines.join("\n"));
}

async function verifyApp(
  options: ServerOptions,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (typeof params.path !== "string") {
    return text("verify_dai_app needs a path.", true);
  }

  const target = withinRoot(options.root, params.path);
  if (!existsSync(target)) {
    return text(`No such file: ${target}`, true);
  }

  const report = await auditContainer(parseContainer(readFileSync(target, "utf8")));
  const failed = report.entries.filter((entry) => entry.status !== "ok");

  return text(
    `${target}\n` +
      `${report.ok ? "Intact" : "FAILED — this container has been altered since it was sealed"}\n` +
      `document ${report.documentUuid}\n` +
      `${report.entries.length} entries, ${failed.length} not matching\n` +
      `shell ${report.shell.status}, signature ${report.signature.status}, expiry ${report.expiry.status}` +
      (failed.length > 0
        ? `\n\n${failed.map((entry) => `${entry.status}: ${entry.name}`).join("\n")}`
        : ""),
    !report.ok,
  );
}

async function callTool(
  options: ServerOptions,
  params: Record<string, unknown>,
): Promise<unknown> {
  const name = params.name as string;
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "create_dai_app":
      return createApp(options, args);
    case "check_dai_app": {
      const files = args.files as Record<string, string> | undefined;
      if (!files) return text("check_dai_app needs a files object.", true);
      const findings = lintFiles(files);
      const errors = breaking(findings);
      const warnings = advisory(findings);
      return text(
        (errors.length === 0
          ? "Nothing here will break inside a container."
          : `These will not work inside a container:\n${describe(errors)}`) +
          (warnings.length > 0 ? `\n\nWorth fixing before it is shared:\n${describe(warnings)}` : ""),
      );
    }
    case "get_dai_source":
      return getSource(options, args);
    case "verify_dai_app":
      return verifyApp(options, args);
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

/**
 * Handles one message. Returns null for notifications, which take no reply.
 *
 * Pure with respect to transport, so the protocol can be tested by handing it
 * objects rather than by driving a subprocess through a pipe.
 */
export async function handleMessage(
  options: ServerOptions,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  // Notifications carry no id and must not be answered.
  if (request.id === undefined) return null;

  try {
    switch (request.method) {
      case "initialize": {
        const asked = request.params?.protocolVersion;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            // Echoed when the client names one, so a newer client is not
            // refused over a version this server has no opinion about.
            protocolVersion: typeof asked === "string" ? asked : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call":
        return {
          jsonrpc: "2.0",
          id,
          result: await callTool(options, request.params ?? {}),
        };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  } catch (error) {
    // A CompileError is the caller's to fix and is reported as tool output, so
    // the model can read it and try again rather than seeing a transport fault.
    if (error instanceof CompileError || error instanceof SchemaError) {
      return { jsonrpc: "2.0", id, result: text(error.message, true) };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export { TOOLS };
