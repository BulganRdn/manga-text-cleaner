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

let textEditPushed = false;

function resetTextEditHistory() { textEditPushed = false; }

function ensureTextHistory() {
  if (!textEditPushed) {
    editor.pushHistory("texts");
    textEditPushed = true;
  }
}

function undoEdit() {
  resetTextEditHistory();
  editor.undo();
}

function redoEdit() {
  resetTextEditHistory();
  editor.redo();
}

function adjustBrushSize(delta) {
  const el = $("#brush-size");
  el.value = Math.max(2, Math.min(200, editor.brushSize + delta));
  el.dispatchEvent(new Event("input"));
}

function wheelBrushStep(e) {
  const mag = Math.abs(e.deltaY);
  if (mag < 0.5) return 0;
  return Math.max(2, Math.min(12, Math.round(mag / 12) * 2 || 4));
}

function initEditor() {
  editor = new MaskEditor($("#editor-canvas"), {
    onView: (v) => {
      $("#sb-zoom").textContent = Math.round(v.scale * 100) + "%";
      if (cmp.active) cmpSyncLeft();
    },
    onDirty: (kind) => { state.dirty[kind] = true; },
    onHealStroke: healStroke,
    onTextSelect: onTextSelect,
    onTextChange: syncTextPanel,
    onRequestTool: setTool,
    onHistoryChange: () => { syncTextPanel(); resetTextEditHistory(); },
    onTextCreate: (x, y) => {
      const region = editor.regionAt(x, y);
      const item = { x, y, text: t("text_placeholder"), ...textDefaults };
      delete item.region;
      delete item.lines;
      delete item.fit;
      if (region) {
        item.region = region;
        item.fit = true;
        item.x = region.x + region.w / 2;
        item.y = region.y + region.h / 2;
      }
      editor.addText(item);
      if (region) { editor.fitTextToRegion(item); editor.render(); }
      openTextPanel();
    },
    onColorPick: (hex) => { $("#draw-color").value = hex; },
  });
}

