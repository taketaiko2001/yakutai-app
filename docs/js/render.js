// 薬袋1枚分のHTMLを組み立てる。画面プレビューとPDF出力の両方で使う。
// 座標は layout.json と同じ「横1000・縦1414」の相対値で、描画時にmmへ換算する。
(function (global) {
  "use strict";
  const U_W = 1000, U_H = 1414;
  const FONT = '"BIZ UDGothic","BIZ UDゴシック","Yu Gothic","Meiryo",sans-serif';

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  // 全角=1em、半角=0.55em として幅を概算する
  function textEm(s) {
    let w = 0;
    for (const ch of String(s)) w += /[\x20-\x7e]/.test(ch) ? 0.55 : 1.0;
    return w;
  }

  function geom(layout, type, size, withOffset) {
    const sz = layout.sizes[size];
    const cal = withOffset ? (((layout.calibration || {})[type] || {})[size] || {}) : {};
    const W = sz.width_mm, H = sz.height_mm, dx = +cal.dx || 0, dy = +cal.dy || 0;
    return {
      W, H,
      x: u => u * W / U_W + dx,
      y: u => u * H / U_H + dy,
      s: u => u * W / U_W,
    };
  }

  function textEl(g, f, text, cls, style) {
    if (text === "" || text == null) return "";
    let size = f.size;
    if (f.maxw) {
      const em = textEm(text);
      if (em * size > f.maxw) size = f.maxw / em;
    }
    const tx = f.align === "right" ? "-100%" : f.align === "left" ? "0" : "-50%";
    return `<div class="${cls}" style="left:${g.x(f.x).toFixed(2)}mm;top:${g.y(f.y).toFixed(2)}mm;` +
      `font-size:${g.s(size).toFixed(2)}mm;transform:translate(${tx},-50%);` +
      `${f.bold ? "font-weight:700;" : ""}${style || ""}">${esc(text)}</div>`;
  }

  function ellipseEl(g, m, cls, style) {
    const w = g.s(m.rx * 2), h = g.s(m.ry * 2);
    return `<div class="${cls}" style="left:${(g.x(m.x) - w / 2).toFixed(2)}mm;top:${(g.y(m.y) - h / 2).toFixed(2)}mm;` +
      `width:${w.toFixed(2)}mm;height:${h.toFixed(2)}mm;${style || ""}"></div>`;
  }

  // ---- 薬袋の印刷済み図柄（プレビュー／位置合わせテスト用の簡易図） ----
  const ART = {
    naifuku: {
      color: "#1f9a4c",
      items: [
        { rect: [97, 215, 347, 462], r: 22, w: 7 },
        { pill: [222, 338] },
        { t: "様", x: 858, y: 305, s: 55, b: 1 },
        { fill: [375, 350, 1000, 462], r: 18 },
        { t: "のみぐすり", x: 630, y: 406, s: 82, b: 1, c: "#fff" },
        { t: "年", x: 592, y: 512, s: 30 }, { t: "月", x: 735, y: 512, s: 30 }, { t: "日", x: 877, y: 512, s: 30 },
        { t: "1日", x: 210, y: 607, s: 58, b: 1 }, { t: "回", x: 497, y: 607, s: 50, b: 1, box: 1 }, { t: "日分", x: 787, y: 607, s: 58, b: 1 },
        { line: [95, 650, 890, 650], w: 5 },
        { t: "1回に", x: 235, y: 760, s: 42, b: 1 },
        { t: "こな薬", x: 435, y: 708, s: 34 }, { t: "包", x: 808, y: 708, s: 34 },
        { t: "カプセル", x: 435, y: 762, s: 34 }, { t: "個", x: 808, y: 762, s: 34 },
        { t: "錠　剤", x: 435, y: 815, s: 34 }, { t: "錠", x: 808, y: 815, s: 34 },
        { t: "朝", x: 232, y: 880, s: 34 }, { t: "・", x: 265, y: 880, s: 34 }, { t: "昼", x: 298, y: 880, s: 34 },
        { t: "・", x: 337, y: 880, s: 34 }, { t: "夕", x: 377, y: 880, s: 34 }, { t: "・", x: 416, y: 880, s: 34 },
        { t: "ねる前", x: 477, y: 880, s: 34 }, { t: "・", x: 537, y: 880, s: 34 },
        { line: [565, 902, 665, 902], w: 3 }, { t: "時間毎", x: 720, y: 880, s: 34 },
        { t: "食後", x: 352, y: 935, s: 34 }, { t: "・", x: 422, y: 935, s: 34 }, { t: "食前", x: 492, y: 935, s: 34 },
        { t: "・", x: 562, y: 935, s: 34 }, { t: "食間", x: 633, y: 935, s: 34 },
        { rect: [270, 1000, 715, 1115], r: 18, w: 3 },
        { t: "とんぷく", x: 492, y: 1000, s: 34, b: 1, bg: 1 },
        { t: "1回", x: 330, y: 1040, s: 30 }, { t: "個(包)", x: 487, y: 1040, s: 30 }, { t: "回分", x: 655, y: 1040, s: 30 },
        { line: [305, 1062, 690, 1062], w: 2 },
        { t: "痛い時・発熱時・かゆい時", x: 487, y: 1085, s: 28 },
        { logo: [95, 1230] },
        { t: "いちはら皮フ科クリニック", x: 175, y: 1192, s: 56, b: 1, a: "left" },
        { t: "安八郡安八町南條695−1", x: 178, y: 1258, s: 30, a: "left" },
        { t: "TEL (0584)64−5557", x: 178, y: 1310, s: 30, a: "left" },
        { t: "http://ichihara-clinic.org/", x: 178, y: 1356, s: 26, a: "left" },
        { rect: [650, 1235, 965, 1375], r: 0, w: 3 }, { line: [705, 1235, 705, 1375], w: 2 }, { line: [830, 1235, 830, 1375], w: 2 },
        { t: "確認印", x: 678, y: 1305, s: 24, v: 1 },
      ],
    },
    gaiyou: {
      color: "#cf4f2a",
      items: [
        { rect: [97, 350, 260, 515], r: 18, w: 7 },
        { tube: [178, 432] },
        { t: "様", x: 862, y: 305, s: 55, b: 1 },
        { fill: [283, 350, 1000, 462], r: 18 },
        { t: "外　用　薬", x: 590, y: 406, s: 82, b: 1, c: "#fff" },
        { t: "(のまないでください)", x: 590, y: 492, s: 32, b: 1 },
        { t: "年", x: 588, y: 552, s: 30 }, { t: "月", x: 733, y: 552, s: 30 }, { t: "日", x: 878, y: 552, s: 30 },
        { t: "1日", x: 355, y: 642, s: 58, b: 1 }, { t: "回", x: 668, y: 642, s: 50, b: 1, box: 1 },
        { line: [95, 688, 895, 688], w: 5 },
        { t: "ぬり薬", x: 252, y: 722, s: 34 }, { t: "点眼薬", x: 500, y: 722, s: 34 }, { t: "点鼻薬", x: 745, y: 722, s: 34 },
        { t: "点耳薬", x: 250, y: 778, s: 34 }, { t: "貼り薬", x: 500, y: 778, s: 34 }, { t: "うがい薬", x: 745, y: 778, s: 34 },
        { t: "トローチ", x: 250, y: 832, s: 34 }, { t: "消毒用の薬", x: 500, y: 832, s: 28 },
        { t: "坐　薬", x: 245, y: 885, s: 34 }, { t: "(発熱時に", x: 425, y: 885, s: 30 },
        { line: [500, 905, 600, 905], w: 2 }, { t: "℃以上)", x: 660, y: 885, s: 30 },
        { line: [100, 928, 885, 928], w: 2, dash: 1 },
        { t: "1.  坐薬は肛門内にそう入して使用して下さい。", x: 120, y: 968, s: 30, a: "left" },
        { t: "肛門坐薬です。冷蔵庫に保存して下さい。", x: 185, y: 1022, s: 30, a: "left" },
        { t: "2.  トローチは、なめて下さい。", x: 120, y: 1078, s: 30, a: "left" },
        { line: [90, 1112, 895, 1112], w: 3 },
        { logo: [95, 1240] },
        { t: "いちはら皮フ科クリニック", x: 175, y: 1200, s: 56, b: 1, a: "left" },
        { t: "安八郡安八町南條695−1", x: 178, y: 1268, s: 30, a: "left" },
        { t: "TEL (0584)64−5557", x: 178, y: 1320, s: 30, a: "left" },
        { t: "http://ichihara-clinic.org/", x: 178, y: 1362, s: 26, a: "left" },
        { rect: [655, 1245, 965, 1380], r: 0, w: 3 }, { line: [710, 1245, 710, 1380], w: 2 }, { line: [835, 1245, 835, 1380], w: 2 },
        { t: "確認印", x: 683, y: 1312, s: 24, v: 1 },
      ],
    },
  };

  function artHtml(type, g) {
    const art = ART[type];
    if (!art) return "";
    const col = art.color;
    const px = (a, b) => `left:${g.x(a).toFixed(2)}mm;top:${g.y(b).toFixed(2)}mm;`;
    const box = (x1, y1, x2, y2) => px(x1, y1) + `width:${(g.x(x2) - g.x(x1)).toFixed(2)}mm;height:${(g.y(y2) - g.y(y1)).toFixed(2)}mm;`;
    let h = "";
    for (const it of art.items) {
      if (it.t) {
        const f = { x: it.x, y: it.y, size: it.s, align: it.a || "center", bold: !!it.b };
        let st = `color:${it.c || col};`;
        if (it.box) st += `border:${g.s(5).toFixed(2)}mm solid ${col};padding:0 ${g.s(4).toFixed(2)}mm;border-radius:${g.s(6).toFixed(2)}mm;`;
        if (it.bg) st += "background:#fff;padding:0 1mm;";
        if (it.v) st += "writing-mode:vertical-rl;letter-spacing:0.3mm;";
        h += textEl(g, f, it.t, "yt-art", st);
      } else if (it.rect) {
        const [x1, y1, x2, y2] = it.rect;
        h += `<div class="yt-art" style="${box(x1, y1, x2, y2)}border:${g.s(it.w).toFixed(2)}mm solid ${col};border-radius:${g.s(it.r).toFixed(2)}mm;"></div>`;
      } else if (it.fill) {
        const [x1, y1, x2, y2] = it.fill;
        h += `<div class="yt-art" style="${box(x1, y1, x2, y2)}background:${col};border-radius:${g.s(it.r).toFixed(2)}mm 0 0 ${g.s(it.r).toFixed(2)}mm;"></div>`;
      } else if (it.line) {
        const [x1, y1, x2] = it.line;
        h += `<div class="yt-art" style="${px(x1, y1)}width:${(g.x(x2) - g.x(x1)).toFixed(2)}mm;border-top:${g.s(it.w).toFixed(2)}mm ${it.dash ? "dotted" : "solid"} ${col};"></div>`;
      } else if (it.pill) {
        const [cx, cy] = it.pill, w = g.s(230), hh = g.s(90);
        h += `<div class="yt-art" style="left:${(g.x(cx) - w / 2).toFixed(2)}mm;top:${(g.y(cy) - hh / 2).toFixed(2)}mm;width:${w.toFixed(2)}mm;height:${hh.toFixed(2)}mm;` +
          `border:${g.s(8).toFixed(2)}mm solid ${col};border-radius:${hh.toFixed(2)}mm;transform:rotate(-45deg);` +
          `background:linear-gradient(90deg,${col} 50%,#fff 50%);"></div>`;
      } else if (it.tube) {
        const [cx, cy] = it.tube, w = g.s(150), hh = g.s(55);
        h += `<div class="yt-art" style="left:${(g.x(cx) - w / 2).toFixed(2)}mm;top:${(g.y(cy) - hh / 2).toFixed(2)}mm;width:${w.toFixed(2)}mm;height:${hh.toFixed(2)}mm;` +
          `border:${g.s(6).toFixed(2)}mm solid ${col};border-radius:${g.s(8).toFixed(2)}mm;transform:rotate(-40deg);` +
          `background:linear-gradient(90deg,#fff 45%,${col} 45%,${col} 70%,#fff 70%);"></div>`;
      } else if (it.logo) {
        const [cx, cy] = it.logo, d = g.s(110);
        h += `<div class="yt-art" style="left:${(g.x(cx) - d / 2).toFixed(2)}mm;top:${(g.y(cy) - d / 2).toFixed(2)}mm;width:${d.toFixed(2)}mm;height:${d.toFixed(2)}mm;` +
          `border:${g.s(14).toFixed(2)}mm dotted ${col};border-radius:50%;"></div>`;
      }
    }
    return h;
  }

  // ---- 印字する内容（画面プレビューとPDFで共通の「何をどこに書くか」の一覧） ----
  function dataOps(bag, common, tpl) {
    const F = tpl.fields, M = tpl.marks, ops = [];
    const T = (key, val, override) => {
      if (F[key] && val !== "" && val != null) ops.push({ t: "text", f: Object.assign({}, F[key], override || {}), text: String(val) });
    };
    const O = key => { if (M[key]) ops.push({ t: "mark", m: M[key] }); };
    T("name", common.name);
    T("year", common.year_text);
    T("month", common.month);
    T("day", common.day);
    T("times", bag.times);
    if (bag.type === "naifuku") {
      T("days", bag.days);
      let lastRow = null;
      for (const k of ["powder", "capsule", "tablet"]) if (bag[k]) { T(k, bag[k]); lastRow = k; }
      if (bag.dose_note && F.dose_note) T("dose_note", bag.dose_note, { y: F[lastRow || "tablet"].y });
      (bag.timing || []).forEach(O);
      T("interval", bag.interval);
      if (bag.meal) O(bag.meal);
      if (bag.tonpuku) {
        T("tonpuku_amount", bag.tonpuku_amount);
        T("tonpuku_count", bag.tonpuku_count);
        (bag.tonpuku_when || []).forEach(O);
      }
    } else {
      T("site", bag.site);
      if (bag.kind) O(bag.kind);
      if (bag.kind === "坐薬") T("zayaku_temp", bag.zayaku_temp);
    }
    return ops;
  }
  function fitSize(f, text) {
    let size = f.size;
    if (f.maxw) { const em = textEm(text); if (em * size > f.maxw) size = f.maxw / em; }
    return size;
  }
  function dataHtml(bag, common, tpl, g) {
    return dataOps(bag, common, tpl).map(op => op.t === "text"
      ? textEl(g, op.f, op.text, "yt-t")
      : ellipseEl(g, op.m, "yt-m")).join("");
  }

  // 1枚分。opts.art=true で薬袋の図柄も描く（プレビュー・位置合わせテスト用）
  function renderPage(bag, common, layout, opts) {
    opts = opts || {};
    const tpl = layout.templates[bag.type];
    const gData = geom(layout, bag.type, bag.size, !opts.noOffset);
    const gArt = geom(layout, bag.type, bag.size, false);
    return `<section class="yt-page yt-size-${esc(bag.size)}" style="width:${gData.W}mm;height:${gData.H}mm;">` +
      (opts.art ? artHtml(bag.type, gArt) : "") +
      dataHtml(bag, common, tpl, gData) +
      "</section>";
  }

  function pageCss(layout) {
    let css = "";
    for (const [key, sz] of Object.entries(layout.sizes)) {
      css += `@page yt-${key} { size: ${sz.width_mm}mm ${sz.height_mm}mm; margin: 0; }\n` +
        `.yt-size-${key} { page: yt-${key}; }\n`;
    }
    css += `
.yt-page { position: relative; overflow: hidden; background: #fff; box-sizing: border-box; }
.yt-page + .yt-page { break-before: page; }
.yt-t, .yt-art { position: absolute; white-space: nowrap; line-height: 1; font-family: ${FONT}; box-sizing: border-box; }
.yt-t { color: #000; }
.yt-m { position: absolute; border: 0.35mm solid #000; border-radius: 50%; box-sizing: border-box; }
`;
    return css;
  }

  global.YakutaiRender = { renderPage, pageCss, textEm, dataOps, fitSize, ART, U_W, U_H };
})(typeof window !== "undefined" ? window : globalThis);
