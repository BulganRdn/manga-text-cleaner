"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  pages: [],
  current: null,
  projectName: null,
  meta: {},
  jobPolling: null,
  jobMode: "clean",
  dirty: { mask: false, result: false, texts: false },
  saving: false,
};

const settings = Object.assign(
  { detect: "both", detector: "auto", model: "lama", device: "auto",
    dilate: 6, feather: 3, force: false },
  JSON.parse(localStorage.getItem("mc_settings") || "{}"));

const textDefaults = Object.assign(
  { size: 26, color: "#000000", stroke: 0, strokeColor: "#ffffff",
    font: "arial", bold: true },
  JSON.parse(localStorage.getItem("mc_textdefaults") || "{}"));

function saveSettings() { localStorage.setItem("mc_settings", JSON.stringify(settings)); }
function saveTextDefaults() { localStorage.setItem("mc_textdefaults", JSON.stringify(textDefaults)); }

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

const apiSettings = () => ({
  detect: settings.detect, detector: settings.detector,
  model: settings.model, device: settings.device,
  dilate: +settings.dilate, feather: +settings.feather,
});

function effectiveDevice() {
  if (settings.device === "cuda") return "cuda";
  if (settings.device === "cpu") return "cpu";
  return state.meta.cuda_available ? "cuda" : "cpu";
}

function updateBackendLabel() {
  const dev = effectiveDevice().toUpperCase();
  const inp = settings.model === "lama" && state.meta.lama ? "LaMa" : "OpenCV";
  const det = state.meta.ctd ? "CTD" : "heuristic";
  $("#sb-backend").textContent = `${dev} · ${inp} / ${det}`;
}

function syncDeviceControls() {
  const sel = $("#set-device");
  const cudaOpt = sel.querySelector('option[value="cuda"]');
  const cudaOk = !!state.meta.cuda_available;
  cudaOpt.disabled = !cudaOk;
  if (!["auto", "cpu", "cuda"].includes(settings.device)) {
    settings.device = "auto";
    saveSettings();
  }
  if (settings.device === "cuda" && !cudaOk) {
    settings.device = "auto";
    saveSettings();
  }
  sel.value = settings.device;
  const hint = $("#device-hint");
  hint.textContent = cudaOk ? t("device_hint") : t("device_no_cuda");
  hint.classList.toggle("warn", !cudaOk);
}

