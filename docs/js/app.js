"use strict";
// 薬袋プリント（スマホ版）画面の処理。すべて端末の中で動く。
const $ = s => document.querySelector(s);
const PX_PER_MM = 96 / 25.4;
const APP_VERSION = "2026-09-25e";
const PAPERS = { A4: [210, 297], A5: [148, 210], A6: [105, 148], hagaki: [100, 148] };
const TIMINGS = ["朝", "昼", "夕", "ねる前"], MEALS = ["食後", "食前", "食間"], TONPUKU_WHEN = ["痛い時", "発熱時", "かゆい時"];
const KINDS = KarteParser.GAIYOU_KINDS;
const NAIFUKU_FORMS = ["錠剤", "カプセル", "こな薬"];

const S = {
  bags: [], common: { name: "", year: "", month: "", day: "" },
  photo: null, photoUrl: "", ocrInitial: "", pdfs: [],
  readLines: [],   // 読み取った行（写真の切り抜き・選び直し候補つき）
  rect: null,      // 読み取る範囲（写真の画素。null なら全体）
};

// ---------------------------------------------------------------- 共通
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function toHalf(s) { return String(s == null ? "" : s).normalize("NFKC").trim(); }
function busy(on, text) { $("#busy").hidden = !on; if (text) $("#busyText").textContent = text; }
function today() { const d = new Date(); return { year: String(d.getFullYear() - 2018), month: String(d.getMonth() + 1), day: String(d.getDate()) }; }
function ctx(allowUnknown) {
  const d = Store.data;
  return { drugs: d.drugs, sites: d.sites, sets: d.sets || [], learn: d.learn, gaiyouDefaultTimes: d.settings.gaiyouDefaultTimes, allowUnknown };
}
function commonForPrint() {
  const y = toHalf(S.common.year);
  return { name: S.common.name.trim(), year_text: y ? (Store.data.settings.yearFormat === "number" ? y : "令和" + y) : "",
    month: toHalf(S.common.month), day: toHalf(S.common.day) };
}
let toastTimer = null;
function toast(html, buttons, ms) {
  const t = $("#toast");
  t.innerHTML = html + (buttons ? `<div class="row2">${buttons.map((b, i) => `<button class="btn" data-i="${i}">${esc(b.label)}</button>`).join("")}</div>` : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  t.onclick = e => {
    const b = e.target.closest("[data-i]");
    if (b) { buttons[+b.dataset.i].act(); t.hidden = true; }
  };
  if (!buttons) toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2500);
}

// ---------------------------------------------------------------- ① 写真と読み取り
async function setPhoto(fileOrBlob) {
  if (!fileOrBlob) return;
  try {
    S.photo = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  } catch (e) {
    const img = new Image();
    img.src = URL.createObjectURL(fileOrBlob);
    await img.decode();
    S.photo = img;
  }
  if (S.photoUrl) URL.revokeObjectURL(S.photoUrl);
  S.photoUrl = URL.createObjectURL(fileOrBlob);
  $("#photo").src = S.photoUrl;
  S.rect = null; $("#photoSel").hidden = true; endSelect();
  $("#photoBig").src = S.photoUrl;
  $("#photoBox").hidden = false;
  await readPhoto();
}
async function readPhoto() {
  if (!S.photo) return;
  const st = $("#ocrStatus");
  busy(true, "読み取りの準備中…");
  try {
    const d = Store.data;
    const lex = KarteReader.buildLexicon(d, d.learn);
    const t0 = performance.now();
    const { canvas, items } = await LocalOCR.recognize(S.photo, msg => busy(true, msg), KarteReader.keepChars(lex), S.rect);
    const rows = KarteReader.makeRows(items);
    const lines = KarteReader.read(rows, lex);
    applyOcrFix(lines);
    S.readLines = lines.filter(l => l.kind !== "date").map(l => ({ text: l.text, cur: l.text, kind: l.kind, alts: l.alts, raw: rowRaw(l.row), img: cropRow(canvas, l.row.box) }));
    const text = lines.map(l => l.text).join("\n");
    $("#karteText").value = text;
    S.ocrInitial = lines.map(l => ({ text: l.text, raw: rowRaw(l.row) }));
    const res = KarteParser.parse(text, ctx(false));
    applyParsed(res);
    renderReadRows();
    const unsure = lines.filter(l => l.kind === "raw" || /？$/.test(l.text)).length;
    st.hidden = false;
    st.className = "status" + (unsure ? " warn" : "");
    st.textContent = `読み取りました（${((performance.now() - t0) / 1000).toFixed(0)}秒・薬袋 ${res.bags.length} 袋分）。` +
      (unsure ? `自信のない行が ${unsure} 行あります。下の「読み取った行」で写真と見比べ、違っていれば候補をタップしてください。` : "写真と見比べて確認してください。") +
      (S.rect ? "" : "（「範囲を囲んで読み直す」で今回の処方の部分だけを囲むと、精度が上がることがあります）");
  } catch (e) {
    st.hidden = false; st.className = "status warn";
    st.textContent = "読み取りできませんでした: " + e.message + "（②に手で入力しても使えます）";
  } finally { busy(false); }
}

