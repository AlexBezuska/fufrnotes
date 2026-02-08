const $ = (sel) => document.querySelector(sel);

const API_TIMEOUT_MS = 15000;

const state = {
  authed: false,
  notes: [],
  current: null,
  dirty: false,
  saving: false,
  pendingSave: false,
  saveAbort: null,
  saveTimer: null,
  periodicTimer: null,
  sidebarOpen: false,
  conflict: null,
  saveFrozen: false,
  previewForced: false,
};

function isMdUp() {
  return window.matchMedia("(min-width: 768px)").matches;
}

function isLgUp() {
  return window.matchMedia("(min-width: 1024px)").matches;
}

function isDebugEnabled() {
  try {
    return localStorage.getItem("notes_debug") === "1";
  } catch {
    return false;
  }
}

function logApiError(context, e) {
  const status = e?.status;
  const data = e?.data;
  const req = e?.request;
  try {
    console.groupCollapsed(`[notes] ${context} failed${status ? ` (HTTP ${status})` : ""}`);
    if (req) console.log("request:", req);
    if (data) console.log("response:", data);
    console.log("error:", e);
    console.groupEnd();
  } catch {
  }
}

function setBanner(text) {
  const el = $("#banner");
  if (!text) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = text;
  el.classList.remove("hidden");
}

function setLockError(text) {
  setLockAlert(text ? { variant: "danger", text, role: "alert" } : null);
}

function setLockAlert(alert) {
  const el = $("#lockAlert");
  if (!el) return;
  if (!alert || !alert.text) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("ui-alert-success", "ui-alert-warning", "ui-alert-danger", "ui-alert-info");
    el.classList.add("ui-alert-info");
    el.removeAttribute("role");
    return;
  }

  const variant = alert.variant || "info";
  el.textContent = String(alert.text);
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
  if (alert.role) el.setAttribute("role", String(alert.role));
  else el.removeAttribute("role");
}

function setLockStage(stage, { email } = {}) {
  const emailWrap = $("#emailWrap");
  const emailInput = $("#emailInput");
  const loginAsWrap = $("#loginAsWrap");
  const loginAsEmail = $("#loginAsEmail");
  const codeWrap = $("#codeWrap");
  const codeInput = $("#codeInput");
  const unlockBtn = $("#unlockBtn");
  const hint = $("#lockHint");
  const altNote = $("#lockAltNote");

  if (stage === "email") {
    if (emailWrap) emailWrap.classList.remove("hidden");
    if (loginAsWrap) loginAsWrap.classList.add("hidden");
    if (codeWrap) codeWrap.classList.add("hidden");
    if (altNote) altNote.classList.add("hidden");
    if (unlockBtn) unlockBtn.textContent = "Log in";
    if (emailInput) emailInput.disabled = false;
    if (codeInput) codeInput.disabled = true;
    if (hint) hint.textContent = "If you don’t have an account yet, entering your email will create one.";
    return;
  }

  if (stage === "code") {
    if (emailWrap) emailWrap.classList.add("hidden");
    if (loginAsWrap) loginAsWrap.classList.remove("hidden");
    if (loginAsEmail) loginAsEmail.textContent = email ? String(email) : "";
    if (codeWrap) codeWrap.classList.remove("hidden");
    if (altNote) altNote.classList.remove("hidden");
    if (unlockBtn) unlockBtn.textContent = "Submit code from email";
    if (emailInput) emailInput.disabled = true;
    if (codeInput) codeInput.disabled = false;
    if (hint) hint.textContent = "Paste the code from your email, then press “Submit code from email”.";
    return;
  }
}

function setStatus(text) {
  $("#saveStatus").textContent = text;
}

async function apiFetch(action, { method = "GET", body = null, isForm = false } = {}) {
  const url = (() => {
    const qs = new URLSearchParams({ action: String(action) });
    return `/api?${qs.toString()}`;
  })();

  if (isDebugEnabled()) {
    console.debug("[notes] api", { action, method, url });
  }
  const opts = {
    method,
    credentials: "include",
    headers: {},
  };

  if (body != null) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  opts.signal = controller.signal;

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(t);
    if (e && (e.name === "AbortError" || e.code === 20)) {
      const err = new Error("timeout");
      err.status = 0;
      err.data = { ok: false, error: "timeout" };
      err.request = { action, method, url };
      throw err;
    }
    throw e;
  }
  clearTimeout(t);

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    const text = await res.text().catch(() => "");
    const snippet = (text || "").slice(0, 200).replace(/\s+/g, " ").trim();
    const err = new Error(`non_json_response`);
    err.status = res.status;
    err.data = { error: "non_json_response", contentType, snippet };
    err.request = { action, method, url };
    throw err;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error((data && data.error) || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    err.request = { action, method, url };
    throw err;
  }

  return data;
}

