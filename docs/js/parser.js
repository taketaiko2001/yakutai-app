// カルテの書き方（OCR結果または手入力）を、薬袋に書く内容へ変換する。
// 1行に1項目。「#」で始まる行は無視する。例:
//   8.9.25 / シナール配合錠 3T / トラネキサム酸錠 3T / 3×N 60TD / ヘパlo 3本 顔保湿 / パンデルlo 2本 (足のつめ)
(function (global) {
  "use strict";

  const GAIYOU_KINDS = ["ぬり薬", "点眼薬", "点鼻薬", "点耳薬", "貼り薬", "うがい薬", "トローチ", "消毒用の薬", "坐薬"];
  const FORM_ROW = { "錠剤": "tablet", "カプセル": "capsule", "こな薬": "powder" };
  const UNIT_ROW = { t: "tablet", "錠": "tablet", c: "capsule", cap: "capsule", "カプセル": "capsule", p: "powder", "包": "powder" };
  const UNIT_LABEL = { t: "T", "錠": "錠", c: "C", cap: "C", "カプセル": "C", p: "包", "包": "包", g: "g", "本": "本", "枚": "枚", "個": "個", ml: "mL" };

  // ---------------------------------------------------------------- 文字の正規化
  function hiraToKata(s) {
    return s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  function norm(s) {
    s = String(s || "").normalize("NFKC").toLowerCase();
    return hiraToKata(s).replace(/[✕✖*]/g, "×");
  }
  // OCRが取り違えやすい、形の似た漢字・記号 → カタカナ
  const LOOKALIKE = { "十": "ナ", "口": "ロ", "工": "エ", "力": "カ", "夕": "タ", "卜": "ト", "八": "ハ", "一": "ー",
    "二": "ニ", "三": "ミ", "千": "チ", "才": "オ", "木": "ホ", "△": "ム" };
  function fuzzkey(s) {
    s = norm(s).replace(/./g, c => LOOKALIKE[c] || c);
    s = s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
    return s.replace(/[\s・･.,、。()（）[\]「」'"`~\-_/]/g, "");
  }
  function lcs(a, b) {
    const n = a.length, m = b.length;
    let prev = new Array(m + 1).fill(0), cur = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      [prev, cur] = [cur, prev];
    }
    return prev[m];
  }
  function similarity(q, a) {
    if (!q || !a) return 0;
    if (q === a) return 1;
    const m = lcs(q, a);
    return 0.5 * m / a.length + 0.5 * m / q.length;
  }

  // ---------------------------------------------------------------- マスタ照合
  function prepareDrugs(drugs) {
    return drugs.map(d => Object.assign({}, d, {
      keys: [...new Set([d.name, ...(d.aliases || [])].map(fuzzkey).filter(Boolean))],
    }));
  }
  function prepareSites(sites) {
    return sites.map(s => Object.assign({}, s, {
      keys: [...new Set([s.label, ...(s.aliases || [])].map(fuzzkey).filter(Boolean))],
    }));
  }
  function matchDrug(text, drugs) {
    const q = fuzzkey(text);
    if (q.length < 2) return [null, 0];
    const scored = drugs.map(d => [Math.max(...d.keys.map(k => similarity(q, k))), d]).sort((a, b) => b[0] - a[0]);
    if (!scored.length || scored[0][0] < 0.62) return [null, scored.length ? scored[0][0] : 0];
    let conf = scored[0][0];
    const second = scored[1];
    if (second && scored[0][0] - second[0] < 0.05 && second[1].name !== scored[0][1].name) conf = Math.min(conf, 0.7);
    return [scored[0][1], conf];
  }
  function matchSite(text, sites) {
    const q = fuzzkey(text);
    if (!q) return ["", 0];
    let best = null, score = 0;
    for (const s of sites) {
      const v = Math.max(...s.keys.map(k => similarity(q, k)));
      if (v > score) { best = s; score = v; }
    }
    return best && score >= 0.75 ? [best.label, score] : [text.trim(), 0];
  }

  // ---------------------------------------------------------------- 1行の解析
  const RE_DATE = /(?<!\d)(\d{1,2})\s*[.,/。、]\s*(\d{1,2})\s*[.,/。、]\s*(\d{1,2})/;
  const RE_QTY_G = /(\d+(?:\.\d+)?)\s*(カプセル|cap|ml|t|錠|c|p|包|g|本|枚|個)(?![a-z])/g;
  const RE_USAGE = /(\d)\s*[×x+]\s*(朝昼夕|朝夕|n|朝|昼|夕|タ|9|ネル前|ネ|寝|眠|就寝|vde|v\.d\.e|zde|z\.d\.e|vds|hs|h\.s)/;
  const RE_DAYS = /(\d{1,3})\s*(?:td|t\.d|日分)/;
  const RE_DAYS_OCR = /(?<!\d)(\d{1,3})(?:70|20|7d|2d|t0|to|id|1d)(?![\da-z])/;
  const RE_TONPUKU = /頓|トンプク|prn|屯/;
  const RE_COUNT = /(\d+)\s*回分|[×x]\s*(\d+)\s*回(?!\/)/;
  const RE_TIMES_1DAY = /1日\s*(\d)\s*回/;
  const RE_CONTAINERS = /(\d+(?:\.\d+)?)\s*(?:g|本)?\s*[×x]\s*(\d+)(?!\s*(?:回|日|td))/;  // 混合容器「3×2」= 2個
  const RE_PAREN = /[(（]\s*([^)）]*)[)）]?/;
  const RE_RP = /^\s*[^\s(（]{1,3}\)\s*/;   // 「Rp)」とそのOCR読み違い
  const RE_BULLET = /^[\s・･.\-‐ー—*]+/;
  const RE_JP2 = /[぀-ヿ一-鿿]{2,}/;

  function qtyMatches(t) { return [...t.matchAll(RE_QTY_G)]; }

  function parseUsage(t) {
    const u = {};
    t = t.replace(/(\d)o(?=\d|\s*td)/g, "$10");   // 「6OTD」→「60TD」（数字のゼロを英字のOと読み違えたもの）
    let m = t.match(RE_USAGE);
    if (m) {
      const times = +m[1], code = m[2];
      u.times = String(times);
      if (code === "n") {
        u.meal = "食後";
        u.timing = { 3: ["朝", "昼", "夕"], 2: ["朝", "夕"] }[times] || [];
        if (times === 1) u.unsure = ["timing"];
      } else if (["朝昼夕", "朝夕", "朝", "昼", "夕", "タ", "9"].includes(code)) {
        u.meal = "食後";
        u.timing = { "朝昼夕": ["朝", "昼", "夕"], "朝夕": ["朝", "夕"], "朝": ["朝"], "昼": ["昼"] }[code] || ["夕"];
        if (code === "9") u.unsure = ["timing"];
      } else if (["ネル前", "ネ", "寝", "眠", "就寝", "vds", "hs", "h.s"].includes(code)) {
        u.timing = ["ねる前"]; u.meal = "";
      } else if (code === "vde" || code === "v.d.e") {
        u.meal = "食前"; u.timing = { 3: ["朝", "昼", "夕"], 2: ["朝", "夕"] }[times] || [];
      } else {
        u.meal = "食間"; u.timing = [];
      }
    }
    for (const w of ["食後", "食前", "食間"]) if (t.includes(w)) u.meal = w;
    m = t.match(RE_DAYS);
    if (m) u.days = m[1];
    else if (u.times || !qtyMatches(t).length) {
      m = t.match(RE_DAYS_OCR);
      if (m) { u.days = m[1]; (u.unsure = u.unsure || []).push("days"); }
    }
    if (RE_TONPUKU.test(t)) u.tonpuku = true;
    m = t.match(RE_COUNT);
    if (m) u.count = m[1] || m[2];
    const when = [];
    if (t.includes("痛") || t.includes("イタイ")) when.push("痛い時");
    if (t.includes("熱")) when.push("発熱時");
    if (t.includes("痒") || t.includes("カユ")) when.push("かゆい時");
    if (when.length) u.when = when;
    return u;
  }

  function fmtNum(x) { return Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : String(+x.toFixed(3)); }
  function qtyText(q, unit) { return q == null ? "" : fmtNum(q) + (UNIT_LABEL[unit] || unit); }

  function usageText(u) {
    const parts = [];
    if (u.times) {
      const n = u.times, tm = u.timing || [], meal = u.meal || "";
      const def = { 3: ["朝", "昼", "夕"], 2: ["朝", "夕"] }[n];
      let code;
      if (meal === "食前") code = "vdE";
      else if (meal === "食間") code = "zdE";
      else if (tm.length === 1 && tm[0] === "ねる前") code = "ねる前";
      else if (tm.length && (!def || tm.join() !== def.join())) code = tm.join("");
      else code = "N";
      parts.push(`${n}×${code}`);
    }
    if (u.days) parts.push(`${u.days}TD`);
    if (u.tonpuku) { parts.push("頓用"); if (u.count) parts.push(`${u.count}回分`); parts.push(...(u.when || [])); }
    return parts.join(" ") || "（用法）";
  }

  function emptyBag(type) {
    return { type, drugs: [], drug_names: [], source: "", times: "", days: "", powder: "", capsule: "", tablet: "",
      dose_note: "", timing: [], interval: "", meal: "", tonpuku: false, tonpuku_amount: "", tonpuku_count: "",
      tonpuku_when: [], kind: "", site: "", zayaku_temp: "", qty: null, unit: "", containers: 0,
      uncertain: [], comment: "", unknown_drug: "" };
  }

  // ---------------------------------------------------------------- 全体
  // ctx: { drugs, sites, learn, gaiyouDefaultTimes }
  function parse(text, ctx) {
    const drugs = ctx.preparedDrugs || prepareDrugs(ctx.drugs);
    const sites = ctx.preparedSites || prepareSites(ctx.sites);
    const learn = ctx.learn || {};
    const res = { date: { year: "", month: "", day: "" }, bags: [], ignored: [], text: "" };
    const out = [];
    const pending = [];
    let lastGaiyou = null;

    const flush = (usage, lineUnsure) => {
      if (!pending.length) return;
      res.bags.push(naifukuBag(pending.splice(0), usage, lineUnsure || [], learn));
    };

    const lines = String(text || "").split(/\r?\n/);
    for (let raw of lines) {
      let line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      // 過去の訂正で覚えた読み違い → 訂正後の行に置き換える
      let fromLearn = false;
      const learned = lookupOcrFix(line, learn, drugs);
      if (learned) { line = learned; fromLearn = true; }

      let t = norm(line);
      if (!res.date.year) {
        const m = t.match(RE_DATE);
        if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
          res.date = { year: String(+m[1]), month: String(+m[2]), day: String(+m[3]) };
          out.push(`${res.date.year}.${res.date.month}.${res.date.day}`);
          const rest = t.replace(RE_DATE, "").trim();
          if (fuzzkey(rest).length < 3) continue;
          t = rest;
        }
      }

      const body = t.replace(RE_RP, "").replace(RE_BULLET, "");
      const qms = qtyMatches(body);
      const usage = parseUsage(body);
      let namePart = qms.length ? body.slice(0, qms[0].index) : body;
      const um = namePart.match(RE_USAGE);
      if (um) namePart = namePart.slice(0, um.index);
      namePart = namePart.replace(RE_PAREN, "").replace(RE_CONTAINERS, "");
      let [drug, conf] = matchDrug(namePart, drugs);

      // マスタにない薬でも、人が入力した行なら数量の単位から内服・外用を推定して袋にする
      // （OCRの読み取り直後は、読み違いのゴミ行を薬と誤認しないよう行わない）
      if (!drug && ctx.allowUnknown && qms.length && /[a-zァ-ヿ一-鿿]{2,}/.test(fuzzkey(namePart))) {
        const unit = qms[qms.length - 1][2];
        const isGaiyou = ["本", "枚", "ml", "g"].includes(unit);
        drug = { name: namePart.trim(), type: isGaiyou ? "gaiyou" : "naifuku", form: isGaiyou ? "ぬり薬" : (UNIT_ROW[unit] === "capsule" ? "カプセル" : UNIT_ROW[unit] === "powder" ? "こな薬" : "錠剤"),
          times: "", note: "", unknown: true };
        conf = 0;
      }

      if (!drug) {
        if (usage.times || usage.days || usage.tonpuku) {
          if (!pending.length) {
            pending.push({ drug: { name: "（薬品名不明）", form: "錠剤", unknown: true }, qty: null, unit: "", unsure: true, line });
            out.push("# ↓この用法の薬品名と数量（例: レボセチリジン 1T）を、この行の代わりに入力");
          }
          flush(usage, usage.unsure);
          out.push(usageText(usage));
          continue;
        }
        const pm = line.match(RE_PAREN);
        if (pm && lastGaiyou && !lastGaiyou.site && RE_JP2.test(pm[1])) {
          const [site, sconf] = matchSite(pm[1], sites);
          lastGaiyou.site = site;
          if (!sconf) lastGaiyou.uncertain.push("site");
          out[out.length - 1] += ` (${site})`;
          continue;
        }
        res.ignored.push(line);
        out.push("# " + raw.trim());
        continue;
      }

      // 数量（最後に出てくるもの。錠剤の「50mg」などを数量と誤認しないよう単位で絞る）
      let qty = null, unit = "";
      for (let i = qms.length - 1; i >= 0; i--) {
        const u = qms[i][2];
        if (drug.type === "naifuku" && ["本", "枚", "ml"].includes(u)) continue;
        if (drug.type === "naifuku" && u === "g" && drug.form !== "こな薬") continue;
        qty = +qms[i][1]; unit = u; break;
      }
      const unsure = conf < 0.85 || fromLearn;

      if (drug.type === "naifuku") {
        pending.push({ drug, qty, unit, unsure, line: raw.trim() });
        out.push(`${drug.name} ${qty != null ? qtyText(qty, unit) : "?"}`);
        if (usage.times || usage.days || usage.tonpuku) {
          flush(usage, usage.unsure);
          out.push(usageText(usage));
        }
        lastGaiyou = null;
      } else {
        flush({}, ["times", "days"]);
        const bag = gaiyouBag(drug, qty, unit, body, raw.trim(), ctx.gaiyouDefaultTimes || "2", sites, unsure, learn);
        if (fromLearn) bag.comment = ["過去の訂正から推測", bag.comment].filter(Boolean).join("・");
        res.bags.push(bag);
        lastGaiyou = bag;
        const tail = bag._timesFromLine ? ` 1日${bag.times}回` : "";
        const cont = bag.containers >= 2 ? ` ${fmtNum(bag.qty || 0)}×${bag.containers}` : (qty != null ? ` ${qtyText(qty, unit)}` : "");
        out.push(`${drug.name}${cont}${tail}${bag.site ? " " + bag.site : ""}`);
      }
    }
    flush({}, ["times", "days"]);
    res.bags.forEach(b => delete b._timesFromLine);
    res.text = out.join("\n");
    return res;
  }

  function naifukuBag(items, usage, lineUnsure, learn) {
    const bag = emptyBag("naifuku");
    bag.drugs = items.map(it => `${it.drug.name} ${qtyText(it.qty, it.unit)}`.trim());
    bag.drug_names = items.map(it => it.drug.name);
    bag.source = items.map(it => it.line).join(" / ");
    const notes = [];
    const unsure = new Set(lineUnsure);
    if (items.some(it => it.unsure)) { unsure.add("drugs"); notes.push("薬品名の読み取りに自信がありません"); }
    const unknown = items.find(it => it.drug.unknown && it.drug.name !== "（薬品名不明）");
    if (unknown) { bag.unknown_drug = unknown.drug.name; notes.push("薬品マスタにない薬です"); }

    // 用法が書かれていなければ、この薬でよく使う用法（学習結果）を入れる
    if (!usage.times && !usage.tonpuku && items.length) {
      const learned = learnedUsage(items.map(it => it.drug.name), learn);
      if (learned) { usage = Object.assign({}, learned); notes.push("用法の記載なし → よく使う用法を入れました"); ["times", "days", "timing", "meal"].forEach(k => unsure.add(k)); }
    }

    if (usage.tonpuku) {
      bag.tonpuku = true;
      bag.tonpuku_count = usage.count || "";
      bag.tonpuku_when = usage.when || [];
      bag.tonpuku_amount = items[0].qty != null ? fmtNum(items[0].qty) : "";
      if (!bag.tonpuku_count) unsure.add("tonpuku_count");
    } else {
      bag.times = usage.times || "";
      bag.days = usage.days || "";
      bag.timing = usage.timing || [];
      bag.meal = usage.meal || "";
      if (!bag.times) { ["times", "timing", "meal"].forEach(k => unsure.add(k)); notes.push("用法（3×N など）が見つかりません"); }
      if (!bag.days) unsure.add("days");
    }

    const rows = {};
    const times = /^\d+$/.test(bag.times) ? +bag.times : null;
    for (const it of items) {
      const row = UNIT_ROW[it.unit] || FORM_ROW[it.drug.form] || "tablet";
      let per = null;
      if (it.qty != null) per = bag.tonpuku ? it.qty : (times ? it.qty / times : null);
      (rows[row] = rows[row] || []).push(per);
    }
    if (!bag.tonpuku) {
      for (const [row, pers] of Object.entries(rows)) {
        if (pers.some(p => p == null)) { unsure.add(row); continue; }
        if (pers.every(p => Math.abs(p - pers[0]) < 1e-9)) bag[row] = (pers.length > 1 ? "各" : "") + fmtNum(pers[0]);
        else { bag[row] = fmtNum(pers.reduce((a, b) => a + b, 0)); unsure.add(row); notes.push("1回量が薬ごとに異なります（合計を入れています）"); }
      }
    }
    if (items.length > 1) bag.dose_note = `${items.length}種類`;
    bag.uncertain = [...unsure].sort();
    bag.comment = [...new Set(notes)].join("・");
    return bag;
  }

  function gaiyouBag(drug, qty, unit, body, line, defaultTimes, sites, unsure, learn) {
    const bag = emptyBag("gaiyou");
    bag.drug_names = [drug.name];
    bag.source = line;
    bag.kind = GAIYOU_KINDS.includes(drug.form) ? drug.form : "ぬり薬";
    bag.qty = qty; bag.unit = unit;
    const notes = [];
    const uns = new Set(unsure ? ["drugs"] : []);
    if (unsure) notes.push("薬品名の読み取りに自信がありません");
    if (drug.unknown) { bag.unknown_drug = drug.name; notes.push("薬品マスタにない薬です"); }

    const cm = body.match(RE_CONTAINERS);
    if (cm) { bag.qty = +cm[1]; bag.containers = +cm[2]; }
    bag.drugs = [`${drug.name} ${bag.containers >= 2 ? fmtNum(bag.qty) + "×" + bag.containers : qtyText(qty, unit)}`.trim()];

    const m = body.match(RE_TIMES_1DAY) || body.match(RE_USAGE);
    if (m) { bag.times = m[1]; bag._timesFromLine = true; }
    else if (drug.times) bag.times = String(drug.times);
    else {
      const lu = learnedGaiyou(drug.name, learn);
      if (lu && lu.times) { bag.times = lu.times; uns.add("times"); notes.push("回数の記載なし → よく使う回数"); }
      else { bag.times = String(defaultTimes); uns.add("times"); notes.push(`回数の記載なし → 既定の1日${defaultTimes}回`); }
    }

    let siteText = "";
    const pm = body.match(RE_PAREN);
    if (pm) siteText = pm[1];
    else {
      const qms = qtyMatches(body);
      let after = qms.length ? body.slice(qms[qms.length - 1].index + qms[qms.length - 1][0].length) : "";
      if (cm) after = body.slice(body.indexOf(cm[0]) + cm[0].length);
      siteText = after.replace(RE_TIMES_1DAY, "").replace(RE_USAGE, "");
    }
    siteText = siteText.replace(/^[\s　・]+|[\s　・]+$/g, "");
    if (siteText) {
      const [site, sconf] = matchSite(siteText, sites);
      bag.site = site;
      if (!sconf) uns.add("site");
    } else {
      const lu = learnedGaiyou(drug.name, learn);
      if (lu && lu.site) { bag.site = lu.site; uns.add("site"); notes.push("部位の記載なし → よく使う部位"); }
    }
    if (drug.note) notes.push(drug.note);
    bag.uncertain = [...uns].sort();
    bag.comment = notes.join("・");
    return bag;
  }

  // ---------------------------------------------------------------- 学習データの参照
  function lookupOcrFix(line, learn, drugs) {
    const map = learn.ocrFix || {};
    const k = fuzzkey(line);
    if (k.length < 3) return null;
    if (map[k]) return map[k].to;
    // 薬として読めている行は置き換えない
    let best = null, score = 0;
    for (const [key, v] of Object.entries(map)) {
      const s = similarity(k, key);
      if (s > score) { score = s; best = v; }
    }
    if (best && score >= 0.85) {
      const [d] = matchDrug(line.replace(RE_PAREN, ""), drugs);
      if (!d) return best.to;
    }
    return null;
  }
  function learnedUsage(names, learn) {
    const key = names.slice().sort().join("|");
    const stats = (learn.usage || {})[key];
    if (!stats) return null;
    const best = Object.entries(stats).sort((a, b) => b[1] - a[1])[0];
    return best ? JSON.parse(best[0]) : null;
  }
  function learnedGaiyou(name, learn) {
    const stats = (learn.gaiyou || {})[name];
    if (!stats) return null;
    const pick = obj => { const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1])[0]; return e ? e[0] : ""; };
    return { times: pick(stats.times), site: pick(stats.site) };
  }

  // 確定した袋を、カルテの書き方の行に戻す（よく使う処方として保存する用）
  function bagToText(b, defaultTimes) {
    if (b.type === "naifuku") {
      const lines = (b.drugs || []).slice();
      lines.push(usageText({ times: b.times, timing: b.timing, meal: b.meal, days: b.days, tonpuku: b.tonpuku, count: b.tonpuku_count, when: b.tonpuku_when }));
      return lines.join("\n");
    }
    const name = (b.drugs && b.drugs[0]) || "";
    return `${name} 1日${b.times}回${b.site ? " " + b.site : ""}`.trim();
  }

  global.KarteParser = { parse, norm, fuzzkey, similarity, matchDrug, prepareDrugs, prepareSites, bagToText, usageText, GAIYOU_KINDS };
})(typeof window !== "undefined" ? window : globalThis);
