import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { buildContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const template = readFileSync(resolve(root, "dist/template.html"), "utf8");
const runtime = readFileSync(resolve(root, "dist/dai-runtime.js"), "utf8");

// Generate an ECDSA P-256 keypair for signing the demo cartridge
const keyPair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DAI Physical Hardware Demo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        background: #111827;
        color: #f3f4f6;
        padding: 24px;
        max-width: 500px;
        margin: 0 auto;
      }
      h1 { font-size: 20px; color: #60a5fa; margin-bottom: 8px; }
      .badge {
        display: inline-block;
        padding: 4px 8px;
        background: #1e3a8a;
        color: #93c5fd;
        border-radius: 6px;
        font-size: 12px;
        margin-bottom: 20px;
      }
      .card {
        background: #1f2937;
        border: 1px solid #374151;
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .counter-val { font-size: 36px; font-weight: bold; text-align: center; margin: 12px 0; color: #34d399; }
      button {
        font: inherit;
        padding: 8px 16px;
        background: #2563eb;
        color: white;
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 500;
        margin-right: 8px;
      }
      button:hover { background: #1d4ed8; }
      ul { list-style: none; padding: 0; margin: 12px 0 0 0; }
      li {
        padding: 8px 12px;
        background: #111827;
        border-radius: 6px;
        margin-bottom: 6px;
        display: flex;
        justify-content: space-between;
      }
      input[type="text"] {
        font: inherit;
        padding: 8px 12px;
        background: #111827;
        border: 1px solid #374151;
        border-radius: 6px;
        color: white;
        width: 65%;
      }
    </style>
  </head>
  <body>
    <h1>📱 DAI Demo Cartridge</h1>
    <div class="badge" id="sig-badge">Verifying Signature…</div>

    <div class="card">
      <h3>Counter (Stateful Memory)</h3>
      <div class="counter-val" id="counter">0</div>
      <button id="inc">+ Increment</button>
      <button id="save-btn" style="background:#059669;">💾 Save Cartridge</button>
    </div>

    <div class="card">
      <h3>Task Log</h3>
      <div style="display:flex; gap:8px;">
        <input type="text" id="task-input" placeholder="New task item…" />
        <button id="add-btn">Add</button>
      </div>
      <ul id="task-list"></ul>
    </div>

    <script type="module">
      let count = 0;
      const tasks = [];

      const counterEl = document.getElementById("counter");
      const listEl = document.getElementById("task-list");
      const badgeEl = document.getElementById("sig-badge");

      // Verify DAI global window API
      if (window.dai) {
        badgeEl.textContent = "Signature: " + (window.dai.signature || "verified") + " · ID: " + (window.dai.documentUuid ? window.dai.documentUuid.slice(0, 8) : "air-gapped");
      }

      document.getElementById("inc").addEventListener("click", () => {
        count++;
        counterEl.textContent = count;
      });

      document.getElementById("add-btn").addEventListener("click", () => {
        const input = document.getElementById("task-input");
        if (input.value.trim()) {
          tasks.push(input.value.trim());
          const li = document.createElement("li");
          li.textContent = input.value.trim();
          listEl.appendChild(li);
          input.value = "";
        }
      });

      document.getElementById("save-btn").addEventListener("click", async () => {
        if (window.dai && window.dai.saveState) {
          const stateData = new TextEncoder().encode(JSON.stringify({ count, tasks }));
          const res = await window.dai.saveState(stateData);
          alert("Saved state! Method: " + (res.method || "default"));
        } else {
          alert("Running standalone preview");
        }
      });
    </script>
  </body>
</html>
`;

const result = await buildContainer({
  files: {
    "index.html": new TextEncoder().encode(indexHtml),
  },
  template,
  runtime,
  appName: "DAI Demo App",
  privateKey: keyPair.privateKey,
  publicKey: keyPair.publicKey,
});

const outputPath = resolve(root, "demo.dai.html");
const publicPath = resolve(root, "apps/runner/public/demo.dai.html");

writeFileSync(outputPath, result.html, "utf8");
writeFileSync(publicPath, result.html, "utf8");

console.log("Successfully built signed demo cartridge!");
console.log("Output paths:");
console.log(" - " + outputPath);
console.log(" - " + publicPath);