async function apiFetchQ(action, query, opts) {
  const qs = new URLSearchParams({ action: String(action) });
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
  }

  const url = `/api?${qs.toString()}`;
  const { method = "GET", body = null, isForm = false, signal = null, timeoutMs = API_TIMEOUT_MS } = opts || {};

  if (isDebugEnabled()) {
    console.debug("[notes] api", { action, method, url, query });
  }

  const fetchOpts = {
    method,
    credentials: "include",
    headers: {},
  };

  if (body != null) {
    if (isForm) {
      fetchOpts.body = body;
    } else {
      fetchOpts.headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(body);
    }
  }

  const controller = signal ? null : new AbortController();
  const effectiveSignal = signal || controller.signal;
  fetchOpts.signal = effectiveSignal;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (e) {
    if (t) clearTimeout(t);
    if (e && (e.name === "AbortError" || e.code === 20)) {
      const err = new Error("timeout");
      err.status = 0;
      err.data = { ok: false, error: "timeout" };
      err.request = { action, method, url, query };
      throw err;
    }
    throw e;
  }
  if (t) clearTimeout(t);
  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    const text = await res.text().catch(() => "");
    const snippet = (text || "").slice(0, 200).replace(/\s+/g, " ").trim();
    const err = new Error(`non_json_response`);
    err.status = res.status;
    err.data = { error: "non_json_response", contentType, snippet };
    err.request = { action, method, url, query };
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error) || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    err.request = { action, method, url, query };
    throw err;
  }
  return data;
}

function formatApiError(e) {
  const status = e?.status;
  const code = e?.data?.error || e?.message;
  if (status && code) return `${code} (HTTP ${status})`;
  if (status) return `HTTP ${status}`;
  return code || "error";
}

function showLock() {
  $("#mainScreen").classList.add("hidden");
  $("#lockScreen").classList.remove("hidden");
  try {
    $("#emailInput")?.focus?.();
  } catch {
  }
}

function showMain() {
  $("#lockScreen").classList.add("hidden");
  $("#mainScreen").classList.remove("hidden");
  if (!isMdUp() && !state.current) {
    openSidebar();
  } else {
    closeSidebar();
  }
}

function openSidebar() {
  state.sidebarOpen = true;
  const sidebar = $("#sidebar");
  const notePane = $("#notePane");
  sidebar.classList.remove("hidden");
  sidebar.classList.add("absolute");
  sidebar.classList.add("z-20");
  if (!isMdUp()) {
    notePane.classList.add("hidden");
  }
}

function closeSidebar() {
  state.sidebarOpen = false;
  const sidebar = $("#sidebar");
  const notePane = $("#notePane");
  if (isMdUp()) {
    sidebar.classList.remove("hidden");
    sidebar.classList.remove("absolute");
    sidebar.classList.remove("z-20");
    notePane.classList.remove("hidden");
  } else {
    if (state.current) {
      sidebar.classList.add("hidden");
      notePane.classList.remove("hidden");
    } else {
      openSidebar();
    }
  }
}

function toggleSidebar() {
  if (state.sidebarOpen) closeSidebar();
  else openSidebar();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineFormat(text) {
  let t = text;
  t = t.replace(/`([^`]+)`/g, (_m, code) => `<code class="px-1 py-0.5 rounded bg-slate-900 border border-slate-800">${code}</code>`);
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const safeUrl = url.replace(/\s/g, "");
    return `<img alt="${alt}" src="${safeUrl}" class="max-w-full rounded border border-slate-800" />`;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const safeUrl = url.replace(/\s/g, "");
    return `<a class="text-sky-300 underline" href="${safeUrl}" target="_blank" rel="noopener">${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
  t = t.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, (_m, p1, i) => `${p1}<em>${i}</em>`);
  return t;
}

