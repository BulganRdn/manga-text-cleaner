"use strict";

const MASK_TOOLS = new Set(["brush", "eraser", "rect", "poly"]);
const REPAIR_TOOLS = new Set(["draw", "restore", "heal"]);

class MaskEditor {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cb = callbacks;

    this.original = null;
    this.hasResult = false;
    this.resultCanvas = document.createElement("canvas");
    this.resultCtx = this.resultCanvas.getContext("2d");
    this.maskCanvas = document.createElement("canvas");
    this.maskCtx = this.maskCanvas.getContext("2d");
    this.healCanvas = document.createElement("canvas");
    this.healCtx = this.healCanvas.getContext("2d");

    this.texts = [];
    this.selectedText = null;

    this.view = { scale: 1, tx: 0, ty: 0 };
    this.tool = "brush";
    this.brushSize = 26;
    this.brushColor = "#ffffff";
    this.drawClone = false;
    this.cloneSource = null;
    this.maskOpacity = 0.45;
    this.maskVisible = true;
    this.showOriginal = false;

    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 30;

    this._pointer = null;
    this._spacePan = false;
    this._cursorPos = null;
    this._rectStart = null;
    this._rectEnd = null;
    this._textDrag = null;
    this._polyPoints = [];
    this._polyErase = false;
    this._cloneStrokeOffset = null;
    this._cloneSnap = null;

    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
  }

  get isBusy() { return this._pointer !== null; }

  async setPage(originalUrl, resultUrl, maskUrl, texts = []) {
    this.original = await this._load(originalUrl);
    const w = this.original.naturalWidth, h = this.original.naturalHeight;
    for (const c of [this.resultCanvas, this.maskCanvas, this.healCanvas]) {
      c.width = w; c.height = h;
    }
    this.hasResult = false;
    this.resultCtx.drawImage(this.original, 0, 0);
    if (resultUrl) {
      const r = await this._load(resultUrl).catch(() => null);
      if (r) {
        this.resultCtx.clearRect(0, 0, w, h);
        this.resultCtx.drawImage(r, 0, 0, w, h);
        this.hasResult = true;
      }
    }
    this.maskCtx.clearRect(0, 0, w, h);
    if (maskUrl) {
      const m = await this._load(maskUrl).catch(() => null);
      if (m) this._stampMaskImage(m);
    }
    this.texts = Array.isArray(texts) ? texts : [];
    this.selectedText = null;
    this.cloneSource = null;
    this._cloneStrokeOffset = null;
    this._cloneSnap = null;
    this.undoStack = [];
    this.redoStack = [];
    this._polyPoints = [];
    this.fit();
  }

  async reloadResult(url) {
    const r = url ? await this._load(url).catch(() => null) : null;
    const w = this.resultCanvas.width, h = this.resultCanvas.height;
    this.resultCtx.clearRect(0, 0, w, h);
    if (r) { this.resultCtx.drawImage(r, 0, 0, w, h); this.hasResult = true; }
    else if (this.original) { this.resultCtx.drawImage(this.original, 0, 0); this.hasResult = false; }
    this.render();
  }

  clear() {
    this.original = null;
    this.hasResult = false;
    this.texts = [];
    this.selectedText = null;
    this._polyPoints = [];
    this.render();
  }

  _load(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  }

  _stampMaskImage(img) {
    const w = this.maskCanvas.width, h = this.maskCanvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(img, 0, 0, w, h);
    const src = tctx.getImageData(0, 0, w, h);
    const out = this.maskCtx.createImageData(w, h);
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i] > 127) { out.data[i] = 255; out.data[i + 3] = 255; }
    }
    this.maskCtx.putImageData(out, 0, 0);
  }

  async setMaskFromDataUrl(dataUrl) {
    const img = await this._load(dataUrl);
    this.pushHistory("mask");
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    this._stampMaskImage(img);
    this.render();
  }

  _alphaToBW(srcCanvas) {
    const w = srcCanvas.width, h = srcCanvas.height;
    if (!w) return null;
    const data = srcCanvas.getContext("2d").getImageData(0, 0, w, h).data;
    let any = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) { any = true; break; }
    }
    if (!any) return null;
    const white = document.createElement("canvas");
    white.width = w; white.height = h;
    const wctx = white.getContext("2d");
    wctx.drawImage(srcCanvas, 0, 0);
    wctx.globalCompositeOperation = "source-in";
    wctx.fillStyle = "#fff";
    wctx.fillRect(0, 0, w, h);
    const exp = document.createElement("canvas");
    exp.width = w; exp.height = h;
    const ectx = exp.getContext("2d");
    ectx.fillStyle = "#000";
    ectx.fillRect(0, 0, w, h);
    ectx.drawImage(white, 0, 0);
    return exp.toDataURL("image/png");
  }

  exportMask() { return this._alphaToBW(this.maskCanvas); }
  exportResult() { return this.resultCanvas.width ? this.resultCanvas.toDataURL("image/png") : null; }

  _snapshot(kind) {
    if (kind === "mask") return this.maskCanvas.toDataURL("image/png");
    if (kind === "result") return this.resultCanvas.toDataURL("image/png");
    return JSON.stringify(this.texts);
  }

  pushHistory(kind) {
    if (!this.original) return;
    this.undoStack.push({ kind, data: this._snapshot(kind) });
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  async _restore(entry) {
    if (entry.kind === "texts") {
      this.texts = JSON.parse(entry.data);
      this.selectedText = null;
      this.cb.onTextSelect?.(null);
      this.cb.onDirty?.("texts");
    } else {
      const img = await this._load(entry.data);
      const ctx = entry.kind === "mask" ? this.maskCtx : this.resultCtx;
      const c = entry.kind === "mask" ? this.maskCanvas : this.resultCanvas;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      this.cb.onDirty?.(entry.kind);
    }
    this.render();
  }

  async undo() {
    if (this._pointer) return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ kind: entry.kind, data: this._snapshot(entry.kind) });
    await this._restore(entry);
    this.cb.onHistoryChange?.();
  }

  async redo() {
    if (this._pointer) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ kind: entry.kind, data: this._snapshot(entry.kind) });
    await this._restore(entry);
    this.cb.onHistoryChange?.();
  }

  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
    this.render();
  }

  fit() {
    if (!this.original) return;
    const cw = this.canvas.width / devicePixelRatio;
    const ch = this.canvas.height / devicePixelRatio;
    const iw = this.original.naturalWidth, ih = this.original.naturalHeight;
    const scale = Math.min(cw / iw, ch / ih) * 0.96;
    this.view = { scale, tx: (cw - iw * scale) / 2, ty: (ch - ih * scale) / 2 };
    this.render();
  }

  zoom100() {
    if (!this.original) return;
    this._zoomTo(1, this.canvas.width / devicePixelRatio / 2,
                 this.canvas.height / devicePixelRatio / 2);
  }

  zoomBy(factor, cx, cy) {
    this._zoomTo(Math.min(16, Math.max(0.03, this.view.scale * factor)), cx, cy);
  }

  _zoomTo(scale, cx, cy) {
    const v = this.view;
    if (cx === undefined) {
      cx = this.canvas.width / devicePixelRatio / 2;
      cy = this.canvas.height / devicePixelRatio / 2;
    }
    const ix = (cx - v.tx) / v.scale, iy = (cy - v.ty) / v.scale;
    v.scale = scale;
    v.tx = cx - ix * scale;
    v.ty = cy - iy * scale;
    this.render();
  }

  toImage(sx, sy) {
    const v = this.view;
    return [(sx - v.tx) / v.scale, (sy - v.ty) / v.scale];
  }

  _onWheel(e) {
    if (e.ctrlKey || e.metaKey) return;
    if (!this.original) return;
    e.preventDefault();
    const p = this._pos(e);
    this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
  }

  _bind() {
    const c = this.canvas;
    const wrap = c.parentElement;
    wrap.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointerleave", () => { this._cursorPos = null; this.render(); });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("dblclick", (e) => {
      if (this.tool === "poly") {
        if (this._polyPoints.length > 3) this._polyPoints.pop();
        this.closePoly();
        return;
      }
      if (this.tool !== "text") return;
      const [ix, iy] = this.toImage(this._pos(e).x, this._pos(e).y);
      const hit = this._hitText(ix, iy);
      if (hit === null && this._hitHandle(ix, iy) === null) this.cb.onTextCreate?.(ix, iy);
    });
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _activeTool(e) {
    if (this._spacePan || e.button === 1) return "pan";
    if (e.button === 2) {
      if (this.tool === "brush" || this.tool === "rect") return "eraser";
      if (this.tool === "restore" || this.tool === "heal") return "pan";
    }
    return this.tool;
  }

  _down(e) {
    if (!this.original) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._pos(e);

    if (e.altKey && this.tool === "draw") {
      const [ix, iy] = this.toImage(p.x, p.y);
      if (this.drawClone) {
        this.cloneSource = [ix, iy];
        this.render();
        return;
      }
      const d = this.resultCtx.getImageData(Math.round(ix), Math.round(iy), 1, 1).data;
      const hex = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      this.brushColor = hex;
      this.cb.onColorPick?.(hex);
      return;
    }

    const tool = this._activeTool(e);

    if (tool === "draw" && this.drawClone && !this.cloneSource) return;

    this._pointer = { tool, last: p, moved: false };

    if (tool === "pan") { this.canvas.classList.add("panning"); return; }
    if (tool === "rect") {
      this._rectStart = this.toImage(p.x, p.y);
      this._rectEnd = this._rectStart;
      return;
    }
    if (tool === "poly") {
      this._pointer = null;
      if (this._polyPoints.length >= 3 && this._nearFirstVertex(p)) {
        this.closePoly();
        return;
      }
      if (!this._polyPoints.length) this._polyErase = e.button === 2;
      this._polyPoints.push(this.toImage(p.x, p.y));
      this.render();
      return;
    }
    if (tool === "text") {
      const [ix, iy] = this.toImage(p.x, p.y);
      const handle = this._hitHandle(ix, iy);
      if (handle === "rotate") {
        this._textDrag = { mode: "rotate", pushed: false };
        return;
      }
      if (handle === "resize") {
        const t = this.texts[this.selectedText];
        this._textDrag = { mode: "resize", size0: t.size, pushed: false,
                           d0: Math.max(4, Math.hypot(ix - t.x, iy - t.y)) };
        return;
      }
      const hit = this._hitText(ix, iy);
      if (hit !== null) {
        this.selectedText = hit;
        const t = this.texts[hit];
        this._textDrag = { mode: "move", dx: ix - t.x, dy: iy - t.y, pushed: false };
        this.cb.onTextSelect?.(hit);
      } else {
        this.selectedText = null;
        this.cb.onTextSelect?.(null);
      }
      this.render();
      return;
    }

    if (tool === "brush" || tool === "eraser") this.pushHistory("mask");
    else if (tool === "draw" || tool === "restore") {
      if (tool === "draw" && this.drawClone) {
        const [ix, iy] = this.toImage(p.x, p.y);
        this._cloneStrokeOffset = [ix - this.cloneSource[0], iy - this.cloneSource[1]];
        const w = this.resultCanvas.width, h = this.resultCanvas.height;
        this._cloneSnap = document.createElement("canvas");
        this._cloneSnap.width = w;
        this._cloneSnap.height = h;
        this._cloneSnap.getContext("2d").drawImage(this.resultCanvas, 0, 0);
      }
      this.pushHistory("result");
    }
    this._paintSegment(p, p, tool);
  }

  _move(e) {
    const p = this._pos(e);
    this._cursorPos = p;
    if (!this._pointer) {
      if (this.tool === "text" && this.original) {
        const [ix, iy] = this.toImage(p.x, p.y);
        const h = this._hitHandle(ix, iy);
        this.canvas.style.cursor = h === "rotate" ? "grab"
          : h === "resize" ? "nwse-resize"
          : this._hitText(ix, iy) !== null ? "move" : "";
      }
      this.render();
      return;
    }
    const { tool, last } = this._pointer;
    this._pointer.moved = true;

    if (tool === "pan") {
      this.view.tx += p.x - last.x;
      this.view.ty += p.y - last.y;
      this._pointer.last = p;
      this.render();
      return;
    }
    if (tool === "rect") {
      this._rectEnd = this.toImage(p.x, p.y);
      this.render();
      return;
    }
    if (tool === "text") {
      if (this._textDrag && this.selectedText !== null) {
        if (!this._textDrag.pushed) { this.pushHistory("texts"); this._textDrag.pushed = true; }
        const [ix, iy] = this.toImage(p.x, p.y);
        const t = this.texts[this.selectedText];
        const d = this._textDrag;
        if (d.mode === "rotate") {
          let ang = (Math.atan2(iy - t.y, ix - t.x) * 180) / Math.PI + 90;
          if (ang > 180) ang -= 360;
          t.rotation = e.shiftKey ? Math.round(ang / 15) * 15 : Math.round(ang * 10) / 10;
        } else if (d.mode === "resize") {
          const dist = Math.hypot(ix - t.x, iy - t.y);
          t.size = Math.max(6, Math.min(300, Math.round(d.size0 * (dist / d.d0))));
        } else {
          t.x = ix - d.dx;
          t.y = iy - d.dy;
        }
        this.cb.onDirty?.("texts");
        this.cb.onTextChange?.();
        this.render();
      }
      this._pointer.last = p;
      return;
    }
    this._paintSegment(last, p, tool);
    this._pointer.last = p;
  }

  _up(e) {
    if (!this._pointer) return;
    const { tool } = this._pointer;
    this.canvas.classList.remove("panning");

    if (tool === "rect" && this._rectStart && this._rectEnd) {
      const [x0, y0] = this._rectStart, [x1, y1] = this._rectEnd;
      if (Math.abs(x1 - x0) > 0.5 || Math.abs(y1 - y0) > 0.5) {
        this.pushHistory("mask");
        const erase = this._activeTool(e) === "eraser";
        this.maskCtx.globalCompositeOperation = erase ? "destination-out" : "source-over";
        this.maskCtx.fillStyle = "rgba(255,0,0,1)";
        this.maskCtx.fillRect(Math.min(x0, x1), Math.min(y0, y1),
                              Math.abs(x1 - x0), Math.abs(y1 - y0));
        this.maskCtx.globalCompositeOperation = "source-over";
        this.cb.onDirty?.("mask");
      }
    }
    if (tool === "brush" || tool === "eraser") this.cb.onDirty?.("mask");
    if (tool === "draw" || tool === "restore") this.cb.onDirty?.("result");
    if (tool === "heal") {
      const maskData = this._alphaToBW(this.healCanvas);
      this.healCtx.clearRect(0, 0, this.healCanvas.width, this.healCanvas.height);
      if (maskData) {
        this.pushHistory("result");
        this.cb.onHealStroke?.(maskData);
      }
    }
    this._cloneStrokeOffset = null;
    this._cloneSnap = null;
    this._pointer = null;
    this._rectStart = this._rectEnd = null;
    this._textDrag = null;
    this.render();
  }

  _paintSegment(a, b, tool) {
    const [x0, y0] = this.toImage(a.x, a.y);
    const [x1, y1] = this.toImage(b.x, b.y);

    if (tool === "brush" || tool === "eraser") {
      const ctx = this.maskCtx;
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = "rgba(255,0,0,1)";
      this._strokeLine(ctx, x0, y0, x1, y1);
      ctx.globalCompositeOperation = "source-over";
    } else if (tool === "draw") {
      if (this.drawClone) this._cloneStampSegment(x0, y0, x1, y1);
      else {
        const ctx = this.resultCtx;
        ctx.strokeStyle = this.brushColor;
        this._strokeLine(ctx, x0, y0, x1, y1);
      }
    } else if (tool === "restore") {
      const ctx = this.resultCtx;
      const r = this.brushSize / 2;
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = x0 + (x1 - x0) * (s / steps), y = y0 + (y1 - y0) * (s / steps);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(this.original, 0, 0);
        ctx.restore();
      }
    } else if (tool === "heal") {
      const ctx = this.healCtx;
      ctx.strokeStyle = "rgba(0,220,170,1)";
      this._strokeLine(ctx, x0, y0, x1, y1);
    }
    this.render();
  }

  _cloneStampSegment(x0, y0, x1, y1) {
    if (!this._cloneSnap || !this._cloneStrokeOffset) return;
    const [ox, oy] = this._cloneStrokeOffset;
    const ctx = this.resultCtx;
    const src = this._cloneSnap;
    const r = this.brushSize / 2;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r / 2)));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (x1 - x0) * (s / steps);
      const y = y0 + (y1 - y0) * (s / steps);
      const sx = x - ox, sy = y - oy;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(src, sx - r, sy - r, r * 2, r * 2, x - r, y - r, r * 2, r * 2);
      ctx.restore();
    }
  }

  _strokeLine(ctx, x0, y0, x1, y1) {
    ctx.lineWidth = this.brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  setSpacePan(on) {
    this._spacePan = on;
    this.canvas.classList.toggle("tool-pan", on || this.tool === "pan");
  }

  setTool(tool) {
    this.tool = tool;
    this._polyPoints = [];
    this.canvas.style.cursor = "";
    if (tool !== "text") { this.selectedText = null; this.cb.onTextSelect?.(null); }
    this.canvas.classList.toggle("tool-pan", tool === "pan");
    this.canvas.classList.toggle("tool-poly", tool === "poly");
    this.render();
  }

  get polyCount() { return this._polyPoints.length; }

  _nearFirstVertex(p) {
    if (!this._polyPoints.length) return false;
    const v = this.view;
    const [fx, fy] = this._polyPoints[0];
    return Math.hypot(p.x - (v.tx + fx * v.scale), p.y - (v.ty + fy * v.scale)) < 12;
  }

  closePoly() {
    const pts = this._polyPoints;
    this._polyPoints = [];
    if (pts.length < 3) { this.render(); return; }
    this.pushHistory("mask");
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = this._polyErase ? "destination-out" : "source-over";
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    this.cb.onDirty?.("mask");
    this.render();
  }

  cancelPoly() {
    if (!this._polyPoints.length) return false;
    this._polyPoints = [];
    this.render();
    return true;
  }

  popPolyPoint() {
    if (!this._polyPoints.length) return;
    this._polyPoints.pop();
    this.render();
  }

  _textLines(t) { return String(t.text || "").split("\n"); }

  _textFont(t) {
    const fam = { arial: "Arial", comic: '"Comic Sans MS"', verdana: "Verdana",
                  times: '"Times New Roman"', impact: "Impact", tahoma: "Tahoma" }[t.font] || "Arial";
    return `${t.bold ? "bold " : ""}${t.size}px ${fam}`;
  }

  _textBox(t) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = this._textFont(t);
    const lines = this._textLines(t);
    let w = 0;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    ctx.restore();
    const lh = t.size * 1.25;
    const h = lines.length * lh;
    return { x: t.x - w / 2, y: t.y - h / 2, w, h, lh };
  }

  _textLocal(t, ix, iy) {
    const a = (-(t.rotation || 0) * Math.PI) / 180;
    const dx = ix - t.x, dy = iy - t.y;
    return [dx * Math.cos(a) - dy * Math.sin(a),
            dx * Math.sin(a) + dy * Math.cos(a)];
  }

  _hitText(ix, iy) {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      const b = this._textBox(t);
      const [lx, ly] = this._textLocal(t, ix, iy);
      const pad = 8;
      if (Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad) return i;
    }
    return null;
  }

  _handleLayout(t) {
    const b = this._textBox(t);
    const s = this.view.scale;
    const hw = b.w / 2 + 8 / s, hh = b.h / 2 + 8 / s;
    return { hw, hh, rotate: [0, -hh - 24 / s], resize: [hw, hh], r: 7 / s };
  }

  _hitHandle(ix, iy) {
    if (this.selectedText === null || this.tool !== "text") return null;
    const t = this.texts[this.selectedText];
    if (!t) return null;
    const [lx, ly] = this._textLocal(t, ix, iy);
    const g = this._handleLayout(t);
    const hit = 12 / this.view.scale;
    if (Math.hypot(lx - g.rotate[0], ly - g.rotate[1]) <= hit) return "rotate";
    if (Math.hypot(lx - g.resize[0], ly - g.resize[1]) <= hit) return "resize";
    return null;
  }

  addText(item) {
    this.pushHistory("texts");
    this.texts.push(item);
    this.selectedText = this.texts.length - 1;
    this.cb.onDirty?.("texts");
    this.cb.onTextSelect?.(this.selectedText);
    this.render();
  }

  deleteSelectedText() {
    if (this.selectedText === null) return;
    this.pushHistory("texts");
    this.texts.splice(this.selectedText, 1);
    this.selectedText = null;
    this.cb.onDirty?.("texts");
    this.cb.onTextSelect?.(null);
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.original) return;

    const v = this.view;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    ctx.imageSmoothingEnabled = v.scale < 3;

    ctx.shadowColor = "rgba(0,0,0,.5)";
    ctx.shadowBlur = 18 / v.scale;
    ctx.drawImage(this.showOriginal ? this.original : this.resultCanvas, 0, 0);
    ctx.shadowBlur = 0;

    if (!this.showOriginal) {
      if (this.maskVisible && MASK_TOOLS.has(this.tool)) {
        ctx.globalAlpha = this.maskOpacity;
        ctx.drawImage(this.maskCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.healCanvas, 0, 0);
      ctx.globalAlpha = 1;

      for (let i = 0; i < this.texts.length; i++) {
        const t = this.texts[i];
        const lines = this._textLines(t);
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate(((t.rotation || 0) * Math.PI) / 180);
        ctx.font = this._textFont(t);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lh = t.size * 1.25;
        const y0 = -((lines.length - 1) * lh) / 2;
        for (let li = 0; li < lines.length; li++) {
          if (t.stroke > 0) {
            ctx.strokeStyle = t.strokeColor || "#ffffff";
            ctx.lineWidth = t.stroke * 2;
            ctx.lineJoin = "round";
            ctx.strokeText(lines[li], 0, y0 + li * lh);
          }
          ctx.fillStyle = t.color || "#000000";
          ctx.fillText(lines[li], 0, y0 + li * lh);
        }
        if (i === this.selectedText && this.tool === "text") {
          const g = this._handleLayout(t);
          ctx.strokeStyle = "#5b8cff";
          ctx.lineWidth = 1.5 / v.scale;
          ctx.setLineDash([5 / v.scale, 4 / v.scale]);
          ctx.strokeRect(-g.hw, -g.hh, g.hw * 2, g.hh * 2);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(0, -g.hh);
          ctx.lineTo(g.rotate[0], g.rotate[1]);
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(g.rotate[0], g.rotate[1], g.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillRect(g.resize[0] - g.r, g.resize[1] - g.r, g.r * 2, g.r * 2);
          ctx.strokeRect(g.resize[0] - g.r, g.resize[1] - g.r, g.r * 2, g.r * 2);
        }
        ctx.restore();
      }
    }

    if (this._rectStart && this._rectEnd) {
      const [x0, y0] = this._rectStart, [x1, y1] = this._rectEnd;
      ctx.strokeStyle = "#5b8cff";
      ctx.lineWidth = 1.5 / v.scale;
      ctx.setLineDash([6 / v.scale, 4 / v.scale]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1),
                     Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }

    if (this._polyPoints.length) {
      const pts = this._polyPoints;
      const near = this._cursorPos && pts.length >= 3 &&
                   this._nearFirstVertex(this._cursorPos);
      ctx.strokeStyle = this._polyErase ? "#e8b339" : "#5b8cff";
      ctx.lineWidth = 1.5 / v.scale;
      ctx.setLineDash([6 / v.scale, 4 / v.scale]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (this._cursorPos) {
        if (near) ctx.lineTo(pts[0][0], pts[0][1]);
        else {
          const [cx, cy] = this.toImage(this._cursorPos.x, this._cursorPos.y);
          ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < pts.length; i++) {
        ctx.beginPath();
        ctx.arc(pts[i][0], pts[i][1], (i === 0 && near ? 6 : 3.5) / v.scale, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 && near ? "#3fbf75" : "#fff";
        ctx.fill();
      }
    }
    ctx.restore();

    const strokeTools = { brush: "#ff5b5b", eraser: "#e8b339",
                          draw: this.drawClone ? "#c97bff" : this.brushColor,
                          restore: "#3fbf75", heal: "#00dcaa" };
    if (this._cursorPos && strokeTools[this.tool] && !this._spacePan) {
      const r = (this.brushSize / 2) * v.scale;
      ctx.strokeStyle = strokeTools[this.tool];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(this._cursorPos.x, this._cursorPos.y, Math.max(r, 2), 0, Math.PI * 2);
      ctx.stroke();
      if (this.tool === "draw" && this.drawClone && this.cloneSource) {
        const [sx, sy] = this.cloneSource;
        const cx = v.tx + sx * v.scale, cy = v.ty + sy * v.scale;
        const cross = 6;
        ctx.strokeStyle = "#c97bff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - cross, cy); ctx.lineTo(cx + cross, cy);
        ctx.moveTo(cx, cy - cross); ctx.lineTo(cx, cy + cross);
        ctx.stroke();
        if (this._cloneStrokeOffset) {
          const [ox, oy] = this._cloneStrokeOffset;
          const [ix, iy] = this.toImage(this._cursorPos.x, this._cursorPos.y);
          const scx = v.tx + (ix - ox) * v.scale, scy = v.ty + (iy - oy) * v.scale;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.arc(scx, scy, Math.max(r, 2), 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    if (this.tool === "draw" && this.drawClone && this.cloneSource && !this._cursorPos) {
      const [sx, sy] = this.cloneSource;
      const cx = v.tx + sx * v.scale, cy = v.ty + sy * v.scale;
      const cross = 6;
      ctx.strokeStyle = "#c97bff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - cross, cy); ctx.lineTo(cx + cross, cy);
      ctx.moveTo(cx, cy - cross); ctx.lineTo(cx, cy + cross);
      ctx.stroke();
    }

    this.cb.onView?.(v);
  }
}
