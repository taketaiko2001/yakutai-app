// 薬袋に重ねて印刷するPDFを端末の中で作る（pdf-lib）。文字と丸だけを描く。
(function (global) {
  "use strict";
  const MM = 72 / 25.4;
  const BASE = global.YAKUTAI_BASE || "";
  let fontCache = null;

  function loadFonts() {
    if (!fontCache) {
      // JIS第1・第2水準に絞った太字フォント1本を使う
      fontCache = fetch(BASE + "fonts/BIZUDGothic-Bold-jis.ttf")
        .then(r => { if (!r.ok) throw new Error("フォントを読み込めません"); return r.arrayBuffer(); });
      fontCache.catch(() => { fontCache = null; });
    }
    return fontCache;
  }

  function hex(c) {
    const n = parseInt(c.replace("#", ""), 16);
    return global.PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  // paper: { w, h, ox, oy }（mm）… 用紙の大きさと、用紙上で袋の左上が来る位置。省略時は袋と同じ大きさ。
  async function build(bags, common, layout, opts) {
    opts = opts || {};
    const { PDFDocument, rgb } = global.PDFLib;
    const R = global.YakutaiRender;
    const doc = await PDFDocument.create();
    doc.registerFontkit(global.fontkit);
    // pdf-lib の文字の間引き（subset）は日本語フォントで文字が欠けるため使わない
    const font = await doc.embedFont(await loadFonts(), { subset: false });
    doc.setTitle("薬袋");

    for (const bag of bags) {
      const sz = layout.sizes[bag.size];
      const cal = ((layout.calibration || {})[bag.type] || {})[bag.size] || {};
      const paper = (opts.paper && opts.paper.w) ? opts.paper : { w: sz.width_mm, h: sz.height_mm, ox: 0, oy: 0 };
      const page = doc.addPage([paper.w * MM, paper.h * MM]);
      const sx = sz.width_mm / R.U_W, sy = sz.height_mm / R.U_H;
      const geo = off => ({
        x: u => (paper.ox || 0) + u * sx + (off ? (+cal.dx || 0) : 0),
        y: u => (paper.oy || 0) + u * sy + (off ? (+cal.dy || 0) : 0),
      });
      const g = geo(true), ga = geo(false);
      const py = ymm => (paper.h - ymm) * MM;   // PDFは左下が原点

      const drawText = (gg, f, text, color) => {
        const sizeMm = R.fitSize(f, text) * sx;
        const pt = sizeMm * MM;
        const w = font.widthOfTextAtSize(text, pt);
        let x = gg.x(f.x) * MM;
        if (f.align === "right") x -= w; else if (f.align !== "left") x -= w / 2;
        const baseline = gg.y(f.y) + sizeMm * 0.37;   // 文字の縦中央を指定位置に合わせる
        page.drawText(text, { x, y: py(baseline), size: pt, font, color: color || rgb(0, 0, 0) });
      };

      if (opts.art) drawArt(page, bag.type, ga, py, sx, drawText);

      for (const op of R.dataOps(bag, common, layout.templates[bag.type])) {
        if (op.t === "text") drawText(g, op.f, op.text);
        else page.drawEllipse({
          x: g.x(op.m.x) * MM, y: py(g.y(op.m.y)),
          xScale: op.m.rx * sx * MM, yScale: op.m.ry * sx * MM,
          borderWidth: 0.35 * MM, borderColor: rgb(0, 0, 0),
        });
      }
    }
    return doc.save();
  }

  // 位置合わせテスト用に、薬袋の図柄を簡易的に描く
  function drawArt(page, type, g, py, sx, drawText) {
    const art = global.YakutaiRender.ART[type];
    if (!art) return;
    const col = hex(art.color);
    for (const it of art.items) {
      if (it.t) {
        if (it.v || it.c === "#fff") continue;
        drawText(g, { x: it.x, y: it.y, size: it.s, align: it.a || "center", bold: !!it.b }, it.t, col);
      } else if (it.rect || it.fill) {
        const [x1, y1, x2, y2] = it.rect || it.fill;
        page.drawRectangle({
          x: g.x(x1) * MM, y: py(g.y(y2)), width: (g.x(x2) - g.x(x1)) * MM, height: (g.y(y2) - g.y(y1)) * MM,
          borderColor: col, borderWidth: (it.w || 2) * sx * MM, opacity: it.fill ? 0.25 : 1,
          color: it.fill ? col : undefined, borderOpacity: 1,
        });
      } else if (it.line) {
        const [x1, y1, x2] = it.line;
        page.drawLine({ start: { x: g.x(x1) * MM, y: py(g.y(y1)) }, end: { x: g.x(x2) * MM, y: py(g.y(y1)) },
          thickness: (it.w || 2) * sx * MM, color: col, dashArray: it.dash ? [2, 2] : undefined });
      }
    }
  }

  global.BagPDF = { build, loadFonts };
})(window);