function renderMarkdown(md) {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";

  const listStack = [];

  const closeAllLists = () => {
    while (listStack.length) {
      const top = listStack[listStack.length - 1];
      if (top.openLi) {
        out.push(`</li>`);
        top.openLi = false;
      }
      out.push(`</${top.type}>`);
      listStack.pop();
    }
  };

  const computeIndent = (rawLine) => {
    let indent = 0;
    for (let j = 0; j < rawLine.length; j++) {
      const ch = rawLine[j];
      if (ch === " ") indent += 1;
      else if (ch === "\t") indent += 4;
      else break;
    }
    return indent;
  };

  const openList = (type, indent) => {
    out.push(`<${type} class="${type === "ul" ? "list-disc" : "list-decimal"} ml-5">`);
    listStack.push({ type, indent, openLi: false });
  };

  const ensureListLevel = (type, indent) => {
    if (listStack.length === 0) {
      openList(type, indent);
      return;
    }

    while (listStack.length && indent < listStack[listStack.length - 1].indent) {
      const top = listStack[listStack.length - 1];
      if (top.openLi) {
        out.push(`</li>`);
        top.openLi = false;
      }
      out.push(`</${top.type}>`);
      listStack.pop();
    }

    if (listStack.length === 0) {
      openList(type, indent);
      return;
    }

    const top = listStack[listStack.length - 1];
    if (indent > top.indent) {
      if (!top.openLi) {
        out.push(`<li class="my-1">`);
        top.openLi = true;
      }
      openList(type, indent);
      return;
    }

    if (top.type !== type) {
      if (top.openLi) {
        out.push(`</li>`);
        top.openLi = false;
      }
      out.push(`</${top.type}>`);
      listStack.pop();
      openList(type, indent);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (raw.startsWith("```")) {
      if (!inCode) {
        closeAllLists();
        inCode = true;
        codeLang = raw.slice(3).trim();
        out.push(`<pre class="p-3 rounded bg-slate-900 border border-slate-800 overflow-auto"><code data-lang="${escapeHtml(codeLang)}">`);
      } else {
        inCode = false;
        out.push(`</code></pre>`);
      }
      continue;
    }

    if (inCode) {
      out.push(escapeHtml(raw) + "\n");
      continue;
    }

    if (!raw.trim()) {
      closeAllLists();
      out.push(`<div class="h-2"></div>`);
      continue;
    }

    const indent = computeIndent(raw);
    const rest = raw.replace(/^[ \t]+/, "");

    if (indent === 0) {
      const h = rest.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        closeAllLists();
        const level = h[1].length;
        const text = inlineFormat(escapeHtml(h[2]));
        const cls = level === 1 ? "text-2xl font-semibold" : level === 2 ? "text-xl font-semibold" : "text-lg font-semibold";
        out.push(`<h${level} class="${cls} mt-2 mb-2">${text}</h${level}>`);
        continue;
      }
    }

    if (indent === 0) {
      const bq = rest.match(/^>\s?(.*)$/);
      if (bq) {
        closeAllLists();
        out.push(`<blockquote class="border-l-2 border-slate-700 pl-3 text-slate-200">${inlineFormat(escapeHtml(bq[1]))}</blockquote>`);
        continue;
      }
    }

    const ul = rest.match(/^[-*]\s+(.*)$/);
    if (ul) {
      ensureListLevel("ul", indent);
      const top = listStack[listStack.length - 1];
      if (top.openLi) out.push(`</li>`);
      out.push(`<li class="my-1">${inlineFormat(escapeHtml(ul[1]))}`);
      top.openLi = true;
      continue;
    }
    const ol = rest.match(/^([0-9]+)\.\s+(.*)$/);
    if (ol) {
      ensureListLevel("ol", indent);
      const top = listStack[listStack.length - 1];
      if (top.openLi) out.push(`</li>`);
      out.push(`<li class="my-1">${inlineFormat(escapeHtml(ol[2]))}`);
      top.openLi = true;
      continue;
    }

    if (listStack.length) {
      const top = listStack[listStack.length - 1];
      if (indent > top.indent && top.openLi) {
        out.push(`<div class="my-1">${inlineFormat(escapeHtml(rest))}</div>`);
        continue;
      }
    }

    closeAllLists();
    out.push(`<p class="my-2">${inlineFormat(escapeHtml(raw))}</p>`);
  }

  closeAllLists();
  if (inCode) out.push(`</code></pre>`);

  return out.join("\n");
}

function updatePreview() {
  const md = $("#editor").value;
  $("#previewInner").innerHTML = renderMarkdown(md);
}

