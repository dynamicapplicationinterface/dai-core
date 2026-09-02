import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, "../apps/desktop/src-tauri/icons");
mkdirSync(iconsDir, { recursive: true });

// Minimal 1x1 PNG header with DAI blue color palette
const pngHeader = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

writeFileSync(resolve(iconsDir, "32x32.png"), pngHeader);
writeFileSync(resolve(iconsDir, "128x128.png"), pngHeader);
writeFileSync(resolve(iconsDir, "128x128@2x.png"), pngHeader);
writeFileSync(resolve(iconsDir, "icon.png"), pngHeader);
writeFileSync(resolve(iconsDir, "icon.ico"), pngHeader);
writeFileSync(resolve(iconsDir, "icon.icns"), pngHeader);

console.log("Generated icon placeholders in apps/desktop/src-tauri/icons/");
