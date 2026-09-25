// 端末の中だけで動く文字認識。外部には何も送信しない。
//  文字の場所さがし: PP-OCRv5 mobile det
//  文字の読み取り: PP-OCRv5 mobile rec（数字・英字・印字に強い）と PP-OCRv4 日本語 rec（手書きのカタカナに強い）の2つ
// 読み取った各位置の「どの文字らしいか」の確率を残し、reader.js が薬の名前の一覧と照らし合わせる。
(function (global) {
  "use strict";
  let det = null, recA = null, recB = null, dictA = null, dictB = null, loading = null;
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
      const [d, a, b, ta, tb] = await Promise.all([
        ort.InferenceSession.create(BASE + "models/det.onnx", opt),
        ort.InferenceSession.create(BASE + "models/rec.onnx", opt),
        ort.InferenceSession.create(BASE + "models/recj.onnx", opt),
        fetch(BASE + "models/rec_dict.txt").then(x => x.text()),
        fetch(BASE + "models/recj_dict.txt").then(x => x.text()),
      ]);
      det = d; recA = a; recB = b;
      dictA = ["", ...ta.split("\n"), " "];   // 0 = blank、末尾 = 空白
      dictB = ["", ...tb.split("\n"), " "];
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

    // 二値化（しきい値0.3）→ 2x2 膨張 → 連結成分ごと
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (prob[i] > 0.3) bin[i] = 1;
    const dil = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (bin[i] || (x > 0 && bin[i - 1]) || (y > 0 && bin[i - W]) || (x > 0 && y > 0 && bin[i - W - 1])) dil[i] = 1;
    }
    const seen = new Uint8Array(W * H), boxes = [], stack = [], comp = [];
    const fx = src.width / W, fy = src.height / H;
    for (let i = 0; i < W * H; i++) {
      if (!dil[i] || seen[i]) continue;
      let x0 = W, y0 = H, x1 = 0, y1 = 0, sum = 0;
      comp.length = 0;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j / W) | 0;
        comp.push(j); sum += prob[j];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && dil[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
        if (x < W - 1 && dil[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
        if (y > 0 && dil[j - W] && !seen[j - W]) { seen[j - W] = 1; stack.push(j - W); }
        if (y < H - 1 && dil[j + W] && !seen[j + W]) { seen[j + W] = 1; stack.push(j + W); }
      }
      const n = comp.length;
      if (Math.min(x1 - x0 + 1, y1 - y0 + 1) < 3 || n < 20) continue;
      if (sum / n < 0.5) continue;       // 文字らしさの平均（成分の画素だけで見る＝斜めの手書き行も落とさない）
      // 主軸（PCA）方向の回転矩形 → 斜めの手書き行もまっすぐ切り出す
      let cx = 0, cy = 0;
      for (const j of comp) { cx += j % W; cy += (j / W) | 0; }
      cx /= n; cy /= n;
      let sxx = 0, syy = 0, sxy = 0;
      for (const j of comp) { const dx = j % W - cx, dy = ((j / W) | 0) - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      if (Math.abs(ang) > Math.PI / 4) ang = 0;   // 縦長は回転させない
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const j of comp) {
        const dx = j % W - cx, dy = ((j / W) | 0) - cy;
        const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const lw = u1 - u0 + 1, lh = v1 - v0 + 1;
      const dist = (lw * lh * 1.6) / (2 * (lw + lh));   // 枠を少し広げる（unclip 1.6 相当）
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      const ccx = cx + uc * ca - vc * sa, ccy = cy + uc * sa + vc * ca;
      boxes.push({
        cx: ccx * fx, cy: ccy * fy, w: (lw + 2 * dist) * fx, h: (lh + 2 * dist) * fy, ang,
        x: Math.max(0, (x0 - dist) * fx), y: Math.max(0, (y0 - dist) * fy),
        x2: Math.min(src.width, (x1 + 1 + dist) * fx), y2: Math.min(src.height, (y1 + 1 + dist) * fy),
      });
    }
    return boxes;
  }

  // 回転矩形を切り出して、高さ48の横長画像のテンソルにする
  function cropTensor(src, b) {
    const bw = Math.round(b.w), bh = Math.round(b.h);
    if (bw < 4 || bh < 4) return null;
    const vertical = bh / bw >= 1.5;
    const ch = 48;
    const ratio = vertical ? bh / bw : bw / bh;
    const rw = Math.min(2400, Math.ceil(ch * ratio));
    const W = Math.max(320, rw);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = ch;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "rgb(128,128,128)";
    ctx.fillRect(0, 0, W, ch);
    ctx.save();
    if (vertical) { ctx.translate(0, ch); ctx.rotate(-Math.PI / 2); ctx.scale(ch / bw, rw / bh); }   // 縦書きは90°回転して横にする
    else ctx.scale(rw / bw, ch / bh);
    // 回転矩形の中心を原点に移し、矩形の傾きを戻して描く
    ctx.translate(bw / 2, bh / 2);
    ctx.rotate(-b.ang);
    ctx.translate(-b.cx, -b.cy);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    const px = ctx.getImageData(0, 0, W, ch).data;
    const t = toTensor(px, W, ch);
    // 余白部分は0（=灰色）にそろえる
    for (let c = 0; c < 3; c++) for (let y = 0; y < ch; y++) for (let x = rw; x < W; x++) t[c * W * ch + y * W + x] = 0;
    return { t, W, ch };
  }

  // 認識モデルを実行し、残す文字（keep）の対数確率だけを取り出す
  async function runRec(sess, dict, keepCols, keepChars, x) {
    const input = new global.ort.Tensor("float32", x.t, [1, 3, x.ch, x.W]);
    const o = await sess.run({ [sess.inputNames[0]]: input });
    const out = o[sess.outputNames[0]];
    const [, T, C] = out.dims;
    const d = out.data, K = keepCols.length;
    const lp = new Float32Array(T * K), blank = new Float32Array(T), max = new Float32Array(T);
    const seq = [];
    let last = -1;
    for (let s = 0; s < T; s++) {
      const off = s * C;
      let best = 0, bv = -Infinity;
      for (let c = 0; c < C; c++) { const v = d[off + c]; if (v > bv) { bv = v; best = c; } }
      max[s] = Math.log(bv + 1e-9);
      blank[s] = Math.log(d[off] + 1e-9);
      for (let k = 0; k < K; k++) lp[s * K + k] = Math.log(d[off + keepCols[k]] + 1e-9);
      if (best !== 0 && best !== last && dict[best]) seq.push({ t: s, ch: dict[best] });
      last = best;
    }
    return { T, chars: keepChars, lp, blank, max, seq };
  }
  function colsFor(dict, keep) {
    const idx = new Map();
    dict.forEach((c, i) => { if (c && !idx.has(c)) idx.set(c, i); });
    const chars = [], cols = [];
    for (const c of keep) if (idx.has(c)) { chars.push(c); cols.push(idx.get(c)); }
    return { chars, cols };
  }

  // keep: reader.js が照合に使う文字。戻り値: { canvas, items: [{ x, x2, top, bottom, A, B }] }
  async function recognize(img, onProgress, keep) {
    await init(onProgress);
    const src = toCanvas(img, 1600, 1440);
    onProgress && onProgress("文字の場所を探しています…");
    const boxes = await detect(src);
    const kA = colsFor(dictA, keep || ""), kB = colsFor(dictB, keep || "");
    const items = [];
    for (let i = 0; i < boxes.length; i++) {
      onProgress && onProgress(`文字を読んでいます… ${i + 1}/${boxes.length}`);
      const b = boxes[i];
      const x = cropTensor(src, b);
      if (!x) continue;
      const A = await runRec(recA, dictA, kA.cols, kA.chars, x);
      const B = await runRec(recB, dictB, kB.cols, kB.chars, x);
      if (!A.seq.length && !B.seq.length) continue;
      items.push({ x: b.cx - b.w / 2, x2: b.cx + b.w / 2, top: b.cy - b.h / 2, bottom: b.cy + b.h / 2, A, B });
    }
    return { canvas: src, items };
  }

  global.LocalOCR = { init, recognize };
})(window);
