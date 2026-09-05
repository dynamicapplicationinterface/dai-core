#!/usr/bin/env node
/**
 * Checks that a live store serves a blob the way the opener needs it served.
 *
 *     node scripts/check-store.mjs https://store.example/<hash>
 *
 * Three headers, all of which are bucket configuration rather than code, and
 * all of which fail silently from inside a page: without CORS the fetch dies
 * with no message, without immutable caching a document is re-fetched every
 * open, and with a text content type some intermediaries rewrite bytes. Run
 * this against the first object in a new bucket before handing out a link.
 */
const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/check-store.mjs <blob url>");
  process.exit(2);
}

const response = await fetch(url, { method: "GET", headers: { origin: "https://opendai.app" } });
const failures = [];

const acao = response.headers.get("access-control-allow-origin");
if (acao !== "*") failures.push(`Access-Control-Allow-Origin is ${JSON.stringify(acao)}, wanted *`);

const cache = response.headers.get("cache-control") ?? "";
if (!/immutable/.test(cache)) failures.push(`Cache-Control is ${JSON.stringify(cache)}, wanted immutable`);

const type = response.headers.get("content-type") ?? "";
if (!type.startsWith("application/octet-stream")) {
  failures.push(`Content-Type is ${JSON.stringify(type)}, wanted application/octet-stream`);
}

if (!response.ok) failures.push(`HTTP ${response.status}`);

console.log(`${url}\n  status ${response.status}`);
for (const [name, value] of response.headers) console.log(`  ${name}: ${value}`);
if (failures.length) {
  console.log("\nnot ready:");
  for (const line of failures) console.log(`  ${line}`);
  process.exit(1);
}
console.log("\nready: the opener can read from this store.");