function setPreviewVisible(visible) {
  if (isLgUp()) {
    state.previewForced = true;
    visible = true;
  }

  const preview = $("#preview");
  const editor = $("#editor");
  if (visible) {
    preview.classList.remove("hidden");
    updatePreview();
    if (isLgUp()) {
      editor.classList.remove("hidden");
      $("#previewToggle").textContent = "Preview";
      $("#previewToggle").disabled = true;
    } else {
      editor.classList.add("hidden");
      $("#previewToggle").textContent = "Edit";
      $("#previewToggle").disabled = false;
    }
  } else {
    preview.classList.add("hidden");
    editor.classList.remove("hidden");
    $("#previewToggle").textContent = "Preview";
    $("#previewToggle").disabled = false;
    try {
      editor.focus();
    } catch {
    }
  }
}

function formatUpdatedAt(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function renderNotesList() {
  const q = ($("#searchInput").value || "").toLowerCase();
  const list = $("#notesList");
  list.innerHTML = "";

  const filtered = state.notes.filter((n) => {
    if (!q) return true;
    return (n.title || "").toLowerCase().includes(q) || (n.id || "").toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "p-4 text-sm text-slate-400";
    empty.textContent = "No notes.";
    list.appendChild(empty);
    return;
  }

  for (const n of filtered) {
    const btn = document.createElement("button");
    const active = state.current && state.current.id === n.id;
    btn.className = `ui-note-item ${active ? "is-active" : ""}`;
    btn.innerHTML = `
      <div class="font-medium text-slate-900 truncate">${escapeHtml(n.title || "(untitled)")}</div>
      <div class="text-xs text-slate-600 mt-1">${escapeHtml(formatUpdatedAt(n.updatedAt))}</div>
      <div class="text-[10px] text-slate-500 mt-1">rev ${n.revision}</div>
    `;
    btn.addEventListener("click", async () => {
      await openNote(n.id);
      closeSidebar();
    });
    list.appendChild(btn);
  }
}

async function refreshCurrentFromServer({ confirmIfDirty = true } = {}) {
  if (!state.current) return;
  const id = state.current.id;

  if (state.dirty && confirmIfDirty) {
    const ok = confirm("Discard unsaved changes and reload from server?");
    if (!ok) return;
  }

  let data;
  try {
    data = await apiFetchQ("get", { id }, { method: "GET" });
  } catch (e) {
    logApiError("refresh_note", e);
    setBanner(`Refresh failed: ${formatApiError(e)}`);
    return;
  }

  state.current.meta = data.meta;
  state.current.baseRevision = data.meta.revision;
  state.current.content = data.content || "";
  $("#titleInput").value = state.current.meta.title || "";
  $("#editor").value = state.current.content;
  state.dirty = false;
  setStatus("Saved");
  if (!$("#preview").classList.contains("hidden")) updatePreview();
  renderNotesList();
}

async function refreshAll() {
  setBanner("");
  try {
    await refreshList();
    if (state.current) {
      await refreshCurrentFromServer({ confirmIfDirty: true });
    }
  } catch (e) {
    logApiError("refresh", e);
    setBanner(`Refresh failed: ${formatApiError(e)}`);
  }
}

async function refreshList() {
  const data = await apiFetch("list");
  state.notes = data.notes || [];
  renderNotesList();
}

function markDirty() {
  if (state.saveFrozen) return;
  state.dirty = true;
  setStatus("Saving…");
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    void saveNow(false);
  }, 800);
}

function freezeAutosave(reason) {
  state.saveFrozen = true;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = null;
  setBanner(reason || "Autosave paused.");
}

function unfreezeAutosave() {
  state.saveFrozen = false;
  setBanner("");
}

async function openNote(id) {
  setBanner("");
  unfreezeAutosave();
  state.conflict = null;
  state.current = null;
  $("#titleInput").value = "";
  $("#editor").value = "";
  setPreviewVisible(false);
  setStatus("Saved");

  let data;
  try {
    data = await apiFetchQ("get", { id }, { method: "GET" });
  } catch (e) {
    logApiError("open", e);
    setBanner(`Open failed: ${formatApiError(e)}`);
    setStatus("Error");
    throw e;
  }
  state.current = {
    id,
    meta: data.meta,
    content: data.content || "",
    baseRevision: data.meta.revision,
  };
  $("#titleInput").value = state.current.meta.title || "";
  $("#editor").value = state.current.content;
  state.dirty = false;
  renderNotesList();

  if (!$("#preview").classList.contains("hidden")) updatePreview();

  if (!isMdUp()) closeSidebar();

  if (!state.periodicTimer) {
    state.periodicTimer = setInterval(() => {
      if (!state.saveFrozen && state.dirty) void saveNow(false);
    }, 20000);
  }
}