function updatePageNav() {
  const has = state.pages.length > 0 && state.current !== null;
  const i = state.current;
  $("#btn-prev-page").disabled = !has || i <= 0;
  $("#btn-next-page").disabled = !has || i >= state.pages.length - 1;
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
  updatePageNav();
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
    ensureItemFonts(texts).then(() => editor.render());
    if (cmp.active && cmp.source === "batch") cmpMatchCurrentPage();
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
  if (cmp.active) cmpExit();
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
  let mask = editor.exportMask();
  if (!mask) { toast(t("mask_empty"), "warn"); return; }
  const btn = $("#btn-clean");
  btn.disabled = true;
  if (settings.model === "lama" && !state.pages[i].hasResult) {
    toast(t("loading_model"), "info", 6000);
  }
  try {
    await saveCurrentPageState();
    let incremental = false;
    if (state.pages[i].hasResult) {
      const diff = editor.exportNewMask();
      if (diff) { mask = diff; incremental = true; }
    }
    editor.pushHistory("result");
    const p = await api(`/pages/${i}/clean`, {
      method: "POST",
      body: JSON.stringify({ settings: apiSettings(), mask, incremental }),
    });
    patchPages([p]);
    state.dirty.mask = false;
    state.dirty.result = false;
    editor.markMaskCleaned();
    await refreshCurrentResult();
    toast(t(incremental ? "cleaned_inc" : "cleaned_ok"), "success");
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

/* ---------- side-by-side compare (inline, editable) ---------- */

const cmp = { active: false, leftView: null, source: "none", batch: [], batchIndex: 0 };

const CMP_IMG_RE = /\.(jpe?g|png|webp)$/i;

function cmpSortKey(name) {
  return name.split(/(\d+)/).map((s) => (s.match(/^\d+$/) ? +s : s.toLowerCase()));
}

function cmpSortByName(a, b) {
  const ka = cmpSortKey(a.name), kb = cmpSortKey(b.name);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function cmpFitScale(w, h, iw, ih) {
  return Math.min(w / iw, h / ih) * 0.96;
}

function cmpImageAtCenter(el, view, iw, ih) {
  const w = el.clientWidth, h = el.clientHeight;
  const cx = w / 2, cy = h / 2;
  return { ix: (cx - view.tx) / view.scale, iy: (cy - view.ty) / view.scale, iw, ih };
}

function cmpSyncLeft() {
  const left = $("#cmp-left");
  const edit = $("#cmp-edit");
  const img = $("#cmp-left-img");
  if (!cmp.active || !img.naturalWidth || !editor.original) return;

  const lw = left.clientWidth, lh = left.clientHeight;
  const ew = edit.clientWidth, eh = edit.clientHeight;
  const liw = img.naturalWidth, lih = img.naturalHeight;
  const eiw = editor.original.naturalWidth, eih = editor.original.naturalHeight;
  const ed = editor.view;

  const { ix: eix, iy: eiy } = cmpImageAtCenter(edit, ed, eiw, eih);
  const nx = eix / eiw, ny = eiy / eih;
  const lix = nx * liw, liy = ny * lih;

  const zoom = ed.scale / cmpFitScale(ew, eh, eiw, eih);
  const s = cmpFitScale(lw, lh, liw, lih) * zoom;
  const x = lw / 2 - lix * s;
  const y = lh / 2 - liy * s;
  img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  cmp.leftView = { s, x, y, liw, lih, eiw, eih };
}

function cmpLeftToNorm(lx, ly) {
  const v = cmp.leftView;
  if (!v) return { nx: 0.5, ny: 0.5 };
  return { nx: (lx - v.x) / (v.s * v.liw), ny: (ly - v.y) / (v.s * v.lih) };
}

function cmpPan(dx, dy) {
  editor.view.tx += dx;
  editor.view.ty += dy;
  editor.render();
}

function cmpZoomAt(side, clientX, clientY, factor) {
  if (side === "left") {
    const left = $("#cmp-left");
    const rect = left.getBoundingClientRect();
    const lx = clientX - rect.left, ly = clientY - rect.top;
    const { nx, ny } = cmpLeftToNorm(lx, ly);
    const v = cmp.leftView;
    if (!v || !editor.original) return;
    const eix = nx * v.eiw, eiy = ny * v.eih;
    const edit = $("#cmp-edit");
    const er = edit.getBoundingClientRect();
    const ecx = editor.view.tx + eix * editor.view.scale;
    const ecy = editor.view.ty + eiy * editor.view.scale;
    editor.zoomBy(factor, ecx, ecy);
    return;
  }
  const edit = $("#cmp-edit");
  const rect = edit.getBoundingClientRect();
  editor.zoomBy(factor, clientX - rect.left, clientY - rect.top);
}

function cmpClearBatch() {
  for (const item of cmp.batch) {
    if (item.url?.startsWith("blob:")) URL.revokeObjectURL(item.url);
  }
  cmp.batch = [];
  cmp.batchIndex = 0;
  cmp.source = "none";
  $("#cmp-ref-info").textContent = "";
  cmpUpdateBatchUI();
}

function cmpFindBatchIndex(pageName) {
  const lower = pageName.toLowerCase();
  let idx = cmp.batch.findIndex((b) => b.name.toLowerCase() === lower);
  if (idx >= 0) return idx;
  const stem = lower.replace(/\.[^.]+$/, "");
  return cmp.batch.findIndex((b) => b.name.replace(/\.[^.]+$/, "").toLowerCase() === stem);
}

function cmpUpdateBatchUI() {
  const on = cmp.source === "batch" && cmp.batch.length > 0;
  $("#cmp-prev").hidden = !on;
  $("#cmp-next").hidden = !on;
  $("#cmp-batch-pos").hidden = !on;
  if (on) {
    $("#cmp-batch-pos").textContent = t("cmp_batch_pos",
      { n: cmp.batchIndex + 1, total: cmp.batch.length });
    $("#cmp-prev").disabled = cmp.batchIndex <= 0;
    $("#cmp-next").disabled = cmp.batchIndex >= cmp.batch.length - 1;
  }
}

function cmpFillPageDropdown(items, selectedIndex) {
  const sel = $("#cmp-page");
  sel.innerHTML = "";
  items.forEach((item, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${i + 1} · ${item.name}`;
    sel.appendChild(opt);
  });
  sel.disabled = !items.length;
  if (items.length) {
    sel.value = String(Math.min(selectedIndex, items.length - 1));
  }
}

function cmpSetBatchLabel(label) {
  $("#cmp-ref-info").textContent = label;
}

function cmpActivateBatch(batch, label, startIndex) {
  if (!batch.length) {
    toast(t("err_no_images"), "warn");
    return;
  }
  cmpClearBatch();
  cmp.batch = batch;
  cmp.source = "batch";
  cmpSetBatchLabel(label);
  cmpFillPageDropdown(batch, startIndex ?? 0);
  cmpShowBatchIndex(startIndex ?? 0);
  cmpUpdateBatchUI();
  toast(t("cmp_batch_loaded", { n: batch.length }), "success");
}

function cmpApplyCompareResponse(res, label) {
  const batch = res.files.map((f) => ({
    name: f.name,
    url: `/api/compare/${res.token}/${f.index}`,
  }));
  let start = 0;
  if (state.current !== null && state.pages[state.current]) {
    const hit = cmpFindBatchIndex(state.pages[state.current].name);
    if (hit >= 0) start = hit;
  }
  cmpActivateBatch(batch, label, start);
  editor.fit();
}

function cmpShowBatchIndex(i) {
  if (!cmp.batch.length) return;
  cmp.batchIndex = Math.max(0, Math.min(i, cmp.batch.length - 1));
  const item = cmp.batch[cmp.batchIndex];
  $("#cmp-page").value = String(cmp.batchIndex);
  $("#cmp-left-label").textContent = `${t("cmp_original")} — ${item.name}`;
  cmpSetLeftImage(item.url);
  cmpUpdateBatchUI();
}

function cmpMatchCurrentPage() {
  if (cmp.source !== "batch" || state.current === null) return;
  const pageName = state.pages[state.current]?.name;
  if (!pageName) return;
  const idx = cmpFindBatchIndex(pageName);
  if (idx >= 0) {
    cmpShowBatchIndex(idx);
    editor.fit();
  } else {
    toast(t("cmp_no_match", { name: pageName }), "warn", 3500);
  }
}

function cmpNavBatch(delta) {
  if (cmp.source !== "batch" || !cmp.batch.length) return;
  cmpShowBatchIndex(cmp.batchIndex + delta);
  editor.fit();
}

async function cmpLoadFolder(path) {
  try {
    const res = await api("/compare/folder", {
      method: "POST", body: JSON.stringify({ path }),
    });
    const folderName = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
    cmpApplyCompareResponse(res, `📁 ${folderName} (${res.files.length})`);
  } catch (e) { errToast(e); }
}

async function cmpLoadPaths(paths) {
  try {
    const res = await api("/compare/paths", {
      method: "POST", body: JSON.stringify({ paths }),
    });
    const label = paths.length === 1
      ? `📄 ${paths[0].replace(/[\\/]+$/, "").split(/[\\/]/).pop()}`
      : `📄 ${res.files.length} ${t("cmp_files")}`;
    cmpApplyCompareResponse(res, label);
  } catch (e) { errToast(e); }
}

function cmpLoadFiles(fileList) {
  const files = [...fileList].filter((f) => CMP_IMG_RE.test(f.name));
  files.sort((a, b) => cmpSortByName({ name: a.name }, { name: b.name }));
  if (!files.length) { toast(t("err_no_images"), "warn"); return; }
  const batch = files.map((f) => ({ name: f.name, url: URL.createObjectURL(f) }));
  let start = 0;
  if (state.current !== null && state.pages[state.current]) {
    const hit = cmpFindBatchIndex(state.pages[state.current].name);
    if (hit >= 0) start = hit;
  }
  const label = files.length === 1
    ? `📄 ${files[0].name}`
    : `📄 ${files.length} ${t("cmp_files")}`;
  cmpActivateBatch(batch, label, start);
  editor.fit();
}

function cmpSetLeftImage(url) {
  const img = $("#cmp-left-img");
  const missing = $("#cmp-left-missing");
  img.onload = null;
  img.onerror = null;
  img.removeAttribute("src");
  img.style.visibility = "hidden";
  if (!url) {
    missing.textContent = t("cmp_browse_hint");
    missing.hidden = false;
    cmp.leftView = null;
    return;
  }
  missing.hidden = true;
  const src = url.startsWith("/api/") ? `${url}?t=${Date.now()}` : url;
  img.onload = () => { img.style.visibility = "visible"; cmpSyncLeft(); };
  img.onerror = () => {
    img.removeAttribute("src");
    missing.textContent = t("cmp_load_failed");
    missing.hidden = false;
    cmp.leftView = null;
  };
  img.src = src;
}

function cmpShowLeftPlaceholder() {
  cmp.source = "none";
  cmpSetBatchLabel(t("cmp_browse_hint"));
  $("#cmp-left-label").textContent = t("cmp_reference");
  cmpFillPageDropdown([], 0);
  cmpSetLeftImage(null);
}

async function openCompare() {
  const i = state.current;
  if (i === null || !state.projectName) return;
  if (cmp.active) { cmpExit(); return; }
  await saveCurrentPageState();
  cmpClearBatch();
  cmpShowLeftPlaceholder();
  cmpEnter();
}

function bindCompare() {
  $("#btn-compare-view").addEventListener("click", openCompare);
  $("#cmp-close").addEventListener("click", cmpExit);
  $("#cmp-fit").addEventListener("click", () => { editor.fit(); });
  $("#cmp-prev").addEventListener("click", () => cmpNavBatch(-1));
  $("#cmp-next").addEventListener("click", () => cmpNavBatch(1));

  $("#cmp-page").addEventListener("change", () => {
    if (cmp.source === "batch") {
      cmpShowBatchIndex(+$("#cmp-page").value || 0);
      editor.fit();
    }
  });

  $("#cmp-browse").addEventListener("click", async () => {
    if (window.pywebview?.api?.pick_files) {
      try {
        const paths = await window.pywebview.api.pick_files();
        if (paths?.length) await cmpLoadPaths(paths);
      } catch (e) { errToast(e); }
      return;
    }
    $("#cmp-file").click();
  });
  $("#cmp-file").addEventListener("change", () => {
    const files = [...$("#cmp-file").files];
    $("#cmp-file").value = "";
    if (!files.length) return;
    cmpLoadFiles(files);
  });
  $("#cmp-browse-folder").addEventListener("click", async () => {
    if (!window.pywebview?.api?.pick_folder) {
      toast(t("err_folder"), "warn");
      return;
    }
    try {
      const p = await window.pywebview.api.pick_folder();
      if (p) await cmpLoadFolder(p);
    } catch (e) { errToast(e); }
  });

  const left = $("#cmp-left");
  left.addEventListener("wheel", (e) => {
    if (!cmp.active) return;
    e.preventDefault();
    cmpZoomAt("left", e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
  left.addEventListener("pointerdown", (e) => {
    if (!cmp.active || e.button !== 0) return;
    left.setPointerCapture(e.pointerId);
    left.classList.add("panning");
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev) => {
      cmpPan(ev.clientX - last.x, ev.clientY - last.y);
      last = { x: ev.clientX, y: ev.clientY };
    };
    const up = () => {
      left.classList.remove("panning");
      left.releasePointerCapture(e.pointerId);
      left.removeEventListener("pointermove", move);
      left.removeEventListener("pointerup", up);
      left.removeEventListener("pointercancel", up);
    };
    left.addEventListener("pointermove", move);
    left.addEventListener("pointerup", up);
    left.addEventListener("pointercancel", up);
  });

  window.addEventListener("resize", () => {
    if (cmp.active) cmpSyncLeft();
  });
}

function cmpEnter() {
  $("#canvas-wrap").classList.add("compare-active");
  $("#compare-bar").hidden = false;
  $("#cmp-left").hidden = false;
  $("#btn-compare-view").classList.add("active");
  cmp.active = true;
  requestAnimationFrame(() => { editor.fit(); cmpSyncLeft(); });
}

function cmpExit() {
  $("#canvas-wrap").classList.remove("compare-active");
  $("#compare-bar").hidden = true;
  $("#cmp-left").hidden = true;
  $("#btn-compare-view").classList.remove("active");
  cmp.active = false;
  cmpClearBatch();
  requestAnimationFrame(() => editor.fit());
}

/* ---------- fonts ---------- */

const fontState = { list: null, faces: new Map() };
const LEGACY_FONT_NAMES = { arial: "Arial", comic: "Comic Sans", verdana: "Verdana",
                            tahoma: "Tahoma", impact: "Impact", times: "Times" };

async function loadFontList(refresh = false) {
  if (!refresh && fontState.list) return fontState.list;
  const res = refresh ? await api("/fonts/refresh", { method: "POST" })
                      : await api("/fonts");
  fontState.list = res.fonts;
  return fontState.list;
}

function fontCssName(f) {
  return f.style && f.style !== "Regular" ? `MCF ${f.family} ${f.style}` : `MCF ${f.family}`;
}

function fontDisplayName(f) {
  return f.style && f.style !== "Regular" ? `${f.family} ${f.style}` : f.family;
}

function ensureFontFace(cssName, url) {
  if (fontState.faces.has(cssName)) return fontState.faces.get(cssName);
  const p = (async () => {
    const face = new FontFace(cssName, `url("${url}")`);
    await face.load();
    document.fonts.add(face);
  })().catch(() => {});
  fontState.faces.set(cssName, p);
  return p;
}

async function ensureItemFonts(items) {
  const custom = (items || []).filter((t) => t.fontFamily && t.fontPath);
  if (!custom.length) return;
  const list = await loadFontList().catch(() => []);
  await Promise.all(custom.map((t) => {
    const f = list.find((f) => f.path === t.fontPath);
    return f ? ensureFontFace(t.fontFamily, `/api/fonts/${f.id}/file`) : null;
  }));
}

let fontObserver = null;

function renderFontRows(filter) {
  const box = $("#font-list");
  box.innerHTML = "";
  if (fontObserver) fontObserver.disconnect();
  fontObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      fontObserver.unobserve(en.target);
      const { css, url } = en.target.dataset;
      ensureFontFace(css, url).then(() => {
        en.target.querySelector(".fp-name").style.fontFamily = `"${css}"`;
      });
    }
  }, { root: box });
  const q = (filter || "").trim().toLowerCase();
  const list = (fontState.list || []).filter(
    (f) => !q || fontDisplayName(f).toLowerCase().includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="fp-empty">${t("font_none")}</div>`;
    return;
  }
  for (const f of list.slice(0, 400)) {
    const row = document.createElement("div");
    row.className = "fp-row";
    row.dataset.css = fontCssName(f);
    row.dataset.url = `/api/fonts/${f.id}/file`;
    const badges =
      (f.source === "bundled" ? `<span class="fp-badge">fonts/</span>` : "") +
      (f.supportsCyrillic ? "" : `<span class="fp-badge warn" title="${t("font_no_cyr")}">Аа?</span>`);
    row.innerHTML = `<span class="fp-name">${fontDisplayName(f)} — Аа Бб</span>${badges}`;
    row.addEventListener("click", () => applyFont(f));
    box.appendChild(row);
    fontObserver.observe(row);
  }
}

async function openFontPicker() {
  const panel = $("#font-picker");
  panel.hidden = false;
  $("#font-search").value = "";
  $("#font-list").innerHTML = `<div class="fp-empty">${t("font_loading")}</div>`;
  try {
    await loadFontList();
    renderFontRows("");
    $("#font-search").focus();
  } catch (e) { errToast(e); panel.hidden = true; }
}

function closeFontPicker() { $("#font-picker").hidden = true; }

function applyFont(f) {
  const css = fontCssName(f);
  ensureFontFace(css, `/api/fonts/${f.id}/file`).then(() => editor.render());
  textDefaults.fontFamily = css;
  textDefaults.fontPath = f.path;
  saveTextDefaults();
  if (editor.selectedText !== null) {
    ensureTextHistory();
    const item = editor.texts[editor.selectedText];
    item.fontFamily = css;
    item.fontPath = f.path;
    state.dirty.texts = true;
    editor.render();
  }
  closeFontPicker();
  syncTextPanel();
}

function openTextPanel() { $("#text-panel").classList.add("open"); syncTextPanel(); }
function closeTextPanel() { $("#text-panel").classList.remove("open"); closeFontPicker(); }

function onTextSelect(index) {
  resetTextEditHistory();
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
  $("#font-current").textContent = src.fontFamily
    ? src.fontFamily.replace(/^MCF /, "")
    : (LEGACY_FONT_NAMES[src.font] || "Arial");
  $("#text-bold").checked = !!src.bold;
  $("#text-bold").disabled = !!src.fontPath;
  $("#text-rotation").value = Math.round(src.rotation || 0);
  $("#text-skew").value = Math.round(src.skew || 0);
  $("#text-scalex").value = Math.round((src.scaleX || 1) * 100);
  $("#text-scaley").value = Math.round((src.scaleY || 1) * 100);
  $("#text-gradient").checked = !!src.gradient;
  $("#text-color2").value = src.color2 || "#ff4040";
  $("#text-fit").style.display = t0 && t0.region ? "" : "none";
  $("#text-fit").classList.toggle("active", !!(t0 && t0.fit));
}

function applyTextTransform(field, value) {
  if (editor.selectedText === null) return;
  ensureTextHistory();
  editor.texts[editor.selectedText][field] = value;
  state.dirty.texts = true;
  editor.render();
}

function applyTextPanel(field, value) {
  Object.assign(textDefaults, { [field]: value });
  saveTextDefaults();
  if (editor.selectedText === null) return;
  ensureTextHistory();
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

function setDrawMode(clone) {
  editor.drawClone = clone;
  $$(".mode-btn[data-draw-mode]").forEach((b) =>
    b.classList.toggle("active", (b.dataset.drawMode === "clone") === clone));
  updateDrawOptions();
  editor.render();
}

function updateDrawOptions() {
  const tool = editor.tool;
  const draw = tool === "draw";
  const mask = tool === "brush" || tool === "eraser" || tool === "rect" || tool === "poly";
  $("#paint-options").style.display = draw ? "flex" : "none";
  $("#mask-opacity-wrap").style.display = mask ? "flex" : "none";
  $("#draw-color-wrap").style.display = draw && !editor.drawClone ? "flex" : "none";
  $("#clone-hint").style.display = draw && editor.drawClone ? "inline" : "none";
  $("#draw-hint").textContent = t("eyedropper_hint");
}

function setTool(tool) {
  editor.setTool(tool);
  $$("#toolbar .tool[data-tool]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === tool));
  updateDrawOptions();
  if (tool !== "text") closeTextPanel();
}

function bindUI() {
  $$("#toolbar .tool[data-tool]").forEach((b) =>
    b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#btn-undo").addEventListener("click", () => undoEdit());
  $("#btn-redo").addEventListener("click", () => redoEdit());
  $("#btn-prev-page").addEventListener("click", () => { if (!editor.isBusy) navPage(-1); });
  $("#btn-next-page").addEventListener("click", () => { if (!editor.isBusy) navPage(1); });
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
  $$(".mode-btn[data-draw-mode]").forEach((b) =>
    b.addEventListener("click", () => setDrawMode(b.dataset.drawMode === "clone")));

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
    updateDrawOptions();
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
    ensureTextHistory();
    const item = editor.texts[editor.selectedText];
    item.text = e.target.value;
    if (item.fit && item.region) {
      editor.fitTextToRegion(item);
      $("#text-size").value = item.size;
    } else {
      delete item.lines;
    }
    state.dirty.texts = true;
    editor.render();
  });
  $("#text-fit").addEventListener("click", () => {
    if (editor.selectedText === null) return;
    const item = editor.texts[editor.selectedText];
    if (!item.region) return;
    ensureTextHistory();
    item.fit = true;
    editor.fitTextToRegion(item);
    state.dirty.texts = true;
    editor.render();
    syncTextPanel();
  });
  $("#text-size").addEventListener("change", (e) => {
    if (editor.selectedText !== null) {
      ensureTextHistory();
      editor.texts[editor.selectedText].fit = false;
    }
    applyTextPanel("size", Math.max(6, +e.target.value || 24));
  });
  $("#text-color").addEventListener("input", (e) => applyTextPanel("color", e.target.value));
  $("#text-stroke").addEventListener("change", (e) => applyTextPanel("stroke", Math.max(0, +e.target.value || 0)));
  $("#text-stroke-color").addEventListener("input", (e) => applyTextPanel("strokeColor", e.target.value));
  $("#text-bold").addEventListener("change", (e) => applyTextPanel("bold", e.target.checked));
  $("#font-picker-btn").addEventListener("click", () => {
    $("#font-picker").hidden ? openFontPicker() : closeFontPicker();
  });
  $("#font-search").addEventListener("input", (e) => renderFontRows(e.target.value));
  $("#font-search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeFontPicker(); e.stopPropagation(); }
  });
  $("#font-refresh").addEventListener("click", async () => {
    $("#font-list").innerHTML = `<div class="fp-empty">${t("font_loading")}</div>`;
    try {
      await loadFontList(true);
      renderFontRows($("#font-search").value);
    } catch (e) { errToast(e); }
  });
  $("#text-rotation").addEventListener("change", (e) =>
    applyTextTransform("rotation", Math.max(-180, Math.min(180, +e.target.value || 0))));
  $("#text-skew").addEventListener("change", (e) =>
    applyTextTransform("skew", Math.max(-60, Math.min(60, +e.target.value || 0))));
  $("#text-scalex").addEventListener("change", (e) =>
    applyTextTransform("scaleX", Math.max(0.2, Math.min(5, (+e.target.value || 100) / 100))));
  $("#text-scaley").addEventListener("change", (e) =>
    applyTextTransform("scaleY", Math.max(0.2, Math.min(5, (+e.target.value || 100) / 100))));
  $("#text-gradient").addEventListener("change", (e) =>
    applyTextTransform("gradient", e.target.checked));
  $("#text-color2").addEventListener("input", (e) =>
    applyTextTransform("color2", e.target.value));
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
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.code === "KeyZ" || e.code === "KeyY")) {
      e.preventDefault();
      if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) redoEdit();
      else undoEdit();
      return;
    }
    if (mod && (e.code === "Minus" || e.code === "NumpadSubtract")) {
      e.preventDefault();
      adjustBrushSize(-4);
      return;
    }
    if (mod && (e.code === "Equal" || e.code === "NumpadAdd")) {
      e.preventDefault();
      adjustBrushSize(4);
      return;
    }
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (anyModalOpen()) {
      if (e.key === "Escape") $$(".modal-backdrop.open").forEach((m) => m.classList.remove("open"));
      return;
    }
    if (e.key === "Escape") {
      if (cmp.active) { cmpExit(); return; }
      editor.cancelMaskPaste();
      editor.cancelPoly();
      editor.clearMaskSelection();
      editor.clearTextSelection();
      return;
    }
    if (e.key === "Backspace" && editor.tool === "poly") {
      e.preventDefault();
      editor.popPolyPoint();
      return;
    }
    if (e.code === "Space") { editor.setSpacePan(true); e.preventDefault(); return; }
    if (mod && e.code === "KeyA" && editor.tool === "text") {
      if (editor.selectAllTexts()) e.preventDefault();
      return;
    }
    if (mod && e.code === "KeyC") {
      if (editor.tool === "text" && editor.selectedText !== null) {
        e.preventDefault();
        const n = editor.copySelectedText();
        if (n) toast(n > 1 ? t("texts_copied", { n }) : t("text_copied"), "info", 2000);
        return;
      }
      if (editor.maskSelection) {
        e.preventDefault();
        if (editor.copyMaskSelection()) toast(t("mask_copied"), "info", 2500);
        return;
      }
      return;
    }
    if (mod && e.code === "KeyV") {
      if (editor.clipKind === "text") {
        if (editor.pasteText()) e.preventDefault();
      } else if (editor.startMaskPaste()) {
        e.preventDefault();
        toast(t("mask_paste_hint"), "info", 3500);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) return;

    if (e.key === "ArrowRight" || e.code === "Period") {
      if (!editor.isBusy) { e.preventDefault(); navPage(1); }
      return;
    }
    if (e.key === "ArrowLeft" || e.code === "Comma") {
      if (!editor.isBusy) { e.preventDefault(); navPage(-1); }
      return;
    }
    if (e.key === "Delete" && editor.maskSelection) { editor.eraseMaskSelection(); return; }
    if (e.key === "Delete" && editor.tool === "text") { editor.deleteSelectedText(); return; }
    if (e.shiftKey && e.code === "KeyR") { revertPage(); return; }

    const k = e.code;
    if (k === "KeyB") setTool("brush");
    else if (k === "KeyE") setTool("eraser");
    else if (k === "KeyR") setTool("rect");
    else if (k === "KeyL") setTool("poly");
    else if (k === "KeyH") setTool("pan");
    else if (k === "KeyP") setTool("draw");
    else if (k === "KeyO") setTool("restore");
    else if (k === "KeyJ") setTool("heal");
    else if (k === "KeyT") setTool("text");
    else if (k === "KeyD") detectPage();
    else if (e.key === "Enter") {
      if (editor.tool === "poly" && editor.polyCount >= 3) editor.closePoly();
      else cleanPage();
    }
    else if (k === "KeyM") $("#btn-mask-vis").click();
    else if (k === "KeyC") { editor.showOriginal = true; $("#compare-flag").classList.add("on"); editor.render(); }
    else if (k === "BracketLeft") adjustBrushSize(-4);
    else if (k === "BracketRight") adjustBrushSize(4);
    else if (k === "Equal" || k === "NumpadAdd") editor.zoomBy(1.25);
    else if (k === "Minus" || k === "NumpadSubtract") editor.zoomBy(1 / 1.25);
    else if (k === "Digit0" || k === "Numpad0") editor.fit();
    else if (k === "Digit1" || k === "Numpad1") editor.zoom100();
  });
  window.addEventListener("keyup", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (e.code === "Space") editor.setSpacePan(false);
    if (e.code === "KeyC") {
      editor.showOriginal = false;
      $("#compare-flag").classList.remove("on");
      editor.render();
    }
  });

  window.addEventListener("beforeunload", () => { saveCurrentPageState(); });

  // Ctrl+scroll: resize brush (capture phase blocks browser/page zoom).
  document.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!(e.target instanceof Element) || !e.target.closest("#canvas-wrap")) return;
    if (e.target.closest(".modal-backdrop.open")) return;
    e.preventDefault();
    const step = wheelBrushStep(e);
    if (step) adjustBrushSize(e.deltaY < 0 ? step : -step);
  }, { passive: false, capture: true });
}

async function boot() {
  applyI18n();
  initEditor();
  bindUI();
  bindCompare();
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