// 写真の上を指でなぞって、読み取る範囲を囲む
let selStart = null;
function startSelect() {
  $("#photoWrap").classList.add("selecting"); $("#selNote").hidden = false;
  $("#photoWrap").scrollIntoView({ behavior: "smooth", block: "center" });
}
function endSelect() { $("#photoWrap").classList.remove("selecting"); $("#selNote").hidden = true; selStart = null; }
function bindSelect() {
  const wrap = $("#photoWrap"), sel = $("#photoSel");
  const pos = e => { const r = $("#photo").getBoundingClientRect(); return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) }; };
  const draw = (a, b) => {
    Object.assign(sel.style, { left: Math.min(a.x, b.x) + "px", top: Math.min(a.y, b.y) + "px", width: Math.abs(a.x - b.x) + "px", height: Math.abs(a.y - b.y) + "px" });
    sel.hidden = false;
  };
  wrap.addEventListener("pointerdown", e => {
    if (!wrap.classList.contains("selecting")) return;
    e.preventDefault(); selStart = pos(e); wrap.setPointerCapture(e.pointerId); draw(selStart, selStart);
  });
  wrap.addEventListener("pointermove", e => { if (selStart) draw(selStart, pos(e)); });
  wrap.addEventListener("pointerup", e => {
    if (!selStart) return;
    const a = selStart, b = pos(e), img = $("#photo");
    endSelect();
    if (Math.abs(a.x - b.x) < 20 || Math.abs(a.y - b.y) < 20) { sel.hidden = true; toast("囲む範囲が小さすぎます。もう一度なぞってください。"); return; }
    const k = S.photo.width / img.clientWidth;
    S.rect = { x: Math.round(Math.min(a.x, b.x) * k), y: Math.round(Math.min(a.y, b.y) * k), w: Math.round(Math.abs(a.x - b.x) * k), h: Math.round(Math.abs(a.y - b.y) * k) };
    readPhoto();
  });
}
function rowRaw(row) { return row ? [row.ta, row.tb].join(" | ") : ""; }
// 読み取った行の部分を写真から切り抜く（確認用の小さな画像）
function cropRow(canvas, box) {
  if (!box) return "";
  const pad = (box.bottom - box.top) * 0.25;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.top - pad);
  const w = Math.min(canvas.width, box.x2 + pad) - x, h = Math.min(canvas.height, box.bottom + pad) - y;
  if (w < 4 || h < 4) return "";
  const H = 96, W = Math.min(900, Math.round(w * H / h));
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  cv.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, W, H);
  return cv.toDataURL("image/jpeg", 0.75);
}
// 以前に人が直した読み違いと同じものは、直した内容に置き換える
function applyOcrFix(lines) {
  const learn = Store.data.learn;
  if (!learn.ocrFix || !Object.keys(learn.ocrFix).length) return;
  for (const l of lines) {
    if (l.kind === "date" || !(l.kind === "raw" || /？$/.test(l.text))) continue;
    const fix = KarteParser.lookupOcrFix(rowRaw(l.row), learn);
    if (fix) {
      l.alts = [{ label: "前回の訂正", text: fix }, ...l.alts];
      l.text = fix + " ？"; l.kind = "learned";
    }
  }
}