function toast(msg, kind = "info", ms = 4200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const errToast = (e) => {
  const key = { folder_not_found: "err_folder", no_images: "err_no_images",
                job_running: "err_job_running", project_exists: "err_project_exists",
                bad_name: "err_bad_name", project_not_found: "err_project_missing",
                folder_required: "err_folder" }[e.message];
  toast(key ? t(key) : t("err_generic", { msg: e.message }), "error");
};

let editor;

function initEditor() {
  editor = new MaskEditor($("#editor-canvas"), {
    onView: (v) => { $("#sb-zoom").textContent = Math.round(v.scale * 100) + "%"; },
    onDirty: (kind) => { state.dirty[kind] = true; },
    onHealStroke: healStroke,
    onTextSelect: onTextSelect,
    onTextChange: syncTextPanel,
    onTextCreate: (x, y) => {
      editor.addText({ x, y, text: t("text_placeholder"), ...textDefaults });
      openTextPanel();
    },
    onColorPick: (hex) => { $("#draw-color").value = hex; },
  });
}

function renderSidebar() {
  const list = $("#page-list");
  list.innerHTML = "";
  state.pages.forEach((p) => {
    const item = document.createElement("div");
    item.className = "page-item" + (p.index === state.current ? " selected" : "");
    item.innerHTML = `
      <img loading="lazy" src="/api/pages/${p.index}/thumb?v=${p.version}" alt="">
      <div class="page-meta">
        <div class="page-name" title="${p.name}">${p.name}</div>
        <div class="page-status"><span class="dot ${p.status}"></span>${t("st_" + p.status)}</div>
      </div>`;
    item.addEventListener("click", () => selectPage(p.index));
    list.appendChild(item);
  });
  $("#page-count").textContent = state.pages.length ? `${state.pages.length} ${t("pages")}` : "";
  const hasPages = state.pages.length > 0;
  $("#btn-detect-all").disabled = !hasPages;
  $("#btn-process").disabled = !hasPages;
  $("#btn-export").disabled = !hasPages;
  $("#btn-add-pages").style.display = hasPages ? "" : "none";
  const sel = $(".page-item.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function patchPages(pages) {
  const changed = [];
  pages.forEach((p) => {
    const old = state.pages[p.index];
    if (!old || old.status !== p.status || old.version !== p.version) changed.push(p);
    state.pages[p.index] = p;
  });
  if (changed.length) renderSidebar();
  return changed;
}

async function saveCurrentPageState() {
  const idx = state.current;
  if (idx === null || state.saving) return;
  state.saving = true;
  try {
    if (state.dirty.mask) {
      const mask = editor.exportMask();
      const p = await api(`/pages/${idx}/mask`, {
        method: "POST", body: JSON.stringify({ mask }) });
      patchPages([p]);
      state.dirty.mask = false;
    }
    if (state.dirty.result) {
      const image = editor.exportResult();
      if (image) {
        const p = await api(`/pages/${idx}/result`, {
          method: "POST", body: JSON.stringify({ image }) });
        patchPages([p]);
      }
      state.dirty.result = false;
    }
    if (state.dirty.texts) {
      await api(`/pages/${idx}/texts`, {
        method: "POST", body: JSON.stringify({ items: editor.texts }) });
      state.dirty.texts = false;
    }
  } catch (e) { errToast(e); }
  finally { state.saving = false; }
}

async function selectPage(index) {
  if (index === null || index === undefined) return;
  const p = state.pages[index];
  if (!p) return;
  if (index !== state.current) await saveCurrentPageState();
  state.current = index;
  state.dirty = { mask: false, result: false, texts: false };
  renderSidebar();
  closeTextPanel();
  $("#canvas-empty").style.display = "none";
  $("#sb-page").textContent = `${index + 1}/${state.pages.length} · ${p.name}`;
  const v = p.version;
  let texts = [];
  try { texts = (await api(`/pages/${index}/texts`)).items; } catch {}
  try {
    await editor.setPage(
      `/api/pages/${index}/original?v=${v}`,
      p.hasResult ? `/api/pages/${index}/result?v=${v}` : null,
      p.hasMask ? `/api/pages/${index}/mask?v=${v}` : null,
      texts);
  } catch (e) {
    toast(t("err_generic", { msg: e.message }), "error");
  }
  api("/project/state", { method: "POST", body: JSON.stringify({ lastPage: index }) }).catch(() => {});
}

function navPage(delta) {
  if (state.current === null || !state.pages.length) return;
  const next = state.current + delta;
  if (next < 0 || next >= state.pages.length) return;
  selectPage(next);
}

async function refreshCurrentResult() {
  const i = state.current;
  if (i === null) return;
  const p = state.pages[i];
  await editor.reloadResult(p.hasResult ? `/api/pages/${i}/result?v=${p.version}` : null);
}

async function refreshProjectList() {
  try {
    const res = await api("/projects");
    const box = $("#project-list");
    box.innerHTML = "";
    if (!res.projects.length) {
      box.innerHTML = `<div class="project-empty">${t("no_projects")}</div>`;
      return;
    }
    res.projects.forEach((p) => {
      const el = document.createElement("div");
      el.className = "project-card";
      const when = new Date(p.modified * 1000).toLocaleDateString();
      el.innerHTML = `
        <img class="pc-cover" loading="lazy" alt=""
             src="/api/projects/${encodeURIComponent(p.name)}/cover">
        <div class="pc-body">
          <div class="project-name" title="${p.name}">${p.name}</div>
          <div class="project-meta">${p.pages} ${t("pages")} · ${when}</div>
        </div>
        <button class="pc-delete" title="${t("delete_project")}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m2 0l-1 14a1 1 0 01-1 1H8a1 1 0 01-1-1L6 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>`;
      el.querySelector(".pc-cover").addEventListener("error",
        (ev) => ev.target.classList.add("noimg"));
      el.addEventListener("click", () => openProjectByName(p.name));
      el.querySelector(".pc-delete").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(t("confirm_delete_project", { name: p.name }))) return;
        try {
          await api(`/projects/${encodeURIComponent(p.name)}`, { method: "DELETE" });
          toast(t("project_deleted"), "info");
          if (state.projectName === p.name) resetToNoProject();
          refreshProjectList();
        } catch (e) { errToast(e); }
      });
      box.appendChild(el);
    });
  } catch {}
}

