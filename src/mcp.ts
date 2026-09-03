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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { compileDirectory, CompileError, formatBytes, sanitizeFileName } from "./compile.js";
import { auditContainer, parseContainer } from "./container.js";
import { lintFiles } from "./lint.js";
import { RECIPE } from "./recipe.js";
import { mkdtempSync } from "node:fs";
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

/** Refused because it would escape the root. */
function withinRoot(root: string, target: string): string {
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || resolve(root, rel) !== absolute) {
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
  const findings = lintFiles(files);
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
  for (const [name, content] of Object.entries(files)) {
    const target = withinRoot(staging, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  const result = await compileDirectory({
    sourceDir: staging,
    root: options.root,
    appName,
    signingKey:
      typeof params.signingKeyPath === "string"
        ? withinRoot(options.root, params.signingKeyPath)
        : undefined,
  });

  const outputPath = withinRoot(
    options.root,
    typeof params.outputPath === "string"
      ? params.outputPath
      : `${sanitizeFileName(appName)}.dai.html`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, result.html, "utf8");

  const warnings = findings.filter((finding) => !fatal.includes(finding));

  return text(
    `Wrote ${outputPath}\n` +
      `${formatBytes(Buffer.byteLength(result.html))}, ${result.entryCount} entries, ${result.engine}\n` +
      `document ${result.documentUuid}\n` +
      `${
        result.publicKeyFingerprint
          ? `signed ${result.publicKeyFingerprint}`
          : "unsigned — tamper-evident, but it carries no publisher identity"
      }\n\n` +
      `Tell the user they can open this file by double-clicking it. It runs in any browser ` +
      `with nothing installed, works offline, and can be sent to other people as it is.` +
      (warnings.length > 0 ? `\n\nWorth fixing:\n${describe(warnings)}` : "") +
      (result.warnings.length > 0 ? `\n\n${result.warnings.join("\n")}` : ""),
  );
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
      return text(
        findings.length === 0
          ? "Nothing here will break inside a container."
          : `These will not work inside a container:\n${describe(findings)}`,
      );
    }
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
    if (error instanceof CompileError) {
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