// ---------------------------------------------------------------- ② カルテの内容
function parseText(noScroll) {
  const res = KarteParser.parse($("#karteText").value, ctx(true));
  applyParsed(res);
  if (noScroll !== true) $("#bagSection").scrollIntoView({ behavior: "smooth", block: "start" });
}
// 読み取った行ごとに、写真の切り抜きと選び直し候補を出す
function renderReadRows() {
  const box = $("#readRows");
  if (!S.readLines.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `<div class="sub-title">読み取った行（写真と見比べて、違っていれば候補をタップ）</div>` + S.readLines.map((l, i) => {
    const bad = l.kind === "raw" || /？$/.test(l.cur);
    return `<div class="rr${bad ? " rr-bad" : ""}" data-r="${i}">
      ${l.img ? `<img src="${l.img}" alt="">` : ""}
      <div class="rr-cur">${bad ? "⚠ " : "✓ "}${esc(l.cur.replace(/^#\s*/, "（読めません）"))}</div>
      ${l.alts.length ? `<div class="rr-alts">${l.alts.map((a, k) => `<button type="button" class="tok${a.text === l.cur ? " on" : ""}" data-alt="${k}">${esc(a.label)}</button>`).join("")}
        <button type="button" class="tok" data-alt="del">この行は不要</button></div>` : ""}
    </div>`;
  }).join("");
}
function chooseAlt(i, k) {
  const l = S.readLines[i];
  const next = k === "del" ? "# " + l.cur.replace(/^#\s*/, "") : l.alts[+k].text;
  const ta = $("#karteText");
  const lines = ta.value.split("\n");
  const at = lines.findIndex(x => x.trim() === l.cur.trim());
  if (at >= 0) lines[at] = next; else lines.push(next);
  ta.value = lines.join("\n");
  l.cur = next;
  renderReadRows();
  parseText(true);
}
function applyParsed(res) {
  const d = res.date || {};
  if (d.year && d.month && d.day) Object.assign(S.common, { year: d.year, month: d.month, day: d.day });
  S.bags = res.bags.map(b => {
    const dec = Store.decideSize(b);
    return Object.assign(b, { size: dec.size, sizeReason: dec.reason });
  });
  $("#chkVerified").checked = false;
  S.pdfs = []; $("#pdfResult").innerHTML = "";
  renderAll();
}
function insertToken(token, newLine) {
  const ta = $("#karteText");
  const v = ta.value;
  let pos = ta.dataset.caret != null ? +ta.dataset.caret : v.length;
  if (pos > v.length) pos = v.length;
  let ins;
  if (newLine) {
    const end = v.indexOf("\n", pos);
    pos = end === -1 ? v.length : end;
    ins = ((v && !v.endsWith("\n")) || end !== -1 ? "\n" : "") + token;
  } else {
    const before = v.slice(0, pos);
    ins = (before && !/\s$/.test(before) ? " " : "") + token;
  }
  ta.value = v.slice(0, pos) + ins + v.slice(pos);
  ta.dataset.caret = pos + ins.length;
}
function renderHelpers() {
  const d = Store.data;
  $("#drugList").innerHTML = d.drugs.map(x => {
    const kind = `${x.type === "gaiyou" ? "外用" : "内服"}・${x.form}`;
    return `<option value="${esc(x.name)}">${esc(kind)}</option>` + (x.aliases || []).map(a => `<option value="${esc(a)}">${esc(x.name)}</option>`).join("");
  }).join("");
  document.querySelectorAll(".tokens[data-tokens]").forEach(el => {
    el.innerHTML = el.dataset.tokens.split(" ").map(t => `<button type="button" class="tok">${esc(t)}</button>`).join("");
  });
  $("#siteTokens").innerHTML = d.sites.map(s => `<button type="button" class="tok">${esc(s.label)}</button>`).join("");
  const presets = Store.presets(14);
  $("#presetBox").innerHTML = presets.map((p, i) =>
    `<button type="button" class="preset" data-p="${i}">${esc(p.title)}${p.n ? `<small>${p.n}回使用</small>` : ""}</button>`).join("");
  $("#presetBox").onclick = e => {
    const b = e.target.closest("[data-p]");
    if (b) { insertToken(presets[+b.dataset.p].text, true); toast("追加しました。数量や日数が違えば直してください。"); }
  };
}

// ---------------------------------------------------------------- ③ 薬袋の内容
function chipGroup(i, key, options, selected, multi, unsure) {
  return `<span class="chips ${unsure ? "unsure" : ""}">` + options.map(o => {
    const val = o === "なし" ? "" : o;
    const on = multi ? selected.includes(val) : selected === val;
    return `<label class="chip"><input type="${multi ? "checkbox" : "radio"}" name="${key}-${i}" data-key="${key}" value="${esc(val)}" ${on ? "checked" : ""}><span>${esc(o)}</span></label>`;
  }).join("") + "</span>";
}
function inp(b, key, cls, ph) {
  return `<input class="${cls || ""}${b.uncertain.includes(key) ? " unsure" : ""}" data-key="${key}" value="${esc(b[key])}" ${ph ? `placeholder="${esc(ph)}"` : ""} ${cls === "wide-in" ? "" : 'inputmode="text"'}>`;
}
function bagCard(b, i) {
  const title = b.type === "naifuku" ? "のみぐすり" : "外用薬";
  const seg = `<span class="seg">${["small", "A5"].map(s => `<button type="button" data-size="${s}" class="${b.size === s ? "on" : ""}">${s === "A5" ? "大きい袋" : "小さい袋"}</button>`).join("")}</span>`;
  let h = "";
  if (b.type === "naifuku") {
    h += `<div class="f">1日${inp(b, "times")}回 ${inp(b, "days")}日分</div>`;
    h += `<div class="f"><span class="lbl">1回に</span>錠剤${inp(b, "tablet")}錠 カプセル${inp(b, "capsule")}個 こな薬${inp(b, "powder")}包</div>`;
    h += `<div class="f"><span class="lbl">補足</span>${inp(b, "dose_note", "wide-in", "例: 3種類")}</div>`;
    h += `<div class="f"><span class="lbl">時点</span>${chipGroup(i, "timing", TIMINGS, b.timing, true, b.uncertain.includes("timing"))} ${inp(b, "interval")}時間毎</div>`;
    h += `<div class="f"><span class="lbl">食事</span>${chipGroup(i, "meal", [...MEALS, "なし"], b.meal, false, b.uncertain.includes("meal"))}</div>`;
    h += `<div class="f"><label class="chip"><input type="checkbox" data-key="tonpuku" ${b.tonpuku ? "checked" : ""}><span>とんぷく</span></label></div>`;
    if (b.tonpuku) h += `<div class="f"><span class="lbl"></span>1回${inp(b, "tonpuku_amount")}個(包) ${inp(b, "tonpuku_count")}回分 ${chipGroup(i, "tonpuku_when", TONPUKU_WHEN, b.tonpuku_when, true, b.uncertain.includes("tonpuku_when"))}</div>`;
  } else {
    h += `<div class="f">1日${inp(b, "times")}回 <span class="lbl" style="width:auto">部位</span>${inp(b, "site", "wide-in", "例: 顔保湿")}</div>`;
    h += `<div class="f"><span class="lbl">種類</span>${chipGroup(i, "kind", KINDS, b.kind, false, b.uncertain.includes("kind"))}</div>`;
    if (b.kind === "坐薬") h += `<div class="f"><span class="lbl"></span>発熱時に${inp(b, "zayaku_temp")}℃以上</div>`;
  }
  const info = [`<b>薬</b> ${esc((b.drugs || []).join("、") || "（未入力）")}`];
  if (b.comment) info.push(`<b>メモ</b> ${esc(b.comment)}`);
  if (b.uncertain.length) info.push(`<span style="color:#7a5b00">黄色の欄は自動で推測した項目です。カルテで確認してください。</span>`);
  return `<div class="bag ${b.type}" data-idx="${i}">
    <div class="bag-head"><span class="bag-title">袋${i + 1} ${title}</span>${seg}</div>
    <div class="size-reason">${b.sizeReason ? "サイズの理由: " + esc(b.sizeReason) : "サイズ: ルールに当てはまらないため小さい袋"}</div>
    ${h}
    <div class="bag-info">${info.join("<br>")}</div>
    <div class="bag-actions">
      ${b.unknown_drug ? `<button type="button" class="btn tiny" data-act="master">「${esc(b.unknown_drug)}」をマスタに追加</button>` : ""}
      <button type="button" class="btn tiny" data-act="dup">複製</button>
      <button type="button" class="btn tiny danger" data-act="del">削除</button>
    </div>
  </div>`;
}
function renderBags() {
  $("#cName").value = S.common.name; $("#cYear").value = S.common.year; $("#cMonth").value = S.common.month; $("#cDay").value = S.common.day;
  $("#bagList").innerHTML = S.bags.length ? S.bags.map(bagCard).join("") : `<p class="note">まだありません。①で撮影するか、②に入力して「薬袋の文字を作る」を押してください。</p>`;
}
function onBagInput(e) {
  const t = e.target, key = t.dataset.key, card = t.closest(".bag");
  if (!key || !card) return;
  const b = S.bags[+card.dataset.idx];
  let rerender = false;
  if (t.type === "checkbox" && (key === "timing" || key === "tonpuku_when")) {
    const set = new Set(b[key]); t.checked ? set.add(t.value) : set.delete(t.value);
    b[key] = (key === "timing" ? TIMINGS : TONPUKU_WHEN).filter(x => set.has(x));
  } else if (key === "tonpuku") { b.tonpuku = t.checked; rerender = true; }
  else if (t.type === "radio") { b[key] = t.value; rerender = key === "kind"; }
  else b[key] = toHalf(t.value);
  if (b.uncertain.includes(key)) {
    b.uncertain = b.uncertain.filter(k => k !== key);
    t.classList.remove("unsure");
    const g = t.closest(".chips"); if (g) g.classList.remove("unsure");
  }
  if (rerender) renderBags();
  schedulePreview();
}
function onBagClick(e) {
  const card = e.target.closest(".bag");
  if (!card) return;
  const i = +card.dataset.idx, b = S.bags[i];
  const sizeBtn = e.target.closest("[data-size]");
  if (sizeBtn) {
    const size = sizeBtn.dataset.size;
    if (b.size === size) return;
    b.size = size; b.sizeReason = "手で変更";
    renderAll();
    offerSizeRule(b, size);
    return;
  }
  const act = e.target.dataset.act;
  if (act === "del" && confirm(`袋${i + 1}を削除しますか？`)) { S.bags.splice(i, 1); renderAll(); }
  if (act === "dup") { S.bags.splice(i + 1, 0, JSON.parse(JSON.stringify(b))); renderAll(); }
  if (act === "master") openMenu("drug", { name: b.unknown_drug, type: b.type });
}
// 手でサイズを変えたら「次回から覚えますか？」と聞いてルールにする
function offerSizeRule(b, size) {
  const names = (b.drug_names || []).filter(n => n && n !== "（薬品名不明）");
  if (!names.length) return;
  const big = size === "A5" ? "大きい袋" : "小さい袋";
  const opts = [];
  if (b.type === "gaiyou" && b.qty && b.unit) {
    opts.push({ label: `${names[0]}が${b.qty}${b.unit}以上なら${big}`, act: () => addRule({ kind: "qty_at_least", words: [names[0]], n: +b.qty, unit: b.unit, size }) });
  }
  opts.push({ label: `${names.join("・")}${names.length > 1 ? "のセット" : ""}なら${big}`,
    act: () => addRule({ kind: names.length > 1 ? "all_of" : "any_of", words: names, size }) });
  opts.push({ label: "今回だけ", act: () => {} });
  toast(`次回から覚えますか？`, opts);
}
function addRule(r) {
  r.id = "r" + Date.now();
  Store.data.rules.unshift(r);
  Store.save();
  toast("袋のサイズのルールに追加しました（メニューで確認・削除できます）");
}

// ---------------------------------------------------------------- ④ プレビューと印刷
let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 80); }
function renderPreview() {
  const L = Store.layout();
  const common = commonForPrint();
  const boxW = Math.min(170, Math.max(120, ($("#previewList").clientWidth - 20) / 2));
  const maxW = Math.max(...Object.values(L.sizes).map(s => s.width_mm));
  const scale = boxW / (maxW * PX_PER_MM);
  $("#previewList").innerHTML = S.bags.map((b, i) => {
    const sz = L.sizes[b.size];
    return `<div class="pv"><div class="pv-cap">袋${i + 1}（${b.size === "A5" ? "大" : "小"}）</div>
      <div class="pv-frame" style="width:${(sz.width_mm * PX_PER_MM * scale).toFixed(1)}px;height:${(sz.height_mm * PX_PER_MM * scale).toFixed(1)}px">
      <div class="pv-inner" style="transform:scale(${scale.toFixed(4)})">${YakutaiRender.renderPage(b, common, L, { art: true, noOffset: true })}</div></div></div>`;
  }).join("");
  updatePdfButton();
}
function renderAll() { renderBags(); renderPreview(); }
function updatePdfButton() { $("#btnPdf").disabled = !(S.bags.length && $("#chkVerified").checked); }

