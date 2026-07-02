"use strict";

const MASK_TOOLS = new Set(["brush", "eraser", "rect"]);
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
    this.undoStack = [];
    this.redoStack = [];
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
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ kind: entry.kind, data: this._snapshot(entry.kind) });
    await this._restore(entry);
  }

  async redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ kind: entry.kind, data: this._snapshot(entry.kind) });
    await this._restore(entry);
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

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointerleave", () => { this._cursorPos = null; this.render(); });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = this._pos(e);
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
    }, { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("dblclick", (e) => {
      if (this.tool !== "text") return;
      const [ix, iy] = this.toImage(this._pos(e).x, this._pos(e).y);
      const hit = this._hitText(ix, iy);
      if (hit === null) this.cb.onTextCreate?.(ix, iy);
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

    if (e.altKey && (this.tool === "draw")) {
      const [ix, iy] = this.toImage(p.x, p.y);
      const d = this.resultCtx.getImageData(Math.round(ix), Math.round(iy), 1, 1).data;
      const hex = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      this.brushColor = hex;
      this.cb.onColorPick?.(hex);
      return;
    }

    const tool = this._activeTool(e);
    this._pointer = { tool, last: p, moved: false };

    if (tool === "pan") { this.canvas.classList.add("panning"); return; }
    if (tool === "rect") {
      this._rectStart = this.toImage(p.x, p.y);
      this._rectEnd = this._rectStart;
      return;
    }
    if (tool === "text") {
      const [ix, iy] = this.toImage(p.x, p.y);
      const hit = this._hitText(ix, iy);
      if (hit !== null) {
        this.selectedText = hit;
        const t = this.texts[hit];
        this._textDrag = { dx: ix - t.x, dy: iy - t.y, pushed: false };
        this.cb.onTextSelect?.(hit);
      } else {
        this.selectedText = null;
        this.cb.onTextSelect?.(null);
      }
      this.render();
      return;
    }

    if (tool === "brush" || tool === "eraser") this.pushHistory("mask");
    else if (tool === "draw" || tool === "restore") this.pushHistory("result");
    this._paintSegment(p, p, tool);
  }

  _move(e) {
    const p = this._pos(e);
    this._cursorPos = p;
    if (!this._pointer) { this.render(); return; }
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
        t.x = ix - this._textDrag.dx;
        t.y = iy - this._textDrag.dy;
        this.cb.onDirty?.("texts");
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
      this.pushHistory("mask");
      const [x0, y0] = this._rectStart, [x1, y1] = this._rectEnd;
      const erase = this._activeTool(e) === "eraser";
      this.maskCtx.globalCompositeOperation = erase ? "destination-out" : "source-over";
      this.maskCtx.fillStyle = "rgba(255,0,0,1)";
      this.maskCtx.fillRect(Math.min(x0, x1), Math.min(y0, y1),
                            Math.abs(x1 - x0), Math.abs(y1 - y0));
      this.maskCtx.globalCompositeOperation = "source-over";
      this.cb.onDirty?.("mask");
    }
    if (tool === "brush" || tool === "eraser") this.cb.onDirty?.("mask");
    if (tool === "draw" || tool === "restore") this.cb.onDirty?.("result");
    if (tool === "heal") {
      const maskData = this._alphaToBW(this.healCanvas);
      this.healCtx.clearRect(0, 0, this.healCanvas.width, this.healCanvas.height);
      if (maskData) this.cb.onHealStroke?.(maskData);
    }
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
      const ctx = this.resultCtx;
      ctx.strokeStyle = this.brushColor;
      this._strokeLine(ctx, x0, y0, x1, y1);
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
    if (tool !== "text") { this.selectedText = null; this.cb.onTextSelect?.(null); }
    this.canvas.classList.toggle("tool-pan", tool === "pan");
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

  _hitText(ix, iy) {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const b = this._textBox(this.texts[i]);
      const pad = 8;
      if (ix >= b.x - pad && ix <= b.x + b.w + pad &&
          iy >= b.y - pad && iy <= b.y + b.h + pad) return i;
    }
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
        ctx.font = this._textFont(t);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lh = t.size * 1.25;
        const y0 = t.y - ((lines.length - 1) * lh) / 2;
        for (let li = 0; li < lines.length; li++) {
          if (t.stroke > 0) {
            ctx.strokeStyle = t.strokeColor || "#ffffff";
            ctx.lineWidth = t.stroke * 2;
            ctx.lineJoin = "round";
            ctx.strokeText(lines[li], t.x, y0 + li * lh);
          }
          ctx.fillStyle = t.color || "#000000";
          ctx.fillText(lines[li], t.x, y0 + li * lh);
        }
        if (i === this.selectedText && this.tool === "text") {
          const b = this._textBox(t);
          ctx.strokeStyle = "#5b8cff";
          ctx.lineWidth = 1.5 / v.scale;
          ctx.setLineDash([5 / v.scale, 4 / v.scale]);
          ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
          ctx.setLineDash([]);
        }
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
    ctx.restore();

    const strokeTools = { brush: "#ff5b5b", eraser: "#e8b339", draw: this.brushColor,
                          restore: "#3fbf75", heal: "#00dcaa" };
    if (this._cursorPos && strokeTools[this.tool] && !this._spacePan) {
      const r = (this.brushSize / 2) * v.scale;
      ctx.strokeStyle = strokeTools[this.tool];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(this._cursorPos.x, this._cursorPos.y, Math.max(r, 2), 0, Math.PI * 2);
      ctx.stroke();
    }

    this.cb.onView?.(v);
  }
}
