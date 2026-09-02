---
title: 5-Minute Quickstart
description: Get started packaging and running DAI containers in 3 steps.
---

# 5-Minute Quickstart

Learn how to bundle an HTML/JavaScript application into a standalone, air-gapped `.dai` container and run it across desktop and web environments.

## Step 1: Prepare Your Application

A DAI container can package any client-side web application built with Vanilla JS, React, Vue, Svelte, or Vite. 

For this quickstart, create a simple static project directory named `my-app/`:

```html
<!-- my-app/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Air-Gapped Notepad</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 2rem; background: #0f172a; color: #f8fafc; }
      textarea { width: 100%; height: 200px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 8px; padding: 12px; }
      button { margin-top: 12px; padding: 8px 16px; background: #3b82f6; color: white; border: 0; border-radius: 6px; cursor: pointer; }
    </style>
  </head>
  <body>
    <h1>Air-Gapped Secure Notes</h1>
    <p>Status: <span id="status">Active</span></p>
    <textarea id="note" placeholder="Type your secure notes here..."></textarea>
    <br />
    <button id="saveBtn">Save Document</button>

    <script type="module">
      const note = document.getElementById('note');
      const status = document.getElementById('status');

      // 1. Read existing SQLite database or initial state
      if (window.dai) {
        status.textContent = \`Container UUID: \${window.dai.documentUuid.slice(0, 8)}...\`;
      }

      // 2. Trigger Container Save
      document.getElementById('saveBtn').addEventListener('click', async () => {
        if (window.dai && window.dai.saveState) {
          const encoder = new TextEncoder();
          const stateData = encoder.encode(JSON.stringify({ content: note.value }));
          const res = await window.dai.saveState(stateData);
          alert(\`Document saved via \${res.method}!\`);
        }
      });
    </script>
  </body>
</html>
```

---

## Step 2: Compile into a `.dai.html` Container

Using the official `dai-core` compiler library, you can package the application files into a single polyglot container:

```typescript
// build.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { buildContainer } from 'dai-core/core';

// 1. Load your compiled files
const appHtml = readFileSync('./my-app/index.html');
const template = readFileSync('./node_modules/dai-core/dist/template.html', 'utf8');
const runtime = readFileSync('./node_modules/dai-core/dist/dai-runtime.js', 'utf8');

// 2. Compile container
const result = await buildContainer({
  files: {
    'index.html': appHtml,
  },
  template,
  runtime,
  appName: 'Secure Notepad',
  verifyIntegrity: true,
  // Optional: signingKey (PEM or WebCrypto keypair)
  // Optional: validUntil (Unix timestamp for signed expiration)
});

// 3. Write output container
writeFileSync('notepad.dai.html', result.html, 'utf8');
console.log('Successfully created notepad.dai.html!');
```

---

## Step 3: Run and Verify

You now have a standalone `notepad.dai.html` file. You can execute it in multiple ways:

1. **Direct Double-Click:** Open `notepad.dai.html` directly in Chromium, Firefox, or Safari over `file://`. The bootloader unpacks the payload, initializes the in-memory SQLite runtime, and renders the application inside an isolated `srcdoc` frame.
2. **Via DAI Runner (`apps/runner`):** Drag and drop the file into the web runner or desktop shell to get full host-verified audit logs and OPFS persistence.
3. **In the Playground:** Drop your file into our [Interactive Playground](/playground) to verify the bidirectional SHA-256 entry digests and signature status.
