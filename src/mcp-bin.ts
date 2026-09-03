#!/usr/bin/env node
/**
 * The MCP server's stdio transport.
 *
 * Line-delimited JSON on stdin and stdout, which is what MCP clients launch a
 * server as. Kept apart from mcp.ts for the same reason bin.ts is kept apart
 * from cli.ts: importing the protocol logic to test it must not start a server
 * reading from the process's stdin.
 *
 * Nothing may be written to stdout except responses — a stray console.log
 * corrupts the stream and the client sees a parse error rather than the message
 * that caused it. Diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { handleMessage, type JsonRpcRequest } from "./mcp.js";

const rootArgument = process.argv.indexOf("--root");
const root =
  rootArgument >= 0 && process.argv[rootArgument + 1]
    ? resolve(process.argv[rootArgument + 1] as string)
    : process.cwd();

process.stderr.write(`dai mcp server — writing within ${root}\n`);

const options = { root };
const lines = createInterface({ input: process.stdin });

// Serialised: a client may pipeline requests, and two compiles racing to write
// the same output path would interleave.
let queue: Promise<void> = Promise.resolve();

lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  queue = queue.then(async () => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      return;
    }

    const response = await handleMessage(options, request);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
});