function resetToNoProject() {
  state.pages = [];
  state.current = null;
  state.projectName = null;
  state.dirty = { mask: false, result: false, texts: false };
  $("#project-info").textContent = "";
  renderSidebar();
  editor.clear();
  $("#canvas-empty").style.display = "flex";
  $("#empty-text").textContent = t("no_page");
}

async function addPages(files) {
  if (!state.pages.length || !files || !files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append("files", f));
  try {
    const res = await fetch("/api/project/pages/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const st = await res.json();
    const curName = state.current !== null && state.pages[state.current]
      ? state.pages[state.current].name : null;
    state.pages = st.pages;
    if (curName) {
      const cur = st.pages.find((p) => p.name === curName);
      state.current = cur ? cur.index : null;
    }
    renderSidebar();
    toast(st.added ? t("pages_added", { n: st.added }) : t("pages_added_none"),
          st.added ? "success" : "warn");
  } catch (e) { errToast(e); }
}

async function openProjectByName(name) {
  try {
    const st = await api(`/projects/${encodeURIComponent(name)}/open`, { method: "POST" });
    onProjectLoaded(st);
  } catch (e) { errToast(e); }
}

async function createProject() {
  const name = $("#project-name").value.trim();
  const path = $("#folder-input").value.trim();
  if (!name) { toast(t("err_bad_name"), "error"); return; }
  if (!path) { toast(t("err_folder"), "error"); return; }
  try {
    const st = await api("/projects", {
      method: "POST", body: JSON.stringify({ name, path }) });
    onProjectLoaded(st);
  } catch (e) { errToast(e); }
}

async function uploadFiles(files) {
  let name = $("#project-name").value.trim();
  if (!name) name = t("untitled_project") + " " + new Date().toISOString().slice(0, 10);
  const fd = new FormData();
  fd.append("name", name);
  [...files].forEach((f) => fd.append("files", f));
  try {
    const res = await fetch("/api/projects/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    onProjectLoaded(await res.json());
  } catch (e) { errToast(e); }
}

function onProjectLoaded(st) {
  state.pages = st.pages;
  state.current = null;
  state.projectName = st.name;
  state.dirty = { mask: false, result: false, texts: false };
  $("#out-input").value = "";
  $("#out-input").placeholder = st.suggestedOutput || "";
  $("#project-info").textContent = st.name ? `📁 ${st.name}` : "";
  closeModal("#modal-open");
  renderSidebar();
  editor.clear();
  $("#canvas-empty").style.display = "flex";
  $("#empty-text").textContent = t("select_page");
  if (st.pages.length) selectPage(Math.min(st.lastPage || 0, st.pages.length - 1));
}

async function startBatch(mode) {
  await saveCurrentPageState();
  try {
    const res = await api("/process", {
      method: "POST",
      body: JSON.stringify({ settings: apiSettings(), force: settings.force, mode }),
    });
    if (res.queued === 0) { toast(t("confirm_reprocess"), "warn"); return; }
    if (mode === "clean" && settings.model === "lama" && state.meta.lama === false) {
      toast(t("lama_missing"), "warn", 7000);
    }
    state.jobMode = mode;
    startJobPolling();
  } catch (e) { errToast(e); }
}

const processAll = () => startBatch("clean");
const detectAll = () => startBatch("detect");

function startJobPolling() {
  if (state.jobPolling) return;
  $("#job-pill").classList.add("active");
  state.jobPolling = setInterval(async () => {
    let j;
    try { j = await api("/job"); } catch { return; }
    $("#job-bar > div").style.width = j.total ? (100 * j.done / j.total) + "%" : "0%";
    $("#job-text").textContent = t("job_progress",
      { done: j.done, total: j.total, current: j.current || "…" });
    const changed = patchPages(j.pages);
    const cur = changed.find((p) => p.index === state.current);
    if (cur && !editor.isBusy && !state.dirty.mask && !state.dirty.result) {
      if (state.jobMode === "detect" && cur.hasMask) {
        editor.setPage(`/api/pages/${cur.index}/original?v=${cur.version}`,
                       cur.hasResult ? `/api/pages/${cur.index}/result?v=${cur.version}` : null,
                       `/api/pages/${cur.index}/mask?v=${cur.version}`, editor.texts);
      } else if (cur.hasResult) {
        refreshCurrentResult();
      }
    }
    if (!j.running) {
      clearInterval(state.jobPolling);
      state.jobPolling = null;
      $("#job-pill").classList.remove("active");
      if (state.jobMode === "detect") {
        toast(j.errors ? t("job_done", { done: j.done, errors: j.errors })
                       : t("masks_ready", { n: j.done }),
              j.errors ? "warn" : "success", 7000);
      } else {
        toast(j.errors ? t("job_done", { done: j.done, errors: j.errors })
                       : t("job_done_ok", { done: j.done }),
              j.errors ? "warn" : "success");
      }
    }
  }, 700);
}

async function detectPage() {
  const i = state.current;
  if (i === null) return;
  try {
    const res = await api(`/pages/${i}/detect`, {
      method: "POST", body: JSON.stringify({ settings: apiSettings() }),
    });
    await editor.setMaskFromDataUrl(res.mask);
    state.dirty.mask = true;
    toast(res.regions ? t("detect_found", { n: res.regions }) : t("detect_none"),
          res.regions ? "info" : "warn");
  } catch (e) { errToast(e); }
}

async function cleanPage() {
  const i = state.current;
  if (i === null) return;
  const mask = editor.exportMask();
  if (!mask) { toast(t("mask_empty"), "warn"); return; }
  const btn = $("#btn-clean");
  btn.disabled = true;
  if (settings.model === "lama" && !state.pages[i].hasResult) {
    toast(t("loading_model"), "info", 6000);
  }
  try {
    const p = await api(`/pages/${i}/clean`, {
      method: "POST", body: JSON.stringify({ settings: apiSettings(), mask }),
    });
    patchPages([p]);
    state.dirty.mask = false;
    state.dirty.result = false;
    await refreshCurrentResult();
    toast(t("cleaned_ok"), "success");
  } catch (e) { errToast(e); }
  finally { btn.disabled = false; }
}

async function healStroke(maskData) {
  const i = state.current;
  if (i === null) return;
  try {
    await saveCurrentPageState();
    const p = await api(`/pages/${i}/heal`, {
      method: "POST", body: JSON.stringify({ settings: apiSettings(), mask: maskData }),
    });
    patchPages([p]);
    await refreshCurrentResult();
  } catch (e) { errToast(e); }
}

async function revertPage() {
  const i = state.current;
  if (i === null) return;
  try {
    const p = await api(`/pages/${i}/revert`, { method: "POST" });
    patchPages([p]);
    state.dirty = { mask: false, result: false, texts: false };
    await selectPage(i);
    toast(t("reverted"), "info");
  } catch (e) { errToast(e); }
}

async function doExport() {
  await saveCurrentPageState();
  const outDir = $("#out-input").value.trim() || null;
  try {
    const res = await api("/export", { method: "POST", body: JSON.stringify({ outDir }) });
    $("#zip-link").style.display = "inline-flex";
    let msg = t("exported", { cleaned: res.cleaned, kept: res.kept, dir: res.outDir });
    if (res.typeset) msg += " " + t("exported_typeset", { n: res.typeset });
    toast(msg, "success", 8000);
  } catch (e) { errToast(e); }
}

function openTextPanel() { $("#text-panel").classList.add("open"); syncTextPanel(); }
function closeTextPanel() { $("#text-panel").classList.remove("open"); }

function onTextSelect(index) {
  if (index === null) { closeTextPanel(); return; }
  openTextPanel();
}

function syncTextPanel() {
  const t0 = editor?.selectedText !== null && editor ? editor.texts[editor.selectedText] : null;
  const src = t0 || textDefaults;
  $("#text-content").value = t0 ? t0.text : "";
  $("#text-size").value = src.size;
  $("#text-color").value = src.color;
  $("#text-stroke").value = src.stroke;
  $("#text-stroke-color").value = src.strokeColor;
  $("#text-font").value = src.font;
  $("#text-bold").checked = !!src.bold;
  $("#text-rotation").value = Math.round(src.rotation || 0);
}

function applyTextPanel(field, value) {
  Object.assign(textDefaults, { [field]: value });
  saveTextDefaults();
  if (editor.selectedText === null) return;
  const item = editor.texts[editor.selectedText];
  item[field] = value;
  state.dirty.texts = true;
  editor.render();
}

function openModal(sel) {
  $(sel).classList.add("open");
  if (sel === "#modal-open") refreshProjectList();
}
function closeModal(sel) { $(sel).classList.remove("open"); }
const anyModalOpen = () => !!$(".modal-backdrop.open");

function setTool(tool) {
  editor.setTool(tool);
  $$("#toolbar .tool[data-tool]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === tool));
  $("#draw-color-wrap").style.display = tool === "draw" ? "flex" : "none";
  if (tool !== "text") closeTextPanel();
}

function bindUI() {
  $$("#toolbar .tool[data-tool]").forEach((b) =>
    b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#btn-undo").addEventListener("click", () => editor.undo());
  $("#btn-redo").addEventListener("click", () => editor.redo());
  $("#btn-detect").addEventListener("click", detectPage);
  $("#btn-clean").addEventListener("click", cleanPage);
  $("#btn-revert").addEventListener("click", revertPage);
  $("#btn-mask-vis").addEventListener("click", () => {
    editor.maskVisible = !editor.maskVisible;
    $("#btn-mask-vis").classList.toggle("active", editor.maskVisible);
    editor.render();
  });
  $("#btn-zoom-in").addEventListener("click", () => editor.zoomBy(1.25));
  $("#btn-zoom-out").addEventListener("click", () => editor.zoomBy(1 / 1.25));
  $("#btn-zoom-fit").addEventListener("click", () => editor.fit());
  $("#btn-zoom-100").addEventListener("click", () => editor.zoom100());

  const compareOn = (on) => {
    editor.showOriginal = on;
    $("#compare-flag").classList.toggle("on", on);
    editor.render();
  };
  const cmpBtn = $("#btn-compare");
  cmpBtn.addEventListener("pointerdown", () => compareOn(true));
  cmpBtn.addEventListener("pointerup", () => compareOn(false));
  cmpBtn.addEventListener("pointerleave", () => compareOn(false));

  $("#brush-size").addEventListener("input", (e) => {
    editor.brushSize = +e.target.value;
    $("#brush-size-val").textContent = e.target.value;
    editor.render();
  });
  $("#mask-opacity").addEventListener("input", (e) => {
    editor.maskOpacity = +e.target.value / 100;
    editor.render();
  });
  $("#draw-color").addEventListener("input", (e) => { editor.brushColor = e.target.value; });

  $("#btn-open").addEventListener("click", () => openModal("#modal-open"));
  $("#btn-detect-all").addEventListener("click", detectAll);
  $("#btn-process").addEventListener("click", processAll);
  $("#btn-export").addEventListener("click", () => {
    openModal("#modal-export");
  });
  $("#btn-settings").addEventListener("click", () => {
    syncDeviceControls();
    openModal("#modal-settings");
  });
  $("#job-cancel").addEventListener("click", () => api("/job/cancel", { method: "POST" }));
  $("#lang-select").value = LANG;
  $("#lang-select").addEventListener("change", (e) => {
    setLang(e.target.value);
    renderSidebar();
    syncDeviceControls();
    $("#sb-hint").textContent = t("shortcut_hint");
  });

  $("#btn-create-project").addEventListener("click", createProject);
  $("#folder-input").addEventListener("keydown", (e) => { if (e.key === "Enter") createProject(); });
  $("#folder-input").addEventListener("input", () => {
    if ($("#project-name").value.trim()) return;
    const parts = $("#folder-input").value.trim().split(/[\\/]/).filter(Boolean);
    if (parts.length) $("#project-name").value = parts[parts.length - 1];
  });
  const dz = $("#dropzone");
  const fileInput = $("#file-input");
  $("#browse-link").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

  window.addEventListener("pywebviewready", () => {
    $$(".native-browse").forEach((b) => { b.style.display = "inline-flex"; });
  });
  $("#btn-browse-folder").addEventListener("click", async () => {
    const p = await window.pywebview.api.pick_folder();
    if (p) {
      $("#folder-input").value = p;
      $("#folder-input").dispatchEvent(new Event("input"));
    }
  });
  $("#btn-browse-out").addEventListener("click", async () => {
    const p = await window.pywebview.api.pick_output_folder();
    if (p) $("#out-input").value = p;
  });

  $$(".modal-backdrop").forEach((m) =>
    m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("open"); }));
  $$("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeModal(b.dataset.close)));

  const s = settings;
  if (!["auto", "comictextdetector", "opencv"].includes(s.detector)) {
    s.detector = "auto";
    saveSettings();
  }
  $("#set-detect").value = s.detect;
  $("#set-detector").value = s.detector;
  $("#set-model").value = s.model;
  syncDeviceControls();
  $("#set-dilate").value = s.dilate;
  $("#set-dilate-val").textContent = s.dilate;
  $("#set-feather").value = s.feather;
  $("#set-feather-val").textContent = s.feather;
  $("#set-force").checked = s.force;
  $("#set-detect").addEventListener("change", (e) => { s.detect = e.target.value; saveSettings(); });
  $("#set-detector").addEventListener("change", (e) => { s.detector = e.target.value; saveSettings(); });
  $("#set-model").addEventListener("change", (e) => {
    s.model = e.target.value; saveSettings(); updateBackendLabel();
  });
  $("#set-device").addEventListener("change", (e) => {
    s.device = e.target.value; saveSettings(); updateBackendLabel();
  });
  $("#set-dilate").addEventListener("input", (e) => {
    s.dilate = +e.target.value; $("#set-dilate-val").textContent = e.target.value; saveSettings();
  });
  $("#set-feather").addEventListener("input", (e) => {
    s.feather = +e.target.value; $("#set-feather-val").textContent = e.target.value; saveSettings();
  });
  $("#set-force").addEventListener("change", (e) => { s.force = e.target.checked; saveSettings(); });

  $("#btn-do-export").addEventListener("click", doExport);

  $("#text-content").addEventListener("input", (e) => {
    if (editor.selectedText === null) return;
    editor.texts[editor.selectedText].text = e.target.value;
    state.dirty.texts = true;
    editor.render();
  });
  $("#text-size").addEventListener("change", (e) => applyTextPanel("size", Math.max(6, +e.target.value || 24)));
  $("#text-color").addEventListener("input", (e) => applyTextPanel("color", e.target.value));
  $("#text-stroke").addEventListener("change", (e) => applyTextPanel("stroke", Math.max(0, +e.target.value || 0)));
  $("#text-stroke-color").addEventListener("input", (e) => applyTextPanel("strokeColor", e.target.value));
  $("#text-font").addEventListener("change", (e) => applyTextPanel("font", e.target.value));
  $("#text-bold").addEventListener("change", (e) => applyTextPanel("bold", e.target.checked));
  $("#text-rotation").addEventListener("change", (e) => {
    if (editor.selectedText === null) return;
    editor.texts[editor.selectedText].rotation =
      Math.max(-180, Math.min(180, +e.target.value || 0));
    state.dirty.texts = true;
    editor.render();
  });
  $("#text-delete").addEventListener("click", () => { editor.deleteSelectedText(); });

  $("#btn-add-pages").addEventListener("click", () => $("#add-pages-input").click());
  $("#add-pages-input").addEventListener("change", () => {
    addPages($("#add-pages-input").files);
    $("#add-pages-input").value = "";
  });
  const plist = $("#page-list");
  ["dragenter", "dragover"].forEach((ev) =>
    plist.addEventListener(ev, (e) => {
      if (!state.pages.length) return;
      e.preventDefault();
      plist.classList.add("drag");
    }));
  ["dragleave", "drop"].forEach((ev) =>
    plist.addEventListener(ev, (e) => { e.preventDefault(); plist.classList.remove("drag"); }));
  plist.addEventListener("drop", (e) => addPages(e.dataTransfer.files));

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (anyModalOpen()) {
      if (e.key === "Escape") $$(".modal-backdrop.open").forEach((m) => m.classList.remove("open"));
      return;
    }
    if (e.key === "Escape") { editor.cancelPoly(); return; }
    if (e.key === "Backspace" && editor.tool === "poly") {
      e.preventDefault();
      editor.popPolyPoint();
      return;
    }
    if (e.code === "Space") { editor.setSpacePan(true); e.preventDefault(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); editor.undo(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "y") { e.preventDefault(); editor.redo(); return; }
    if (e.ctrlKey) return;

    if (e.key === "ArrowRight" || e.key === ".") {
      if (!editor.isBusy) { e.preventDefault(); navPage(1); }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === ",") {
      if (!editor.isBusy) { e.preventDefault(); navPage(-1); }
      return;
    }
    if (e.key === "Delete" && editor.tool === "text") { editor.deleteSelectedText(); return; }
    if (e.shiftKey && e.key.toLowerCase() === "r") { revertPage(); return; }

    const k = e.key.toLowerCase();
    if (k === "b") setTool("brush");
    else if (k === "e") setTool("eraser");
    else if (k === "r") setTool("rect");
    else if (k === "l") setTool("poly");
    else if (k === "h") setTool("pan");
    else if (k === "p") setTool("draw");
    else if (k === "o") setTool("restore");
    else if (k === "j") setTool("heal");
    else if (k === "t") setTool("text");
    else if (k === "d") detectPage();
    else if (k === "enter") {
      if (editor.tool === "poly" && editor.polyCount >= 3) editor.closePoly();
      else cleanPage();
    }
    else if (k === "m") $("#btn-mask-vis").click();
    else if (k === "c") { editor.showOriginal = true; $("#compare-flag").classList.add("on"); editor.render(); }
    else if (k === "[") { $("#brush-size").value = Math.max(2, editor.brushSize - 4); $("#brush-size").dispatchEvent(new Event("input")); }
    else if (k === "]") { $("#brush-size").value = Math.min(200, editor.brushSize + 4); $("#brush-size").dispatchEvent(new Event("input")); }
    else if (k === "+" || k === "=") editor.zoomBy(1.25);
    else if (k === "-") editor.zoomBy(1 / 1.25);
    else if (k === "0") editor.fit();
    else if (k === "1") editor.zoom100();
  });
  window.addEventListener("keyup", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (e.code === "Space") editor.setSpacePan(false);
    if (e.key.toLowerCase() === "c") {
      editor.showOriginal = false;
      $("#compare-flag").classList.remove("on");
      editor.render();
    }
  });

  window.addEventListener("beforeunload", () => { saveCurrentPageState(); });
}

async function boot() {
  applyI18n();
  initEditor();
  bindUI();
  $("#sb-hint").textContent = t("shortcut_hint");
  setTool("brush");
  $("#btn-mask-vis").classList.add("active");
  syncTextPanel();

  try {
    state.meta = await api("/meta");
    syncDeviceControls();
    updateBackendLabel();
    if (!state.meta.lama) $("#lama-note").classList.add("show");
    if (!state.meta.ctd) $("#detector-note").classList.add("show");
  } catch {}

  try {
    const st = await api("/project");
    if (st.pages.length) { onProjectLoaded(st); return; }
  } catch {}
  openModal("#modal-open");
}

document.addEventListener("DOMContentLoaded", boot);
