// 端末の中だけで動く文字認識。外部には何も送信しない。
//  文字の場所さがし: PP-OCRv5 mobile det
//  文字の読み取り（3つ）:
//    A: PP-OCRv5 mobile rec（数字・英字・印字に強い）
//    J: PP-OCRv4 日本語 rec（カタカナ）
//    B: NDLOCR-Lite の PARSeq（国立国会図書館、CC BY 4.0。手書きを含めて学習したもの）
// 読み取った各位置の「どの文字らしいか」の確率を残し、reader.js が薬の名前の一覧と照らし合わせる。
(function (global) {
  "use strict";
  let det = null, recA = null, recJ = null, recN = null, dictA = null, dictJ = null, dictN = null, loading = null;
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
      const [d, a, j, n, ta, tj, tn] = await Promise.all([
        ort.InferenceSession.create(BASE + "models/det.onnx", opt),
        ort.InferenceSession.create(BASE + "models/rec.onnx", opt),
        ort.InferenceSession.create(BASE + "models/recj.onnx", opt),
        ort.InferenceSession.create(BASE + "models/ndl.onnx", opt),
        fetch(BASE + "models/rec_dict.txt").then(x => x.text()),
        fetch(BASE + "models/recj_dict.txt").then(x => x.text()),
        fetch(BASE + "models/ndl_chars.json").then(x => x.json()),
      ]);
      det = d; recA = a; recJ = j; recN = n;
      dictA = ["", ...ta.split("\n"), " "];   // 0 = blank、末尾 = 空白
      dictJ = ["", ...tj.split("\n"), " "];
      dictN = ["", ...tn];                     // 0 = 終わりの印
    })();
    try { await loading; } finally { loading = null; }
  }

  // 画像（の rect の範囲）を、長辺が収まるキャンバスへ描く（向き補正済みの ImageBitmap か HTMLImageElement）
  function toCanvas(img, maxSide, minLong, rect) {
    const r = rect || { x: 0, y: 0, w: img.width, h: img.height };
    let s = Math.min(1, maxSide / Math.max(r.w, r.h));
    if (Math.max(r.w, r.h) < minLong) s = minLong / Math.max(r.w, r.h);
    const cv = document.createElement("canvas");
    cv.width = Math.round(r.w * s); cv.height = Math.round(r.h * s);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
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
    // 文字の場所さがしは長辺1600程度で行い（速さとメモリのため）、32の倍数にそろえる（短辺が736未満なら拡大）
    const minSide = Math.min(src.width, src.height);
    let s = Math.min(1, 1600 / Math.max(src.width, src.height));
    if (minSide * s < 736) s = 736 / minSide;
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

  // 回転矩形を、傾きを戻したまっすぐな画像として切り出す（縦長は90°回して横にする）
  function cropUpright(src, b) {
    const bw = Math.round(b.w), bh = Math.round(b.h);
    if (bw < 4 || bh < 4) return null;
    const vertical = bh / bw >= 1.5;
    const cv = document.createElement("canvas");
    cv.width = vertical ? bh : bw; cv.height = vertical ? bw : bh;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    if (vertical) { ctx.translate(0, cv.height); ctx.rotate(-Math.PI / 2); }
    ctx.translate(bw / 2, bh / 2);
    ctx.rotate(-b.ang);
    ctx.translate(-b.cx, -b.cy);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return cv;
  }
  // PP-OCR 用：高さ48にそろえ、幅は比率のまま（最低320、右は灰色）。BGR
  function recTensor(img) {
    const ch = 48;
    const rw = Math.min(2400, Math.ceil(ch * img.width / img.height));
    const W = Math.max(320, rw);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = ch;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "rgb(128,128,128)"; ctx.fillRect(0, 0, W, ch);
    ctx.drawImage(img, 0, 0, rw, ch);
    const t = toTensor(ctx.getImageData(0, 0, W, ch).data, W, ch);
    for (let c = 0; c < 3; c++) for (let y = 0; y < ch; y++) for (let x = rw; x < W; x++) t[c * W * ch + y * W + x] = 0;
    return { t, W, ch };
  }
  // NDLOCR-Lite 用：256×24 に引き伸ばす。RGB
  function ndlTensor(img) {
    const W = 256, H = 24;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data, plane = W * H, out = new Float32Array(3 * plane);
    for (let i = 0, p = 0; p < plane; p++, i += 4) {
      out[p] = d[i] / 127.5 - 1; out[plane + p] = d[i + 1] / 127.5 - 1; out[2 * plane + p] = d[i + 2] / 127.5 - 1;
    }
    return new global.ort.Tensor("float32", out, [1, 3, H, W]);
  }

  // NDLOCR-Lite（1文字ずつ順に出す）を実行し、終わりの印までの各位置について、残す文字の対数確率を取り出す
  async function runNdl(img, keepCols, keepChars) {
    const o = await recN.run({ [recN.inputNames[0]]: ndlTensor(img) });
    const out = o[recN.outputNames[0]];
    const [, P, C] = out.dims, d = out.data, K = keepCols.length;
    const lps = [], seq = [];
    for (let s = 0; s < P; s++) {
      const off = s * C;
      let mx = -Infinity, best = 0;
      for (let c = 0; c < C; c++) if (d[off + c] > mx) { mx = d[off + c]; best = c; }
      if (best === 0) break;                      // 終わりの印
      let sum = 0;
      for (let c = 0; c < C; c++) sum += Math.exp(d[off + c] - mx);
      const lz = mx + Math.log(sum);
      lps.push({ off, lz, mx });
      seq.push({ t: s, ch: dictN[best] });
    }
    const T = lps.length;
    const lp = new Float32Array(T * K), blank = new Float32Array(T).fill(-99), max = new Float32Array(T);
    lps.forEach((q, s) => {
      max[s] = q.mx - q.lz;
      for (let k = 0; k < K; k++) lp[s * K + k] = d[q.off + keepCols[k]] - q.lz;
    });
    return { T, kind: "seq", chars: keepChars, lp, blank, max, seq };
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

  // keep: reader.js が照合に使う文字。rect: 読み取る範囲（元画像の画素、省略で全体）
  // 戻り値: { canvas, items: [{ x, x2, top, bottom, A, B }] }
  // 文字の切り出しは高い解像度（長辺2400まで）から行う（スマホの写真で手書きの行が小さくつぶれないように）
  async function recognize(img, onProgress, keep, rect) {
    await init(onProgress);
    const src = toCanvas(img, 2400, 1440, rect);
    onProgress && onProgress("文字の場所を探しています…");
    const boxes = await detect(src);
    const kA = colsFor(dictA, keep || ""), kJ = colsFor(dictJ, keep || ""), kN = colsFor(dictN, keep || "");
    const items = [];
    for (let i = 0; i < boxes.length; i++) {
      onProgress && onProgress(`文字を読んでいます… ${i + 1}/${boxes.length}`);
      const b = boxes[i];
      const img = cropUpright(src, b);
      if (!img) continue;
      const x = recTensor(img);
      const A = await runRec(recA, dictA, kA.cols, kA.chars, x);
      const J = await runRec(recJ, dictJ, kJ.cols, kJ.chars, x);
      const B = await runNdl(img, kN.cols, kN.chars);
      if (!A.seq.length && !J.seq.length && !B.seq.length) continue;
      items.push({ x: b.cx - b.w / 2, x2: b.cx + b.w / 2, top: b.cy - b.h / 2, bottom: b.cy + b.h / 2, A, J, B });
    }
    return { canvas: src, items };
  }

  global.LocalOCR = { init, recognize };
})(window);
