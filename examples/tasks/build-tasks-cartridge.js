import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { buildContainer, buildLaunchers } from "../../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const template = readFileSync(resolve(root, "dist/template.html"), "utf8");
const runtime = readFileSync(resolve(root, "dist/dai-runtime.js"), "utf8");

// Generate a fresh ECDSA P-256 key pair for signing the tasks cartridge
const keyPair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

const taskFavicon =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" rx="20" fill="%230f172a"/%3E%3Crect x="25" y="20" width="50" height="65" rx="8" fill="%231e293b" stroke="%233b82f6" stroke-width="4"/%3E%3Crect x="38" y="14" width="24" height="10" rx="3" fill="%233b82f6"/%3E%3Cpath d="M35 40 L45 50 L65 30" fill="none" stroke="%2310b981" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/%3E%3Cline x1="35" y1="62" x2="65" y2="62" stroke="%2394a3b8" stroke-width="4" stroke-linecap="round"/%3E%3C/svg%3E';

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Task & Project Manager</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-main: #0f172a;
        --bg-card: #1e293b;
        --bg-sidebar: #1e293b;
        --border-color: #334155;
        --text-main: #f8fafc;
        --text-muted: #94a3b8;
        --accent: #3b82f6;
        --accent-hover: #2563eb;
        --danger: #ef4444;
        --success: #10b981;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: var(--bg-main);
        color: var(--text-main);
        height: 100vh;
        display: flex;
        flex-direction: column;
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 140px 12px 20px;
        background: #1e293b;
        border-bottom: 1px solid var(--border-color);
        flex: 0 0 auto;
      }
      header h1 { font-size: 16px; margin: 0; font-weight: 600; color: #60a5fa; }
      header .spacer { flex: 1; }
      .badge {
        font-size: 12px;
        padding: 4px 10px;
        background: #1e3a8a;
        color: #93c5fd;
        border-radius: 9999px;
        border: 1px solid #2563eb;
      }
      button {
        font: inherit;
        font-size: 13px;
        padding: 8px 14px;
        color: white;
        background: var(--accent);
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      button:hover { background: var(--accent-hover); }
      button.btn-save { background: #059669; }
      button.btn-save:hover { background: #047857; }
      button.btn-danger { background: #b91c1c; }
      button.btn-danger:hover { background: #991b1b; }

      .toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #065f46;
        color: #a7f3d0;
        padding: 10px 16px;
        border-radius: 8px;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
        z-index: 100;
      }
      .toast.show { opacity: 1; }

      main {
        flex: 1 1 auto;
        display: flex;
        overflow: hidden;
      }
      aside {
        width: 240px;
        background: var(--bg-sidebar);
        border-right: 1px solid var(--border-color);
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        flex-shrink: 0;
      }
      aside h2 { font-size: 12px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em; margin: 0; }
      .proj-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
      .proj-item {
        padding: 8px 12px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
        color: var(--text-muted);
      }
      .proj-item:hover, .proj-item.active { background: #334155; color: var(--text-main); }
      .proj-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

      .content {
        flex: 1;
        padding: 20px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .toolbar {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .filter-group { display: flex; background: #1e293b; border: 1px solid var(--border-color); border-radius: 6px; padding: 2px; }
      .filter-btn {
        background: transparent;
        color: var(--text-muted);
        padding: 5px 12px;
        border-radius: 4px;
        font-size: 13px;
      }
      .filter-btn.active { background: #334155; color: var(--text-main); }
      select, input[type="text"], textarea {
        font: inherit;
        font-size: 13px;
        padding: 7px 12px;
        background: #0f172a;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        color: var(--text-main);
      }

      .card-form {
        background: #1e293b;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .form-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .form-row input, .form-row select { flex: 1; min-width: 120px; }

      .task-list { display: flex; flex-direction: column; gap: 8px; }
      .task-card {
        background: #1e293b;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .task-card.completed { opacity: 0.6; }
      .task-card.completed .task-title { text-decoration: line-through; }
      .task-main { flex: 1; }
      .task-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
      .task-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      
      .priority-badge {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .p-urgent { background: #7f1d1d; color: #fca5a5; }
      .p-high { background: #7c2d12; color: #fdba74; }
      .p-medium { background: #1e3a8a; color: #93c5fd; }
      .p-low { background: #064e3b; color: #6ee7b7; }

      .tag-pill {
        font-size: 11px;
        background: #334155;
        color: #cbd5e1;
        padding: 2px 6px;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>📋 Task & Project Console</h1>
      <span class="spacer"></span>
      <span id="badge" class="badge">Initialising...</span>
      <button id="save-btn" class="btn-save">💾 Save Changes</button>
    </header>

    <main>
      <aside>
        <h2>Projects</h2>
        <ul id="proj-list" class="proj-list"></ul>

        <h2>Add Project</h2>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <input type="text" id="new-proj-name" placeholder="Project name..." />
          <div style="display:flex; gap:6px;">
            <input type="color" id="new-proj-color" value="#3b82f6" style="width:40px; height:32px; padding:0; border:0; background:transparent; cursor:pointer;" />
            <button id="add-proj-btn" style="flex:1;">+ Add</button>
          </div>
        </div>
      </aside>

      <section class="content">
        <div class="card-form">
          <div style="font-weight:600; font-size:14px;">Create New Task</div>
          <div class="form-row">
            <input type="text" id="task-title" placeholder="Task title..." style="flex:2;" />
            <select id="task-project"></select>
            <select id="task-priority">
              <option value="medium">Medium Priority</option>
              <option value="low">Low Priority</option>
              <option value="high">High Priority</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div class="form-row">
            <input type="text" id="task-tags" placeholder="Tags (comma separated)..." style="flex:1;" />
            <button id="add-task-btn">+ Create Task</button>
          </div>
        </div>

        <div class="toolbar">
          <div class="filter-group">
            <button class="filter-btn active" data-status="all">All</button>
            <button class="filter-btn" data-status="active">Active</button>
            <button class="filter-btn" data-status="completed">Completed</button>
          </div>

          <div style="margin-left:auto; display:flex; align-items:center; gap:8px; font-size:13px; color:var(--text-muted);">
            <span>Sort by:</span>
            <select id="sort-select">
              <option value="priority">Priority</option>
              <option value="id">Creation Order</option>
            </select>
          </div>
        </div>

        <div id="task-list" class="task-list"></div>
      </section>
    </main>

    <div id="toast" class="toast"></div>

    <script type="module">
      // In-Memory Relational Database State Engine
      let db = {
        projects: [
          { id: 1, name: "DAI Protocol", color: "#3b82f6" },
          { id: 2, name: "Personal Goals", color: "#10b981" }
        ],
        tasks: [
          { id: 1, project_id: 1, title: "Implement Host Bridge Protocol", priority: "urgent", completed: 1 },
          { id: 2, project_id: 1, title: "Verify WebKit OPFS Persistence", priority: "high", completed: 1 },
          { id: 3, project_id: 1, title: "Build Task & Project App Container", priority: "urgent", completed: 0 },
          { id: 4, project_id: 2, title: "Launch DAI Production Runner", priority: "medium", completed: 0 }
        ],
        tags: [
          { id: 1, name: "air-gap" },
          { id: 2, name: "crypto" },
          { id: 3, name: "pwa" }
        ],
        task_tags: [
          { task_id: 1, tag_id: 1 },
          { task_id: 1, tag_id: 3 },
          { task_id: 2, tag_id: 1 },
          { task_id: 3, tag_id: 1 },
          { task_id: 3, tag_id: 2 },
          { task_id: 4, tag_id: 3 }
        ]
      };

      let selectedProjectId = null;
      let statusFilter = "all";
      let sortBy = "priority";

      if (window.dai && window.dai.document && window.dai.document.byteLength > 0) {
        try {
          const jsonStr = new TextDecoder().decode(window.dai.document);
          const loadedDb = JSON.parse(jsonStr);
          if (loadedDb.projects && loadedDb.tasks) {
            db = loadedDb;
          }
        } catch {
          // Keep seed data if non-JSON
        }
      }

      function updateBadge() {
        const badgeEl = document.getElementById("badge");
        if (window.dai) {
          const fp = window.dai.publicKeyFingerprint ? window.dai.publicKeyFingerprint.slice(0, 8) : "unsigned";
          badgeEl.textContent = \`signed \${fp} · sig \${window.dai.signature || "valid"}\`;
        }
      }

      function showToast(msg) {
        const toast = document.getElementById("toast");
        toast.textContent = msg;
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 3000);
      }

      function renderProjects() {
        const list = document.getElementById("proj-list");
        const select = document.getElementById("task-project");
        list.innerHTML = "";
        select.innerHTML = "";

        const allLi = document.createElement("li");
        allLi.className = "proj-item" + (selectedProjectId === null ? " active" : "");
        allLi.innerHTML = \`<span class="proj-dot" style="background:#94a3b8"></span> All Projects\`;
        allLi.onclick = () => { selectedProjectId = null; render(); };
        list.appendChild(allLi);

        db.projects.forEach(p => {
          const li = document.createElement("li");
          li.className = "proj-item" + (selectedProjectId === p.id ? " active" : "");
          li.innerHTML = \`<span class="proj-dot" style="background:\${p.color}"></span> \${escapeHtml(p.name)}\`;
          li.onclick = () => { selectedProjectId = p.id; render(); };
          list.appendChild(li);

          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name;
          select.appendChild(opt);
        });
      }

      function renderTasks() {
        const container = document.getElementById("task-list");
        container.innerHTML = "";

        let filtered = db.tasks.filter(t => {
          if (selectedProjectId !== null && t.project_id !== selectedProjectId) return false;
          if (statusFilter === "active" && t.completed) return false;
          if (statusFilter === "completed" && !t.completed) return false;
          return true;
        });

        const pWeights = { urgent: 4, high: 3, medium: 2, low: 1 };
        if (sortBy === "priority") {
          filtered.sort((a, b) => (pWeights[b.priority] || 0) - (pWeights[a.priority] || 0));
        } else {
          filtered.sort((a, b) => b.id - a.id);
        }

        if (filtered.length === 0) {
          container.innerHTML = \`<div style="text-align:center; padding:40px; color:var(--text-muted); font-size:14px;">No tasks found.</div>\`;
          return;
        }

        filtered.forEach(task => {
          const project = db.projects.find(p => p.id === task.project_id);
          const taskTagIds = db.task_tags.filter(tt => tt.task_id === task.id).map(tt => tt.tag_id);
          const taskTags = db.tags.filter(t => taskTagIds.includes(t.id));

          const card = document.createElement("div");
          card.className = "task-card" + (task.completed ? " completed" : "");

          const check = document.createElement("input");
          check.type = "checkbox";
          check.checked = Boolean(task.completed);
          check.onclick = () => toggleTask(task.id);

          const main = document.createElement("div");
          main.className = "task-main";

          const title = document.createElement("div");
          title.className = "task-title";
          title.textContent = task.title;

          const meta = document.createElement("div");
          meta.className = "task-meta";

          const pBadge = document.createElement("span");
          pBadge.className = \`priority-badge p-\${task.priority}\`;
          pBadge.textContent = task.priority;

          const pName = document.createElement("span");
          pName.style.color = project ? project.color : "#94a3b8";
          pName.textContent = project ? project.name : "Unassigned";

          meta.appendChild(pBadge);
          meta.appendChild(pName);

          taskTags.forEach(tag => {
            const tagEl = document.createElement("span");
            tagEl.className = "tag-pill";
            tagEl.textContent = "#" + tag.name;
            meta.appendChild(tagEl);
          });

          main.appendChild(title);
          main.appendChild(meta);

          const delBtn = document.createElement("button");
          delBtn.className = "btn-danger";
          delBtn.textContent = "✕";
          delBtn.onclick = () => deleteTask(task.id);

          card.appendChild(check);
          card.appendChild(main);
          card.appendChild(delBtn);

          container.appendChild(card);
        });
      }

      function toggleTask(id) {
        const task = db.tasks.find(t => t.id === id);
        if (task) {
          task.completed = task.completed ? 0 : 1;
          render();
        }
      }

      function deleteTask(id) {
        db.tasks = db.tasks.filter(t => t.id !== id);
        db.task_tags = db.task_tags.filter(tt => tt.task_id !== id);
        render();
      }

      document.getElementById("add-task-btn").onclick = () => {
        const titleInput = document.getElementById("task-title");
        const projSelect = document.getElementById("task-project");
        const prioritySelect = document.getElementById("task-priority");
        const tagsInput = document.getElementById("task-tags");

        const title = titleInput.value.trim();
        if (!title) return;

        const projectId = Number(projSelect.value);
        const priority = prioritySelect.value;
        const newTaskId = (db.tasks.reduce((max, t) => Math.max(max, t.id), 0) || 0) + 1;

        db.tasks.push({
          id: newTaskId,
          project_id: projectId,
          title,
          priority,
          completed: 0
        });

        const tagNames = tagsInput.value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        tagNames.forEach(name => {
          let tag = db.tags.find(t => t.name === name);
          if (!tag) {
            tag = { id: (db.tags.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1, name };
            db.tags.push(tag);
          }
          db.task_tags.push({ task_id: newTaskId, tag_id: tag.id });
        });

        titleInput.value = "";
        tagsInput.value = "";
        render();
      };

      document.getElementById("add-proj-btn").onclick = () => {
        const nameInput = document.getElementById("new-proj-name");
        const colorInput = document.getElementById("new-proj-color");
        const name = nameInput.value.trim();
        if (!name) return;

        const id = (db.projects.reduce((m, p) => Math.max(m, p.id), 0) || 0) + 1;
        db.projects.push({ id, name, color: colorInput.value });
        nameInput.value = "";
        render();
      };

      document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          statusFilter = btn.dataset.status;
          render();
        };
      });

      document.getElementById("sort-select").onchange = (e) => {
        sortBy = e.target.value;
        render();
      };

      document.getElementById("save-btn").onclick = async () => {
        if (window.dai && window.dai.saveState) {
          const dbBytes = new TextEncoder().encode(JSON.stringify(db, null, 2));
          const res = await window.dai.saveState(dbBytes);
          const method = res && res.method ? res.method : "default";
          showToast(\`Saved successfully via \${method.toUpperCase()}\`);
        } else {
          showToast("Saved locally");
        }
      };

      function escapeHtml(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }

      function render() {
        renderProjects();
        renderTasks();
        updateBadge();
      }

      render();
    </script>
  </body>
</html>
`;

console.log("Sealing tasks.dai.html container...");

const built = await buildContainer({
  files: {
    "index.html": new TextEncoder().encode(indexHtml),
  },
  template,
  runtime,
  appName: "Task & Project Console",
  favicon: taskFavicon,
  signingKey: keyPair,
});

const containerPath = resolve(root, "tasks.dai.html");
const runnerPublicPath = resolve(root, "apps/runner/public/tasks.dai.html");

writeFileSync(containerPath, built.html, "utf8");
writeFileSync(runnerPublicPath, built.html, "utf8");

// Generate companion Windows launcher
const launchers = buildLaunchers("tasks.dai.html");
const batPath = resolve(root, "tasks-launcher.bat");
writeFileSync(batPath, launchers.bat, "utf8");

const sizeBytes = Buffer.byteLength(built.html, "utf8");

console.log("\n✅ Cartridge Minting Complete!");
console.log("----------------------------------------");
console.log(`Cartridge File : ${containerPath}`);
console.log(`Launcher File  : ${batPath}`);
console.log(`File Size      : ${sizeBytes} bytes (${(sizeBytes / 1024).toFixed(2)} KB)`);
console.log(`Document UUID  : ${built.documentUuid}`);
console.log(`Fingerprint    : ${built.publicKeyFingerprint}`);
console.log("----------------------------------------");
