import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { ContainerError, parseContainer, verifyContainer } from "../src/container.js";
import { packInline, unpackInline, type PastHost } from "../src/inline.js";
import { KIT_SOURCE } from "../src/kit.js";
import { sha256Hex } from "../src/core.js";
import { currentHost, hostId, HOSTS_DIR } from "../scripts/retain-host.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

/** The engine this host holds, by digest, as the opener supplies it. */
const engine = await (async () => {
  const held = new Map<string, Uint8Array>();
  for (const file of ["sqlite3.wasm", "index.mjs"]) {
    const bytes = new Uint8Array(readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist", file)));
    held.set(await sha256Hex(bytes), bytes);
  }
  return (digest: string) => held.get(digest);
})();

/**
 * A compact link outlives the deploy after it.
 *
 * The link leaves out what the opener can rebuild, and the opener as it was
 * is what could rebuild it. So the opener keeps every host it has been, by
 * content, and a link made against an earlier one still opens — proven by
 * digest, as everything rebuilt is.
 */
/** An app compiled by a host with `template`, so its sealed shell is that host's. */
async function appSealedBy(template: string): Promise<string> {
  const source = mkdtempSync(join(tmpdir(), "dai-retention-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><h1>kept</h1>', "utf8");
  const templatePath = join(source, "template.html");
  writeFileSync(templatePath, template, "utf8");
  return (await compileDirectory({ sourceDir: source, root: repo, appName: "Kept", templatePath })).html;
}

test.describe("what the opener used to rebuild from", () => {
  test("the current host is kept, so a deploy does not orphan the links before it", () => {
    // Fails when the runtime, template or kit changed and `npm run build` was
    // not run (it retains) or what it wrote was not committed.
    const id = hostId(currentHost());
    const index = JSON.parse(readFileSync(join(HOSTS_DIR, "index.json"), "utf8")) as string[];
    expect(index, `host ${id} is not in apps/runner/public/hosts/index.json — run npm run build and commit apps/runner/public/hosts`).toContain(id);
    for (const name of ["template.html", "runtime.js", "kit.js"]) {
      expect(existsSync(join(HOSTS_DIR, id, name)), name).toBe(true);
    }
    // And what is kept is what the opener is built from, byte for byte.
    expect(readFileSync(join(HOSTS_DIR, id, "runtime.js"), "utf8")).toBe(HOST.runtime);
    expect(readFileSync(join(HOSTS_DIR, id, "kit.js"), "utf8")).toBe(KIT_SOURCE);
  });

  test("a link made against an earlier host opens on a later one that kept it", async () => {
    // The host as it was: the same runtime, a template one comment different.
    const earlier = { template: HOST.template.replace("<meta charset", "<!-- an earlier deploy --><meta charset"), runtime: HOST.runtime };
    const html = await appSealedBy(earlier.template);
    const value = await packInline(parseContainer(html), earlier);

    // The later host alone cannot rebuild the shell the link leaves out.
    const alone = await unpackInline(value, HOST, { supply: engine }).catch((e: unknown) => e);
    expect(alone).toBeInstanceOf(ContainerError);
    expect((alone as ContainerError).code).toBe("LINK_UNRECONSTRUCTABLE");

    // With what it used to be, it opens, and verifies as the file would.
    let asked = 0;
    const pastHosts = async (): Promise<PastHost[]> => {
      asked += 1;
      return [{ ...earlier, kit: KIT_SOURCE }];
    };
    const back = await unpackInline(value, HOST, { supply: engine, pastHosts });
    expect(asked).toBe(1);
    // Byte for byte the file the earlier host sealed, and it verifies as one.
    expect(back).toBe(html);
    expect(["valid", "unsigned"]).toContain((await verifyContainer(back)).signature);
  });

  test("a past host that does not match either is not believed, and a link that fits asks for none", async () => {
    const foreignTemplate = HOST.template.replace("<meta charset", "<!-- other --><meta charset");
    const foreign = await packInline(parseContainer(await appSealedBy(foreignTemplate)), { template: foreignTemplate, runtime: HOST.runtime });
    const notItEither: PastHost = { template: HOST.template, runtime: `${HOST.runtime}\n/* other */`, kit: KIT_SOURCE };
    const refusal = await unpackInline(foreign, HOST, { supply: engine, pastHosts: async () => [notItEither] }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("LINK_UNRECONSTRUCTABLE");

    // A link this host can rebuild consults nothing.
    const fits = await packInline(parseContainer(await appSealedBy(HOST.template)), HOST);
    let asked = 0;
    await unpackInline(fits, HOST, { supply: engine, pastHosts: async () => { asked += 1; return []; } });
    expect(asked).toBe(0);
  });
});