function problems() {
  const p = [];
  S.bags.forEach((b, i) => {
    const n = `袋${i + 1}`;
    if (b.uncertain.length) p.push(`${n}: 黄色の項目が未確認`);
    if (b.type === "naifuku") {
      if (!b.tonpuku && (!b.times || !b.days)) p.push(`${n}: 回数か日数が空欄`);
      if (!b.tablet && !b.capsule && !b.powder && !b.tonpuku) p.push(`${n}: 1回量が空欄`);
    } else if (!b.kind || !b.times) p.push(`${n}: 種類か回数が空欄`);
  });
  if (!S.common.year || !S.common.month || !S.common.day) p.push("交付日が空欄");
  return p;
}
function paperOpt() {
  const st = Store.data.settings;
  if (!PAPERS[st.paper]) return {};
  const [w, h] = PAPERS[st.paper];
  return { paper: { w, h, ox: +st.paperOffsetX || 0, oy: +st.paperOffsetY || 0 } };
}
async function makePdfs() {
  const p = problems();
  if (p.length && !confirm("確認してください:\n・" + p.join("\n・") + "\n\nこのまま作りますか？")) return;
  busy(true, "PDFを作っています…");
  try {
    const L = Store.layout(), common = commonForPrint(), stamp = new Date();
    const ymd = `${stamp.getMonth() + 1}${String(stamp.getDate()).padStart(2, "0")}_${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}`;
    S.pdfs = [];
    for (const size of ["small", "A5"]) {
      const group = S.bags.filter(b => b.size === size);
      if (!group.length) continue;
      const bytes = await BagPDF.build(group, common, L, paperOpt());
      const label = size === "A5" ? "大きい袋" : "小さい袋";
      S.pdfs.push({ label, count: group.length, file: new File([bytes], `薬袋_${label}_${ymd}.pdf`, { type: "application/pdf" }) });
    }
    Store.learnFrom(S.bags, S.ocrInitial, $("#karteText").value);
    S.ocrInitial = [];
    renderHelpers();
    renderPdfResult();
  } catch (e) {
    $("#pdfResult").innerHTML = `<div class="res err">PDFを作れませんでした: ${esc(e.message)}</div>`;
  } finally { busy(false); }
}
function renderPdfResult() {
  $("#pdfResult").innerHTML = S.pdfs.map((p, i) => `<div class="res"><b>${esc(p.label)}</b>（${p.count}枚）をセットして印刷してください
    <div class="row2"><button class="btn primary" data-share="${i}">印刷・共有</button><button class="btn" data-open="${i}">開く／保存</button></div></div>`).join("") +
    `<p class="note">「印刷・共有」でプリンター（またはプリンターのアプリ）を選びます。用紙サイズは袋に合わせ、倍率は「100%（実際のサイズ）」にしてください。</p>`;
}
async function sharePdf(i) {
  const f = S.pdfs[i].file;
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: f.name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  openPdf(i);
}
function openPdf(i) {
  const f = S.pdfs[i].file, url = URL.createObjectURL(f);
  const a = document.createElement("a");
  a.href = url; a.download = f.name; a.target = "_blank"; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function clearAll() {
  if (!confirm("次の患者に進みます。入力内容と写真を消しますか？")) return;
  S.bags = []; S.photo = null; S.ocrInitial = ""; S.pdfs = []; S.readLines = []; S.rect = null;
  renderReadRows();
  S.common = Object.assign({ name: "" }, today());
  $("#karteText").value = ""; $("#photoBox").hidden = true; $("#ocrStatus").hidden = true;
  $("#chkVerified").checked = false; $("#pdfResult").innerHTML = "";
  $("#camInput").value = ""; $("#fileInput").value = "";
  renderAll();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- メニュー
let editingDrug = -1;
function openMenu(section, prefill) {
  renderMenu();
  $("#dlgMenu").showModal();
  if (section === "drug") {
    const det = $("#drugForm").closest("details"); det.open = true;
    editingDrug = -1; fillDrugForm(prefill || {});
    setTimeout(() => $("#drugForm").scrollIntoView({ block: "center" }), 50);
  }
}
function renderMenu() {
  const d = Store.data;
  $("#ruleList").innerHTML = d.rules.map((r, i) => `<li>${esc(r.memo ? r.memo + "：" : "")}${esc(Store.ruleText(r))}
    <button class="btn tiny" data-rup="${i}" ${i === 0 ? "disabled" : ""}>上へ</button><button class="btn tiny danger" data-rdel="${i}">削除</button></li>`).join("");
  renderDrugTable();
  $("#siteEdit").value = d.sites.map(s => [s.label, ...(s.aliases || [])].join(" ")).join("\n");
  const st = d.settings;
  $("#sPaper").value = st.paper; $("#sPaperX").value = st.paperOffsetX; $("#sPaperY").value = st.paperOffsetY;
  $("#szSW").value = d.sizes.small.width_mm; $("#szSH").value = d.sizes.small.height_mm;
  $("#szLW").value = d.sizes.A5.width_mm; $("#szLH").value = d.sizes.A5.height_mm;
  $("#calibBox").innerHTML = ["naifuku", "gaiyou"].flatMap(t => ["small", "A5"].map(s => {
    const c = d.calibration[t][s];
    return `<div class="form-box" data-t="${t}" data-s="${s}"><b>${t === "naifuku" ? "のみぐすり" : "外用薬"}・${s === "A5" ? "大きい袋" : "小さい袋"}</b>
      <div class="row2"><label>X <input type="number" step="0.5" data-c="dx" value="${c.dx}"></label><label>Y <input type="number" step="0.5" data-c="dy" value="${c.dy}"></label></div>
      <div class="row2"><button class="btn tiny" data-test="0">テスト印刷（実物用）</button><button class="btn tiny" data-test="1">図柄つき（普通紙用）</button></div></div>`;
  })).join("");
  $("#sGaiyouTimes").value = st.gaiyouDefaultTimes; $("#sYear").value = st.yearFormat;
  const L = d.learn;
  $("#learnInfo").textContent = `これまでに ${L.count || 0} 回分を学習（よく使う処方 ${Object.keys(L.presets).length} 件、読み違いの訂正 ${Object.keys(L.ocrFix).length} 件、袋サイズのルール ${d.rules.length} 件）`;
  $("#versionInfo").innerHTML = `バージョン ${APP_VERSION}<br>文字認識: PaddleOCR（PP-OCRv5・PP-OCRv4 日本語、Apache-2.0）、NDLOCR-Lite（国立国会図書館、CC BY 4.0）`;
}
function renderDrugTable() {
  const q = KarteParser.fuzzkey($("#drugFilter").value || "");
  $("#drugTable").innerHTML = Store.data.drugs.map((x, i) => [x, i])
    .filter(([x]) => !q || KarteParser.fuzzkey([x.name, ...(x.aliases || [])].join(" ")).includes(q))
    .map(([x, i]) => `<div class="drug-row"><div>${esc(x.name)}<small>${x.type === "gaiyou" ? "外用" : "内服"}・${esc(x.form)}${x.type === "gaiyou" ? `・1日${esc(x.times || Store.data.settings.gaiyouDefaultTimes)}回` : ""}　${esc((x.aliases || []).join(" "))}</small></div>
      <div><button class="btn tiny" data-dedit="${i}">編集</button> <button class="btn tiny danger" data-ddel="${i}">削除</button></div></div>`).join("");
}
function fillDrugForm(x) {
  $("#drugFormTitle").textContent = editingDrug >= 0 ? "薬を編集" : "薬を追加";
  $("#dName").value = x.name || ""; $("#dType").value = x.type || "naifuku";
  fillFormSelect(); $("#dForm").value = x.form || $("#dForm").options[0].value;
  $("#dTimes").value = x.times || ""; $("#dNote").value = x.note || ""; $("#dAliases").value = (x.aliases || []).join(" ");
}
function fillFormSelect() {
  const opts = $("#dType").value === "gaiyou" ? KINDS : NAIFUKU_FORMS;
  $("#dForm").innerHTML = opts.map(o => `<option>${o}</option>`).join("");
}
function bindMenu() {
  $("#btnMenu").onclick = () => openMenu();
  $("#btnMenuClose").onclick = () => $("#dlgMenu").close();
  $("#ruleList").onclick = e => {
    const d = Store.data;
    const del = e.target.dataset.rdel, up = e.target.dataset.rup;
    if (del != null && confirm("このルールを削除しますか？")) { d.rules.splice(+del, 1); Store.save(); renderMenu(); }
    if (up != null && +up > 0) { const r = d.rules.splice(+up, 1)[0]; d.rules.splice(+up - 1, 0, r); Store.save(); renderMenu(); }
  };
  $("#btnAddRule").onclick = () => {
    const kind = $("#rKind").value;
    const words = $("#rWords").value.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
    const n = +$("#rN").value;
    if ((kind === "any_of" || kind === "all_of") && !words.length) return alert("薬の名前を入れてください");
    if (!["any_of", "all_of"].includes(kind) && !(n > 0)) return alert("数を入れてください");
    const r = { id: "r" + Date.now(), kind, words, n, unit: $("#rUnit").value, size: $("#rSize").value, memo: $("#rMemo").value.trim() };
    if (kind === "containers_at_least" && +$("#rNo").value > 0) r.minNo = +$("#rNo").value;
    Store.data.rules.unshift(r); Store.save();
    ["#rWords", "#rN", "#rMemo", "#rNo"].forEach(s => { $(s).value = ""; });
    renderMenu(); reapplySizes();
  };
  $("#drugFilter").oninput = renderDrugTable;
  $("#dType").onchange = fillFormSelect;
  $("#drugTable").onclick = e => {
    const ed = e.target.dataset.dedit, dl = e.target.dataset.ddel;
    if (ed != null) { editingDrug = +ed; fillDrugForm(Store.data.drugs[+ed]); $("#drugForm").scrollIntoView({ block: "center" }); }
    if (dl != null && confirm(`「${Store.data.drugs[+dl].name}」をマスタから削除しますか？`)) { Store.data.drugs.splice(+dl, 1); Store.save(); renderMenu(); renderHelpers(); }
  };
  $("#btnCancelDrug").onclick = () => { editingDrug = -1; fillDrugForm({}); };
  $("#btnSaveDrug").onclick = () => {
    const x = { name: $("#dName").value.trim(), type: $("#dType").value, form: $("#dForm").value, times: toHalf($("#dTimes").value),
      note: $("#dNote").value.trim(), aliases: $("#dAliases").value.split(/\s+/).filter(Boolean) };
    if (!x.name) return alert("薬品名を入れてください");
    if (editingDrug >= 0) Store.data.drugs[editingDrug] = x; else Store.data.drugs.push(x);
    Store.save(); editingDrug = -1; fillDrugForm({}); renderMenu(); renderHelpers();
    toast("薬品マスタを保存しました。「薬袋の文字を作る」を押し直すと反映されます。");
  };
  $("#btnSaveSites").onclick = () => {
    Store.data.sites = $("#siteEdit").value.split("\n").map(l => l.trim().split(/\s+/)).filter(p => p[0]).map(p => ({ label: p[0], aliases: p.slice(1) }));
    Store.save(); renderHelpers(); toast("部位の一覧を保存しました");
  };
  $("#btnSavePrint").onclick = () => { savePrintSettings(); toast("印刷の設定を保存しました"); };
  $("#calibBox").onclick = async e => {
    const b = e.target.closest("[data-test]");
    if (!b) return;
    savePrintSettings();
    const box = b.closest("[data-t]");
    await testPrint(box.dataset.t, box.dataset.s, b.dataset.test === "1");
  };
  $("#btnExport").onclick = () => {
    const f = new File([Store.exportJSON()], `薬袋プリント_バックアップ_${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [f] })) navigator.share({ files: [f] }).catch(() => {});
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); }
  };
  $("#importInput").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { Store.importJSON(await f.text()); renderMenu(); renderHelpers(); reapplySizes(); toast("バックアップから戻しました"); }
    catch (err) { alert("戻せませんでした: " + err.message); }
    e.target.value = "";
  };
  $("#btnResetLearn").onclick = () => { if (confirm("学習した内容（よく使う処方・訂正・用法）を消しますか？（ルールとマスタは残ります）")) { Store.reset("learn"); renderMenu(); renderHelpers(); } };
  $("#btnSaveOther").onclick = () => {
    Store.data.settings.gaiyouDefaultTimes = toHalf($("#sGaiyouTimes").value) || "2";
    Store.data.settings.yearFormat = $("#sYear").value;
    Store.save(); renderPreview(); toast("保存しました");
  };
}
function savePrintSettings() {
  const d = Store.data, st = d.settings;
  st.paper = $("#sPaper").value; st.paperOffsetX = +$("#sPaperX").value || 0; st.paperOffsetY = +$("#sPaperY").value || 0;
  d.sizes.small.width_mm = +$("#szSW").value || d.sizes.small.width_mm; d.sizes.small.height_mm = +$("#szSH").value || d.sizes.small.height_mm;
  d.sizes.A5.width_mm = +$("#szLW").value || d.sizes.A5.width_mm; d.sizes.A5.height_mm = +$("#szLH").value || d.sizes.A5.height_mm;
  document.querySelectorAll("#calibBox [data-t]").forEach(box => {
    d.calibration[box.dataset.t][box.dataset.s] = { dx: +box.querySelector('[data-c="dx"]').value || 0, dy: +box.querySelector('[data-c="dy"]').value || 0 };
  });
  Store.save();
  $("#yt-css").textContent = YakutaiRender.pageCss(Store.layout());
  renderPreview();
}
const TEST_BAGS = {
  naifuku: { type: "naifuku", times: "3", days: "14", powder: "1", capsule: "1", tablet: "各1", dose_note: "2種類",
    timing: ["朝", "昼", "夕", "ねる前"], interval: "6", meal: "食後", tonpuku: true, tonpuku_amount: "1", tonpuku_count: "5", tonpuku_when: ["痛い時", "かゆい時"] },
  gaiyou: { type: "gaiyou", times: "2", site: "足のつめ", kind: "ぬり薬" },
};
async function testPrint(type, size, art) {
  busy(true, "テスト用PDFを作っています…");
  try {
    const t = today();
    const bag = Object.assign({ uncertain: [] }, TEST_BAGS[type], { size });
    const bytes = await BagPDF.build([bag], { name: "テスト 太郎", year_text: "令和" + t.year, month: t.month, day: t.day }, Store.layout(), Object.assign(paperOpt(), { art }));
    S.pdfs = [{ label: "テスト", count: 1, file: new File([bytes], `テスト_${type}_${size}${art ? "_図柄つき" : ""}.pdf`, { type: "application/pdf" }) }];
    $("#dlgMenu").close();
    renderPdfResult();
    $("#pdfResult").scrollIntoView({ block: "center" });
  } catch (e) { alert("作れませんでした: " + e.message); }
  finally { busy(false); }
}
function reapplySizes() {
  S.bags.forEach(b => { if (b.sizeReason !== "手で変更") { const d = Store.decideSize(b); b.size = d.size; b.sizeReason = d.reason; } });
  renderAll();
}

// ---------------------------------------------------------------- 起動
function init() {
  $("#yt-css").textContent = YakutaiRender.pageCss(Store.layout());
  S.common = Object.assign({ name: "" }, today());
  renderHelpers();
  renderAll();

  $("#camInput").onchange = e => setPhoto(e.target.files[0]);
  $("#fileInput").onchange = e => setPhoto(e.target.files[0]);
  $("#btnZoom").onclick = () => $("#dlgPhoto").showModal();
  $("#btnReread").onclick = readPhoto;
  $("#btnSelect").onclick = startSelect;
  bindSelect();

  const ta = $("#karteText");
  ["keyup", "click", "input", "blur"].forEach(ev => ta.addEventListener(ev, () => { ta.dataset.caret = ta.selectionStart; }));
  document.querySelector("#tokenBox").addEventListener("click", e => { const b = e.target.closest(".tok"); if (b) insertToken(b.textContent, false); });
  const addDrug = () => { const v = $("#drugSearch").value.trim(); if (v) { insertToken(v + " ", true); $("#drugSearch").value = ""; } };
  $("#btnAddDrug").onclick = addDrug;
  $("#drugSearch").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addDrug(); } });
  $("#btnParse").onclick = parseText;
  $("#readRows").addEventListener("click", e => {
    const b = e.target.closest("[data-alt]");
    if (b) chooseAlt(+b.closest("[data-r]").dataset.r, b.dataset.alt);
  });

  const bindC = (sel, key) => $(sel).addEventListener("input", e => { S.common[key] = e.target.value; schedulePreview(); });
  bindC("#cName", "name"); bindC("#cYear", "year"); bindC("#cMonth", "month"); bindC("#cDay", "day");
  $("#bagList").addEventListener("input", onBagInput);
  $("#bagList").addEventListener("click", onBagClick);
  $("#addNaifuku").onclick = () => { S.bags.push(Object.assign(emptyBag("naifuku"), { size: "small" })); renderAll(); };
  $("#addGaiyou").onclick = () => { S.bags.push(Object.assign(emptyBag("gaiyou"), { size: "small", kind: "ぬり薬", times: Store.data.settings.gaiyouDefaultTimes })); renderAll(); };

  $("#chkVerified").onchange = updatePdfButton;
  $("#btnPdf").onclick = makePdfs;
  $("#pdfResult").onclick = e => {
    const s = e.target.closest("[data-share]"), o = e.target.closest("[data-open]");
    if (s) sharePdf(+s.dataset.share);
    if (o) openPdf(+o.dataset.open);
  };
  $("#btnNext").onclick = clearAll;
  bindMenu();
  window.addEventListener("resize", schedulePreview);

  // 使う前に文字認識を裏で準備しておく
  setTimeout(() => LocalOCR.init().catch(() => {}), 1500);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}
function emptyBag(type) {
  return { type, drugs: [], drug_names: [], source: "", times: "", days: "", powder: "", capsule: "", tablet: "", dose_note: "",
    timing: [], interval: "", meal: "", tonpuku: false, tonpuku_amount: "", tonpuku_count: "", tonpuku_when: [], kind: "", site: "",
    zayaku_temp: "", qty: null, unit: "", containers: 0, uncertain: [], comment: "", unknown_drug: "", sizeReason: "" };
}
init();
