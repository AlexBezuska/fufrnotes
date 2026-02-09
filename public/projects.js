// Projects + todo list UI (single list per project)
// This file is loaded after app.js and integrates with the existing Notes functions when available.

const $p = (sel) => document.querySelector(sel);

function projectsLogApiError(context, e) {
  try {
    console.groupCollapsed(`[projects] ${context} failed`);
    console.log(e);
    console.groupEnd();
  } catch {
  }
}

function projectsFormatApiError(e) {
  const status = e?.status;
  const code = e?.data?.error || e?.message;
  if (status && code) return `${code} (HTTP ${status})`;
  if (status) return `HTTP ${status}`;
  return code || "error";
}

async function projectsApiFetchQ(action, query, opts) {
  const apiFetchQ = globalThis.apiFetchQ;
  if (typeof apiFetchQ === "function") return await apiFetchQ(action, query, opts);

  const qs = new URLSearchParams({ action: String(action) });
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
  }

  const url = `/api?${qs.toString()}`;
  const { method = "GET", body = null } = opts || {};
  const fetchOpts = { method, credentials: "include", headers: {} };
  if (body != null) {
    fetchOpts.headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  }
  const r = await fetch(url, fetchOpts);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
  if (!r.ok) {
    const err = new Error((data && data.error) || `http_${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

const projectsState = {
  view: "notes",
  projects: [],
  currentProject: null,
  todos: [],
};

function setProjectAlert(text, { variant = "info" } = {}) {
  const el = $p("#projectAlert");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("ui-alert-success", "ui-alert-warning", "ui-alert-danger", "ui-alert-info");
    el.classList.add("ui-alert-info");
    return;
  }
  el.textContent = String(text);
  el.classList.remove("hidden");
  el.classList.remove("ui-alert-success", "ui-alert-warning", "ui-alert-danger", "ui-alert-info");
  el.classList.add(
    variant === "success"
      ? "ui-alert-success"
      : variant === "warning"
        ? "ui-alert-warning"
        : variant === "danger"
          ? "ui-alert-danger"
          : "ui-alert-info",
  );
}

function showEl(el) {
  if (!el) return;
  el.classList.remove("hidden");
  el.style.display = "";
}

function hideEl(el) {
  if (!el) return;
  el.classList.add("hidden");
  el.style.display = "none";
}

function setView(view) {
  projectsState.view = view === "projects" ? "projects" : "notes";

  const notesBtn = $p("#navNotesBtn");
  const projectsBtn = $p("#navProjectsBtn");
  const notesView = $p("#notesView");
  const projectsView = $p("#projectsView");
  const sidebarToggleBtn = $p("#toggleSidebarBtn");

  if (projectsState.view === "notes") {
    notesBtn?.classList?.add("is-active");
    notesBtn?.setAttribute?.("aria-current", "page");
    projectsBtn?.classList?.remove?.("is-active");
    projectsBtn?.removeAttribute?.("aria-current");
    showEl(notesView);
    hideEl(projectsView);
    showEl(sidebarToggleBtn);
    return;
  }

  projectsBtn?.classList?.add("is-active");
  projectsBtn?.setAttribute?.("aria-current", "page");
  notesBtn?.classList?.remove?.("is-active");
  notesBtn?.removeAttribute?.("aria-current");
  showEl(projectsView);
  hideEl(notesView);
  hideEl(sidebarToggleBtn);

  try {
    globalThis.closeSidebar?.();
  } catch {
  }
}

async function refreshProjectsList() {
  const data = await projectsApiFetchQ("projects_list", {}, { method: "GET" });
  projectsState.projects = data.projects || [];
  renderProjectsSelect();
}

function renderProjectsSelect() {
  const sel = $p("#projectSelect");
  if (!sel) return;
  sel.innerHTML = "";

  const emptyState = $p("#projectsEmptyState");

  if (!projectsState.projects.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No projects";
    sel.appendChild(opt);
    sel.disabled = true;
    emptyState?.classList?.remove?.("hidden");
    return;
  }

  emptyState?.classList?.add?.("hidden");
  sel.disabled = false;

  for (const p of projectsState.projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    const due = p.dueAt ? ` (due ${String(p.dueAt).slice(0, 10)})` : "";
    opt.textContent = `${p.title || "(untitled)"}${due}`;
    sel.appendChild(opt);
  }

  const cur = projectsState.currentProject?.id;
  if (cur) sel.value = cur;
  else sel.value = projectsState.projects[0]?.id || "";
}

function setProjectFieldsFromCurrent() {
  const p = projectsState.currentProject;
  const titleEl = $p("#projectTitleInput");
  const dueEl = $p("#projectDueInput");
  const descEl = $p("#projectDescInput");
  if (titleEl) titleEl.value = p?.title || "";
  if (dueEl) dueEl.value = p?.dueAt ? String(p.dueAt).slice(0, 10) : "";
  if (descEl) descEl.value = p?.description || "";
}

async function openProject(id) {
  if (!id) {
    projectsState.currentProject = null;
    projectsState.todos = [];
    setProjectFieldsFromCurrent();
    renderProjectTodos();
    return;
  }

  const data = await projectsApiFetchQ("projects_get", { id }, { method: "GET" });
  projectsState.currentProject = data.project || null;
  projectsState.todos = data.todos || [];
  setProjectFieldsFromCurrent();
  renderProjectTodos();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderProjectTodos() {
  const wrap = $p("#projectTodos");
  if (!wrap) return;
  wrap.innerHTML = "";

  if (!projectsState.currentProject) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-slate-500";
    empty.textContent = "Create or select a project to add todo items.";
    wrap.appendChild(empty);
    return;
  }

  if (!projectsState.todos.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-slate-500";
    empty.textContent = "No items yet.";
    wrap.appendChild(empty);
    return;
  }

  const rows = document.createElement("div");
  rows.className = "flex flex-col";
  wrap.appendChild(rows);

  for (const t of projectsState.todos) {
    const row = document.createElement("div");
    row.className = "border-b ui-divider py-2";
    const due = t.dueAt ? String(t.dueAt).slice(0, 10) : "";
    const hasNote = !!(t.linkedNoteId && String(t.linkedNoteId).trim());
    row.innerHTML = `
      <div class="flex items-center gap-2">
        <input data-pt-done="${escapeHtml(t.id)}" class="ui-checkbox ui-focus" type="checkbox" ${t.done ? "checked" : ""} />
        <input data-pt-title="${escapeHtml(t.id)}" type="text" class="flex-1 ui-input ui-focus text-base md:text-sm" value="${escapeHtml(t.title || "")}" placeholder="Todo" />
        <input data-pt-due="${escapeHtml(t.id)}" type="date" class="ui-input ui-focus text-base md:text-sm" value="${escapeHtml(due)}" />
        <button data-pt-note="${escapeHtml(t.id)}" class="ui-btn">${hasNote ? "Open note" : "Add note"}</button>
      </div>
    `;
    rows.appendChild(row);
  }

  rows.querySelectorAll("[data-pt-done]").forEach((el) => {
    el.addEventListener("change", async () => {
      const todoId = el.getAttribute("data-pt-done") || "";
      const done = !!el.checked;
      try {
        await projectsApiFetchQ("project_todos_update", { id: todoId }, { method: "POST", body: { done } });
      } catch (e) {
        projectsLogApiError("todo_done", e);
        setProjectAlert(`Update failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
      }
    });
  });

  rows.querySelectorAll("[data-pt-title]").forEach((el) => {
    el.addEventListener("blur", async () => {
      const todoId = el.getAttribute("data-pt-title") || "";
      const title = String(el.value || "").trim();
      try {
        await projectsApiFetchQ("project_todos_update", { id: todoId }, { method: "POST", body: { title } });
        // Refresh so the note title can stay in sync.
        await openProject(projectsState.currentProject?.id || "");
      } catch (e) {
        projectsLogApiError("todo_title", e);
        setProjectAlert(`Update failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
      }
    });
  });

  rows.querySelectorAll("[data-pt-due]").forEach((el) => {
    el.addEventListener("change", async () => {
      const todoId = el.getAttribute("data-pt-due") || "";
      const dueAt = String(el.value || "").trim();
      try {
        await projectsApiFetchQ("project_todos_update", { id: todoId }, { method: "POST", body: { dueAt } });
      } catch (e) {
        projectsLogApiError("todo_due", e);
        setProjectAlert(`Update failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
      }
    });
  });

  rows.querySelectorAll("[data-pt-note]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const todoId = btn.getAttribute("data-pt-note") || "";
      const todo = projectsState.todos.find((x) => x.id === todoId);
      const existing = todo?.linkedNoteId ? String(todo.linkedNoteId) : "";
      try {
        let noteId = existing;
        if (!noteId) {
          setProjectAlert("Creating note…");
          const r = await projectsApiFetchQ("project_todos_add_note", { id: todoId }, { method: "POST", body: {} });
          noteId = r?.note?.id || "";
          setProjectAlert("");
          await openProject(projectsState.currentProject?.id || "");
        }
        if (!noteId) throw new Error("note_create_failed");

        if (typeof globalThis.refreshList === "function") await globalThis.refreshList();
        setView("notes");
        if (typeof globalThis.openNote === "function") {
          await globalThis.openNote(noteId);
        }
      } catch (e) {
        projectsLogApiError("todo_note", e);
        setProjectAlert(`Note failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
      }
    });
  });
}

async function createProject() {
  setProjectAlert("Creating project…");
  const created = await projectsApiFetchQ("projects_create", {}, {
    method: "POST",
    body: { title: "Untitled project", dueAt: "", description: "" },
  });
  await refreshProjectsList();
  const id = created?.project?.id || "";
  if (id) {
    const sel = $p("#projectSelect");
    if (sel) sel.value = id;
    await openProject(id);
  }
  setProjectAlert("");
}

async function saveProject() {
  if (!projectsState.currentProject?.id) {
    setProjectAlert("Select or create a project first.", { variant: "warning" });
    return;
  }
  const id = projectsState.currentProject.id;
  const title = String($p("#projectTitleInput")?.value || "").trim();
  const dueAt = String($p("#projectDueInput")?.value || "").trim();
  const description = String($p("#projectDescInput")?.value || "");

  setProjectAlert("Saving project…");
  await projectsApiFetchQ("projects_update", { id }, { method: "POST", body: { title, dueAt, description } });
  await refreshProjectsList();
  await openProject(id);
  setProjectAlert("Saved.", { variant: "success" });
  setTimeout(() => setProjectAlert(""), 900);
}

async function addTodo() {
  if (!projectsState.currentProject?.id) {
    setProjectAlert("Select or create a project first.", { variant: "warning" });
    return;
  }
  const projectId = projectsState.currentProject.id;
  const title = String($p("#newTodoTitleInput")?.value || "").trim();
  const dueAt = String($p("#newTodoDueInput")?.value || "").trim();

  setProjectAlert("Adding item…");
  await projectsApiFetchQ("project_todos_create", { projectId }, { method: "POST", body: { title, dueAt } });
  const t = $p("#newTodoTitleInput");
  const d = $p("#newTodoDueInput");
  if (t) t.value = "";
  if (d) d.value = "";
  await openProject(projectId);
  setProjectAlert("");
}

function wireProjectsUi() {
  $p("#navNotesBtn")?.addEventListener?.("click", () => setView("notes"));
  $p("#navProjectsBtn")?.addEventListener?.("click", async () => {
    setView("projects");
    try {
      await refreshProjectsList();
      const sel = $p("#projectSelect");
      const firstId = sel && !sel.disabled ? String(sel.value || "") : "";
      if (firstId) await openProject(firstId);
      else await openProject("");
    } catch (e) {
      projectsLogApiError("projects_init", e);
      setProjectAlert(`Could not load projects: ${projectsFormatApiError(e)}`, { variant: "danger" });
    }
  });

  $p("#projectSelect")?.addEventListener?.("change", async () => {
    const id = String($p("#projectSelect")?.value || "");
    if (!id) return;
    try {
      await openProject(id);
    } catch (e) {
      projectsLogApiError("project_open", e);
      setProjectAlert(`Could not open project: ${projectsFormatApiError(e)}`, { variant: "danger" });
    }
  });

  $p("#projectNewBtn")?.addEventListener?.("click", async () => {
    try {
      await createProject();
    } catch (e) {
      projectsLogApiError("project_create", e);
      setProjectAlert(`Create failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
    }
  });

  $p("#projectEmptyCreateBtn")?.addEventListener?.("click", async () => {
    try {
      await createProject();
    } catch (e) {
      projectsLogApiError("project_create", e);
      setProjectAlert(`Create failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
    }
  });

  $p("#projectSaveBtn")?.addEventListener?.("click", async () => {
    try {
      await saveProject();
    } catch (e) {
      projectsLogApiError("project_save", e);
      setProjectAlert(`Save failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
    }
  });

  $p("#newTodoAddBtn")?.addEventListener?.("click", async () => {
    try {
      await addTodo();
    } catch (e) {
      projectsLogApiError("todo_add", e);
      setProjectAlert(`Add failed: ${projectsFormatApiError(e)}`, { variant: "danger" });
    }
  });

  // Default view is Notes.
  setView("notes");
}

window.addEventListener("DOMContentLoaded", () => {
  try {
    wireProjectsUi();
  } catch (e) {
    projectsLogApiError("wire", e);
  }
});
