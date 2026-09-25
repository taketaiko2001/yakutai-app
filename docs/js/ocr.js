// 端末の中だけで動く文字認識（PP-OCRv5 mobile を onnxruntime-web で実行）。外部には何も送信しない。
(function (global) {
  "use strict";
  let det = null, rec = null, dict = null, loading = null;
  const BASE = global.YAKUTAI_BASE || "";   // アプリのファイル置き場（テスト時だけ変える）

  async function init(onProgress) {
    if (det) return;
    if (loading) return loading;
    loading = (async () => {
      const ort = global.ort;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = new URL(BASE + "lib/", location.href).href;
      onProgress && onProgress("文字認識の準備中…（初回のみ少し時間がかかります）");
      const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const [d, r, txt] = await Promise.all([
        ort.InferenceSession.create(BASE + "models/det.onnx", opt),
        ort.InferenceSession.create(BASE + "models/rec.onnx", opt),
        fetch(BASE + "models/rec_dict.txt").then(x => x.text()),
      ]);
      det = d; rec = r;
      dict = ["", ...txt.split("\n"), " "];   // 0 = blank、末尾 = 空白
    })();
    try { await loading; } finally { loading = null; }
  }

  // 画像を、長辺が収まるキャンバスへ描く（向き補正済みの ImageBitmap か HTMLImageElement）
  function toCanvas(img, maxSide, minLong) {
    const w0 = img.width, h0 = img.height;
    let s = Math.min(1, maxSide / Math.max(w0, h0));
    if (Math.max(w0, h0) < minLong) s = minLong / Math.max(w0, h0);
    const cv = document.createElement("canvas");
    cv.width = Math.round(w0 * s); cv.height = Math.round(h0 * s);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv;
  }

  // RGBA → BGR の CHW 配列（(x/255 - 0.5)/0.5）
  function toTensor(data, w, h) {
    const out = new Float32Array(3 * w * h), plane = w * h;
    for (let i = 0, p = 0; p < plane; p++, i += 4) {
      out[p] = data[i + 2] / 127.5 - 1;
      out[plane + p] = data[i + 1] / 127.5 - 1;
      out[2 * plane + p] = data[i] / 127.5 - 1;
    }
    return out;
  }

  async function detect(src) {
    // 32の倍数にそろえる（短辺が736未満なら拡大）
    let s = 1;
    const minSide = Math.min(src.width, src.height);
    if (minSide < 736) s = 736 / minSide;
    const W = Math.max(32, Math.round(src.width * s / 32) * 32), H = Math.max(32, Math.round(src.height * s / 32) * 32);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const input = new global.ort.Tensor("float32", toTensor(px, W, H), [1, 3, H, W]);
    const outMap = await det.run({ [det.inputNames[0]]: input });
    const prob = outMap[det.outputNames[0]].data;

    // 二値化（しきい値0.3）→ 2x2 膨張 → 連結成分ごとの外接矩形
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (prob[i] > 0.3) bin[i] = 1;
    const dil = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (bin[i] || (x > 0 && bin[i - 1]) || (y > 0 && bin[i - W]) || (x > 0 && y > 0 && bin[i - W - 1])) dil[i] = 1;
    }
    const seen = new Uint8Array(W * H), boxes = [], stack = [];
    for (let i = 0; i < W * H; i++) {
      if (!dil[i] || seen[i]) continue;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && dil[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
        if (x < W - 1 && dil[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
        if (y > 0 && dil[j - W] && !seen[j - W]) { seen[j - W] = 1; stack.push(j - W); }
        if (y < H - 1 && dil[j + W] && !seen[j + W]) { seen[j + W] = 1; stack.push(j + W); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (Math.min(bw, bh) < 3) continue;
      let sum = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += prob[y * W + x];
      if (sum / (bw * bh) < 0.5) continue;
      // 枠を少し広げる（unclip 1.6 相当）
      const dist = (bw * bh * 1.6) / (2 * (bw + bh));
      const fx = src.width / W, fy = src.height / H;
      boxes.push({
        x: Math.max(0, (x0 - dist) * fx), y: Math.max(0, (y0 - dist) * fy),
        x2: Math.min(src.width, (x1 + 1 + dist) * fx), y2: Math.min(src.height, (y1 + 1 + dist) * fy),
      });
    }
    return boxes;
  }

  async function recognizeBox(src, b) {
    let bw = Math.round(b.x2 - b.x), bh = Math.round(b.y2 - b.y);
    if (bw < 4 || bh < 4) return null;
    const vertical = bh / bw >= 1.5;
    const crop = document.createElement("canvas");
    const ch = 48;
    const ratio = vertical ? bh / bw : bw / bh;
    const rw = Math.min(2400, Math.ceil(ch * ratio));
    const W = Math.max(320, rw);
    crop.width = W; crop.height = ch;
    const ctx = crop.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "rgb(128,128,128)";
    ctx.fillRect(0, 0, W, ch);
    if (vertical) {   // 縦書きは90°回転して横にする
      ctx.save();
      ctx.translate(0, ch);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(src, b.x, b.y, bw, bh, 0, 0, ch, rw);
      ctx.restore();
    } else {
      ctx.drawImage(src, b.x, b.y, bw, bh, 0, 0, rw, ch);
    }
    const px = ctx.getImageData(0, 0, W, ch).data;
    const t = toTensor(px, W, ch);
    // 余白部分は0（=灰色）にそろえる
    for (let c = 0; c < 3; c++) for (let y = 0; y < ch; y++) for (let x = rw; x < W; x++) t[c * W * ch + y * W + x] = 0;
    const input = new global.ort.Tensor("float32", t, [1, 3, ch, W]);
    const o = await rec.run({ [rec.inputNames[0]]: input });
    const out = o[rec.outputNames[0]];
    const [, T, C] = out.dims;
    const d = out.data;
    let text = "", last = -1, scoreSum = 0, n = 0;
    for (let s = 0; s < T; s++) {
      let best = 0, bv = -Infinity;
      const off = s * C;
      for (let c = 0; c < C; c++) { const v = d[off + c]; if (v > bv) { bv = v; best = c; } }
      if (best !== 0 && best !== last) { text += dict[best] || ""; scoreSum += bv; n++; }
      last = best;
    }
    return text.trim() ? { text: text.trim(), score: n ? scoreSum / n : 0 } : null;
  }

  // 同じ高さに並ぶ文字をつないで「行」にし、上から順に返す
  function groupLines(items) {
    items.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
    const rows = [];
    for (const it of items) {
      const cy = (it.top + it.bottom) / 2, h = it.bottom - it.top;
      const row = rows.find(r => Math.abs(r.cy - cy) < Math.max(r.h, h) * 0.55);
      if (row) row.items.push(it); else rows.push({ cy, h, items: [it] });
    }
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      return { text: r.items.map(i => i.text).join(" "), score: Math.min(...r.items.map(i => i.score)) };
    });
  }

  async function recognize(img, onProgress) {
    await init(onProgress);
    const src = toCanvas(img, 1600, 1440);
    onProgress && onProgress("文字の場所を探しています…");
    const boxes = await detect(src);
    const items = [];
    for (let i = 0; i < boxes.length; i++) {
      onProgress && onProgress(`文字を読んでいます… ${i + 1}/${boxes.length}`);
      const r = await recognizeBox(src, boxes[i]);
      if (r) items.push({ text: r.text, score: r.score, x: boxes[i].x, top: boxes[i].y, bottom: boxes[i].y2 });
    }
    return groupLines(items);
  }

  global.LocalOCR = { init, recognize };
})(window);
