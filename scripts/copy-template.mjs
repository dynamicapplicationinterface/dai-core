import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
copyFileSync(resolve(root, "src/template.html"), resolve(root, "dist/template.html"));
console.log("[dai] copied template.html -> dist/template.html");
