import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const fixture = resolve(here, "fixture");

/**
 * Builds the plugin, then compiles the fixture with it. Tests run against the
 * emitted artifact, not against the sources, so what is asserted is what a
 * consumer would actually ship.
 */
export default function globalSetup(): void {
  execSync("npm run build", { cwd: repo, stdio: "inherit" });

  rmSync(resolve(fixture, "dist"), { recursive: true, force: true });
  rmSync(resolve(fixture, "fixture.dai.html"), { force: true });

  execSync("npx vite build", { cwd: fixture, stdio: "inherit" });

  const container = resolve(fixture, "fixture.dai.html");
  if (!existsSync(container)) {
    throw new Error(`Fixture build produced no container at ${container}`);
  }
}