async function createNote() {
  setBanner("");
  try {
    const data = await apiFetch("create", { method: "POST", body: { title: "Untitled" } });
    await refreshList();
    await openNote(data.meta.id);
  } catch (e) {
    logApiError("create", e);
    setBanner(`Create failed: ${formatApiError(e)}`);
    setStatus("Error");
    throw e;
  }
}

async function saveNow(force) {
  if (state.saveFrozen) return;
  const title = $("#titleInput").value || "";
  const content = $("#editor").value || "";

  if (!state.current) {
    if (!title.trim() && !content.trim()) {
      state.dirty = false;
      setStatus("Saved");
      return;
    }
  }
  if (!state.dirty && !force) {
    setStatus("Saved");
    return;
  }

  if (state.saving) {
    state.pendingSave = true;
    return;
  }

  state.saving = true;
  state.pendingSave = false;
  setStatus("Saving…");

  if (!state.current) {
    try {
      const created = await apiFetch("create", { method: "POST", body: { title: title.trim() || "Untitled" } });
      const meta = created?.meta;
      if (!meta || !meta.id) throw new Error("create_failed");
      state.current = {
        id: meta.id,
        meta,
        content,
        baseRevision: meta.revision,
      };
      state.dirty = true;
      renderNotesList();
    } catch (e) {
      logApiError("create", e);
      setBanner(`Create failed: ${formatApiError(e)}`);
      setStatus("Error");
      state.saving = false;
      return;
    }
  }

  const id = state.current.id;

  try {
    state.saveAbort?.abort();
  } catch {
  }
  const controller = new AbortController();
  state.saveAbort = controller;

  try {
    const data = await apiFetchQ(
      "save",
      { id },
      {
        method: "POST",
        signal: controller.signal,
        timeoutMs: 25000,
        body: {
          title,
          content,
          baseRevision: state.current.baseRevision,
          force: !!force,
        },
      }
    );

    state.current.meta = data.meta;
    state.current.baseRevision = data.meta.revision;
    state.dirty = false;
    state.saving = false;
    setStatus("Saved");
    await refreshList();

    if (!$("#preview").classList.contains("hidden")) updatePreview();
  } catch (e) {
    state.saving = false;

    logApiError("save", e);

    if (e && e.status === 409 && e.data && e.data.error === "conflict") {
      state.conflict = { meta: e.data.meta, content: e.data.content };
      freezeAutosave("Conflict: choose how to resolve.");
      setStatus("Conflict");
      showConflictModal();
      return;
    }

    const detail = e?.data?.snippet ? ` ${e.data.snippet}` : "";
    const hint = e?.data?.error === "timeout" ? " Request timed out (server hung or network issue)." : "";
    setBanner(`Save failed: ${formatApiError(e)}.${hint}${detail}`);
    setStatus("Error");
  } finally {
    state.saveAbort = null;
    state.saving = false;
    if (!state.saveFrozen && state.pendingSave && state.current && state.dirty) {
      state.pendingSave = false;
      void saveNow(false);
    }
  }
}

async function deleteCurrent() {
  if (!state.current) return;
  if (!confirm("Delete this note?")) return;
  await apiFetchQ("delete", { id: state.current.id }, { method: "POST", body: {} });
  state.current = null;
  $("#titleInput").value = "";
  $("#editor").value = "";
  setPreviewVisible(false);
  setStatus("Saved");
  await refreshList();
  renderNotesList();
}

function exportCurrent() {
  if (!state.current) return;
  const content = $("#editor").value || "";
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeTitle = (($("#titleInput").value || "note")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")) || "note";
  a.href = url;
  a.download = `${safeTitle}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setButtonLoading(btn, loading, { idleText, loadingText } = {}) {
  if (!btn) return;
  const idle = idleText || btn.getAttribute("data-idle-text") || btn.textContent || "";
  if (!btn.getAttribute("data-idle-text")) {
    btn.setAttribute("data-idle-text", idle);
  }

  btn.disabled = !!loading;
  btn.setAttribute("aria-busy", loading ? "true" : "false");
  btn.textContent = loading ? (loadingText || "Refreshing…") : idle;
}

function setLoadingBarVisible(visible) {
  const bar = $("#loadingBar");
  if (!bar) return;
  if (visible) bar.classList.remove("hidden");
  else bar.classList.add("hidden");
}

async function runHardRefresh() {
  const btn = $("#refreshBtn");
  const prevStatus = $("#saveStatus")?.textContent || "";

  setLoadingBarVisible(true);
  setButtonLoading(btn, true, { loadingText: "Refreshing…" });
  setStatus("Refreshing…");
  try {
    await refreshAll();
  } finally {
    setButtonLoading(btn, false);
    setLoadingBarVisible(false);
    if (prevStatus) setStatus(prevStatus);
    else if (state.dirty) setStatus("Saving…");
    else setStatus("Saved");
  }
}

function setupPullToRefresh() {
  const isCoarse = (() => {
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch {
      return true;
    }
  })();

  if (!isCoarse) return;

  let tracking = false;
  let startY = 0;
  let armed = false;
  const thresholdPx = 80;

  const canStart = (ev) => {
    if (isMdUp()) return false;
    if (!$("#mainScreen") || $("#mainScreen").classList.contains("hidden")) return false;
    if ($("#conflictModal") && !$("#conflictModal").classList.contains("hidden")) return false;

    const t = ev?.target;
    if (t && typeof t.closest === "function") {
      if (t.closest("input, textarea, button, select, a")) return false;
    }

    const scroller = document.scrollingElement || document.documentElement;
    const top = (scroller && scroller.scrollTop) || 0;
    if (top > 0) return false;

    return true;
  };

  window.addEventListener(
    "touchstart",
    (ev) => {
      if (!canStart(ev)) return;
      const y = ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0;
      tracking = true;
      armed = false;
      startY = y;
    },
    { passive: true }
  );

  window.addEventListener(
    "touchmove",
    (ev) => {
      if (!tracking) return;
      const y = ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0;
      const dy = y - startY;
      if (dy > thresholdPx) armed = true;
    },
    { passive: true }
  );

  window.addEventListener(
    "touchend",
    () => {
      if (!tracking) return;
      tracking = false;
      if (!armed) return;
      void runHardRefresh();
    },
    { passive: true }
  );
}

function insertAtCursor(text) {
  const ta = $("#editor");
  const start = ta.selectionStart || 0;
  const end = ta.selectionEnd || 0;
  const val = ta.value;
  ta.value = val.slice(0, start) + text + val.slice(end);
  ta.selectionStart = ta.selectionEnd = start + text.length;
  ta.focus();
  markDirty();
  if (!$("#preview").classList.contains("hidden")) updatePreview();
}

function indentEditorSelection(outdent) {
  const ta = $("#editor");
  if (!ta) return;

  const INDENT = "  ";

  const val = ta.value || "";
  const selStart = ta.selectionStart ?? 0;
  const selEnd = ta.selectionEnd ?? 0;

  const lineStart = val.lastIndexOf("\n", Math.max(0, selStart - 1)) + 1;
  const lineEnd = (() => {
    const idx = val.indexOf("\n", selEnd);
    return idx === -1 ? val.length : idx;
  })();

  const block = val.slice(lineStart, lineEnd);
  const lines = block.split("\n");

  let changed = false;
  let removedFirst = 0;
  let removedTotal = 0;
  const updated = lines.map((line, idx) => {
    if (!outdent) {
      changed = true;
      return INDENT + line;
    }

    const recordRemoval = (count) => {
      changed = true;
      removedTotal += count;
      if (idx === 0) removedFirst += count;
    };

    if (line.startsWith(INDENT)) {
      recordRemoval(INDENT.length);
      return line.slice(INDENT.length);
    }
    if (line.startsWith("\t")) {
      recordRemoval(1);
      return line.slice(1);
    }
    if (line.startsWith("    ")) {
      recordRemoval(4);
      return line.slice(4);
    }
    return line;
  });

  if (!changed) return;

  const newBlock = updated.join("\n");
  ta.value = val.slice(0, lineStart) + newBlock + val.slice(lineEnd);

  if (!outdent) {
    const addedPerLine = INDENT.length;
    ta.selectionStart = selStart + addedPerLine;
    ta.selectionEnd = selEnd + addedPerLine * lines.length;
  } else {
    const newStart = Math.max(lineStart, selStart - removedFirst);
    const newEnd = Math.max(newStart, selEnd - removedTotal);
    ta.selectionStart = newStart;
    ta.selectionEnd = newEnd;
  }

  markDirty();
  if (!$("#preview").classList.contains("hidden")) updatePreview();
}

function insertImageLink() {
  if (!state.current) return;
  setBanner("");
  const url = prompt("Image URL (http/https)");
  if (!url) return;
  const trimmed = String(url).trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    setBanner("Image link must start with http:// or https://");
    return;
  }
  const alt = (prompt("Alt text (optional)") || "image").trim() || "image";
  insertAtCursor(`\n\n![${alt}](${trimmed})\n\n`);
}

function showConflictModal() {
  const modal = $("#conflictModal");
  const details = $("#conflictDetails");
  const srev = state.conflict?.meta?.revision;
  const crev = state.current?.baseRevision;
  details.textContent = `Server revision: ${srev}, your base revision: ${crev}.`;
  modal.classList.remove("hidden");
}

function hideConflictModal() {
  $("#conflictModal").classList.add("hidden");
}

async function resolveUseServer() {
  if (!state.conflict || !state.current) return;
  $("#titleInput").value = state.conflict.meta.title || "";
  $("#editor").value = state.conflict.content || "";
  state.current.meta = state.conflict.meta;
  state.current.baseRevision = state.conflict.meta.revision;
  state.dirty = false;
  state.conflict = null;
  hideConflictModal();
  unfreezeAutosave();
  setStatus("Saved");
  await refreshList();
  renderNotesList();
}

async function resolveOverwriteMine() {
  if (!state.conflict || !state.current) return;
  state.current.baseRevision = state.conflict.meta.revision;
  state.dirty = true;
  hideConflictModal();
  unfreezeAutosave();
  await saveNow(true);
  state.conflict = null;
}

async function resolveSaveCopy() {
  if (!state.current) return;
  const title = $("#titleInput").value || "Untitled";
  const content = $("#editor").value || "";

  const created = await apiFetch("create", { method: "POST", body: { title: `${title} (copy)` } });
  await refreshList();
  await openNote(created.meta.id);
  $("#titleInput").value = `${title} (copy)`;
  $("#editor").value = content;
  state.dirty = true;
  hideConflictModal();
  unfreezeAutosave();
  await saveNow(false);
}

async function logout() {
  try {
    await apiFetch("logout", { method: "POST", body: {} });
  } catch {
  }
  location.reload();
}

async function init() {
  const mq = window.matchMedia("(min-width: 768px)");
  const mqLg = window.matchMedia("(min-width: 1024px)");
  const applySidebar = () => {
    if (mq.matches) {
      $("#sidebar").classList.remove("hidden");
      $("#sidebar").classList.remove("absolute");
      $("#sidebar").classList.remove("z-20");
      state.sidebarOpen = false;
      $("#notePane").classList.remove("hidden");
    } else {
      closeSidebar();
    }
  };
  const applyPreviewPolicy = () => {
    if (mqLg.matches) {
      setPreviewVisible(true);
    } else {
      state.previewForced = false;
      setPreviewVisible(false);
    }
  };

  if (mq.addEventListener) mq.addEventListener("change", applySidebar);
  else mq.addListener(applySidebar);
  if (mqLg.addEventListener) mqLg.addEventListener("change", applyPreviewPolicy);
  else mqLg.addListener(applyPreviewPolicy);
  applySidebar();
  applyPreviewPolicy();

  $("#toggleSidebarBtn").addEventListener("click", toggleSidebar);
  const codeWrap = $("#codeWrap");
  if (codeWrap) codeWrap.classList.add("hidden");
  setLockStage("email");
  $("#emailInput")?.addEventListener?.("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      $("#unlockBtn").click();
    }
  });
  $("#codeInput")?.addEventListener?.("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      $("#unlockBtn").click();
    }
  });

  $("#unlockBtn").addEventListener("click", async () => {
    const unlockBtn = $("#unlockBtn");
    const emailInput = $("#emailInput");
    const codeInput = $("#codeInput");
    const hint = $("#lockHint");
    const setSending = (isSending, { text = "Sending…" } = {}) => {
      if (emailInput) emailInput.disabled = !!isSending;
      if (codeInput) codeInput.disabled = !!isSending;
      if (unlockBtn) unlockBtn.disabled = !!isSending;
      if (unlockBtn && isSending) unlockBtn.textContent = text;
    };

    const email = ($("#emailInput")?.value || "").trim();
    const code = ($("#codeInput")?.value || "").trim();
    setLockError("");

    const canUseCode = !!codeWrap && !codeWrap.classList.contains("hidden");
    if (canUseCode && code) {
      try {
        setLockAlert({ variant: "info", text: "Signing in…" });
        setSending(true, { text: "Signing in…" });
        await fetch("/auth/passhroom/code", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        }).then(async (r) => {
          const ct = r.headers.get("content-type") || "";
          const data = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
          if (!r.ok) {
            const err = new Error((data && data.error) || `http_${r.status}`);
            err.status = r.status;
            err.data = data;
            throw err;
          }
          return data;
        });
        await refreshList();
        setLockAlert(null);
        showMain();
        return;
      } catch (e) {
        setSending(false);
        logApiError("passhroom_code", e);
        setLockError(`Could not sign in: ${formatApiError(e)}`);
        return;
      }
    }

    if (canUseCode && !code) {
      setLockAlert({
        variant: "warning",
        text: "Paste the code from your email, or click the magic link — both options work.",
      });
      return;
    }

    if (!email) {
      try {
        await apiFetch("login", { method: "POST", body: {} });
        await refreshList();
        showMain();
      } catch (e) {
        logApiError("login", e);
        showLock();
        if (e?.status === 401) setLockError("Not authenticated. Enter your email to log in.");
        else setLockError(`Server error: ${formatApiError(e)}`);
      }
      return;
    }

    try {
      setLockAlert({ variant: "info", text: "Sending sign-in email…" });
      if (codeInput) codeInput.value = "";
      setSending(true, { text: "Sending…" });
      const data = await fetch("/auth/passhroom/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }).then(async (r) => {
        const ct = r.headers.get("content-type") || "";
        const data = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
        if (!r.ok) {
          const err = new Error((data && data.error) || `http_${r.status}`);
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });

      if (data && data.cooldown) {
        const text = data.message
          ? String(data.message)
          : "A sign-in email was recently sent. Use the newest email in your inbox.";
        setLockAlert({ variant: "warning", text });
      } else {
        setLockAlert({ variant: "success", text: "Email sent. Check your inbox for a code or magic link." });
      }

      setLockStage("code", { email });

      if (codeInput) {
        codeInput.value = "";
        codeInput.focus();
      }
      setSending(false);
    } catch (e) {
      setSending(false);
      if (hint) hint.textContent = "If you don’t have an account yet, entering your email will create one.";
      logApiError("passhroom_start", e);
      setLockError(`Could not start sign-in: ${formatApiError(e)}`);
    }
  });

  $("#logoutBtn").addEventListener("click", () => void logout());
  $("#refreshBtn").addEventListener("click", async () => {
    await runHardRefresh();
  });
  $("#searchInput").addEventListener("input", renderNotesList);
  $("#newNoteBtn").addEventListener("click", () => void createNote());
  $("#saveBtn").addEventListener("click", () => void saveNow(false));

  $("#editor").addEventListener("input", () => {
    markDirty();
    if (!$("#preview").classList.contains("hidden")) updatePreview();
  });
  $("#editor").addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    ev.preventDefault();
    indentEditorSelection(!!ev.shiftKey);
  });
  $("#editor").addEventListener("focus", () => {
    if (!state.current || state.saveFrozen) return;
    const uiTitle = ($("#titleInput").value || "").trim();
    const metaTitle = String(state.current?.meta?.title || "").trim();
    if (uiTitle !== metaTitle) {
      state.dirty = true;
      void saveNow(false);
    }
    void refreshList().catch(() => {
    });
  });
  $("#editor").addEventListener("blur", () => void saveNow(false));
  $("#titleInput").addEventListener("input", markDirty);
  $("#titleInput").addEventListener("blur", () => void saveNow(false));

  $("#previewToggle").addEventListener("click", () => {
    if (isLgUp()) return;
    const visible = $("#preview").classList.contains("hidden");
    setPreviewVisible(visible);
  });

  $("#deleteBtn").addEventListener("click", () => void deleteCurrent());
  $("#exportBtn").addEventListener("click", exportCurrent);

  $("#insertImageLinkBtn").addEventListener("click", () => insertImageLink());

  $("#conflictUseServer").addEventListener("click", () => void resolveUseServer());
  $("#conflictOverwrite").addEventListener("click", () => void resolveOverwriteMine());
  $("#conflictSaveCopy").addEventListener("click", () => void resolveSaveCopy());
  $("#conflictClose").addEventListener("click", () => hideConflictModal());

  try {
    await refreshList();
    showMain();
  } catch (e) {
    if (e.status === 401) {
      showLock();
      return;
    }
    showLock();
    setLockError(`Server error: ${formatApiError(e)}`);
    return;
  }

  setupPullToRefresh();
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});
