// 端末内の保存データ（設定・マスタ・袋サイズのルール・学習データ）。外部には送らない。
(function (global) {
  "use strict";
  const KEY = "yakutai_app_v1";
  const D = global.DEFAULT_DATA;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function defaults() {
    return {
      version: 1,
      settings: { gaiyouDefaultTimes: "2", yearFormat: "reiwa", paper: "bag", paperOffsetX: 0, paperOffsetY: 0, doctor: "" },
      // 医師（カルテの日付の横の印）。印の文字で見分け、医師ごとに字の癖・よく使う薬や部位を覚える
      doctors: [{ id: "i", mark: "イ", name: "イ" }, { id: "k", mark: "K", name: "K" }, { id: "a", mark: "ア", name: "ア" },
        { id: "n", mark: "N", name: "N", alt: ["√", "✓", "✔", "レ"] }],
      sizes: clone(D.layout.sizes),
      calibration: clone(D.layout.calibration),
      dataVersion: D.version,
      drugs: clone(D.drugs),
      sets: clone(D.sets || []),
      sites: clone(D.sites),
      rules: clone(D.rules),
      learn: { presets: {}, usage: {}, gaiyou: {}, ocrFix: {}, drugCount: {}, siteCount: {}, count: 0, byDoctor: {} },
    };
  }
  let data;
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      data = raw ? Object.assign(defaults(), JSON.parse(raw)) : defaults();
    } catch (e) { data = defaults(); }
    data.learn = Object.assign(defaults().learn, data.learn || {});
    if (!data.doctors) data.doctors = defaults().doctors;
    upgrade();
    return data;
  }
  // アプリの更新で初期データ（薬・部位・ルール）が増えたとき、端末の保存データに足す（編集した内容は残す）
  function upgrade() {
    if ((data.dataVersion || 1) >= D.version) return;
    const addBy = (list, defs, key) => { for (const x of defs) if (!list.some(y => y[key] === x[key])) list.push(clone(x)); };
    // 名前を変えた薬（先発名 → 採用している製品名）・まとめた薬：端末の薬と学習データの名前も付け替える
    for (const [o, n] of Object.entries(D.renamed || {})) {
      const d = data.drugs.find(x => x.name === o);
      if (!d) continue;
      const t = data.drugs.find(x => x.name === n);
      if (t) { t.aliases = [...new Set([...(t.aliases || []), o])]; data.drugs.splice(data.drugs.indexOf(d), 1); }
      else { d.name = n; d.aliases = [...new Set([o, ...(d.aliases || [])])]; }
      data.learn = JSON.parse(JSON.stringify(data.learn).split(o).join(n));
    }
    // 名前を変えた部位（薬袋の書き方にそろえたもの。例: かお → 顔）
    for (const [o, n] of Object.entries(D.siteRenamed || {})) {
      const s = data.sites.find(x => x.label === o);
      if (!s) continue;
      const t = data.sites.find(x => x.label === n);
      if (t) { t.aliases = [...new Set([...(t.aliases || []), o, ...(s.aliases || [])])]; data.sites.splice(data.sites.indexOf(s), 1); }
      else { s.label = n; s.aliases = [...new Set([o, ...(s.aliases || [])])]; }
      data.learn = JSON.parse(JSON.stringify(data.learn).split(JSON.stringify(o)).join(JSON.stringify(n)));
    }
    addBy(data.drugs, D.drugs, "name");
    addBy(data.sites, D.sites, "label");
    addBy(data.doctors, defaults().doctors, "mark");
    for (const x of data.doctors) { const def = defaults().doctors.find(y => y.mark === x.mark); if (def && def.alt && !x.alt) x.alt = def.alt; }
    data.sets = data.sets || [];
    addBy(data.sets, D.sets || [], "name");
    for (const d of data.drugs) {                 // 初期データ側で増えた略称・印などを反映
      const def = D.drugs.find(x => x.name === d.name);
      if (!def) continue;
      d.aliases = [...new Set([...(d.aliases || []), ...(def.aliases || [])])];
      for (const k of ["common", "mix", "dose", "adopted", "syrup", "site"]) if (def[k] != null && d[k] == null) d[k] = def[k];
      if (def.fixedTimes) { d.fixedTimes = true; d.times = def.times; d.note = def.note; }   // 回数が決まっている薬（クレナフィン・ルコナック＝夜1回）
    }
    for (const s of data.sites) {
      const def = D.sites.find(x => x.label === s.label);
      if (def) { s.aliases = [...new Set([...(s.aliases || []), ...def.aliases])]; if (def.common && s.common == null) s.common = true; }
    }
    data.rules = data.rules.map(r => { const def = D.rules.find(x => x.id === r.id); return def ? clone(def) : r; });
    addBy(data.rules, D.rules, "id");
    if (data.sizes && data.sizes.small && data.sizes.small.width_mm === 110 && data.sizes.small.height_mm === 156) data.sizes.small = clone(D.layout.sizes.small);
    data.dataVersion = D.version;
    save();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { alert("端末に保存できませんでした（容量不足の可能性）"); }
  }
  function layout() {
    const L = clone(D.layout);
    L.sizes = data.sizes; L.calibration = data.calibration;
    return L;
  }

  // ---------------------------------------------------------------- 袋サイズのルール
  function bagWords(bag) { return [...(bag.drug_names || []), ...(bag.drugs || [])].join(" "); }
  function ruleMatches(rule, bag) {
    const w = bagWords(bag);
    switch (rule.kind) {
      case "all_of": return rule.words.length > 0 && rule.words.every(x => w.includes(x));
      case "any_of": return rule.words.some(x => x && w.includes(x));
      case "qty_at_least": {
        if (rule.words && rule.words.length && !rule.words.some(x => w.includes(x))) return false;
        return bag.type === "gaiyou" && bag.unit === rule.unit && (+bag.qty || 0) >= rule.n;
      }
      case "containers_at_least": return (+bag.containers || 0) >= rule.n && (!rule.minNo || (+bag.containerNo || 0) >= rule.minNo);
      case "days_at_least": return bag.type === "naifuku" && (+bag.days || 0) >= rule.n &&
        (!rule.words || !rule.words.length || rule.words.some(x => w.includes(x)));
      default: return false;
    }
  }
  function decideSize(bag) {
    for (const r of data.rules) if (ruleMatches(r, bag)) return { size: r.size, reason: r.memo || ruleText(r) };
    return { size: "small", reason: "" };
  }
  function ruleText(r) {
    const big = r.size === "A5" ? "大きい袋" : "小さい袋";
    const ws = (r.words || []).join("・");
    switch (r.kind) {
      case "all_of": return `『${ws}』がすべて入っている → ${big}`;
      case "any_of": return `『${ws}』のどれかが入っている → ${big}`;
      case "qty_at_least": return `${ws ? "『" + ws + "』が" : ""}${r.n}${r.unit}以上 → ${big}`;
      case "containers_at_least": return `${r.minNo ? r.minNo + "番以上の" : ""}混合容器が${r.n}個以上 → ${big}`;
      case "days_at_least": return `${ws ? "『" + ws + "』で" : "内服が"}${r.n}日分以上 → ${big}`;
      default: return "";
    }
  }

  // ---------------------------------------------------------------- 学習
  function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

  // ---------------------------------------------------------------- 医師ごとの学習
  function doctorLearn(id) {
    const B = data.learn.byDoctor = data.learn.byDoctor || {};
    return B[id || "_"] = B[id || "_"] || { drugCount: {}, siteCount: {}, gaiyou: {}, hand: {}, n: 0 };
  }
  // 読み取り・解析に使う学習データ：全体の学習に、その医師の分を上乗せ（医師の分を重く）
  function learnFor(id) {
    const L = data.learn, P = id ? doctorLearn(id) : null;
    if (!P) return L;
    const add = (a, b, w) => { const o = Object.assign({}, a); for (const [k, v] of Object.entries(b || {})) o[k] = (o[k] || 0) + v * w; return o; };
    const gaiyou = Object.assign({}, L.gaiyou);
    for (const [name, g] of Object.entries(P.gaiyou || {})) {
      const base = gaiyou[name] || { times: {}, site: {} };
      gaiyou[name] = { times: add(base.times, g.times, 3), site: add(base.site, g.site, 3) };
    }
    return Object.assign({}, L, { drugCount: add(L.drugCount, P.drugCount, 3), siteCount: add(L.siteCount, P.siteCount, 3), gaiyou, hand: P.hand });
  }
  // 確定した内容を、その医師の学習データに足す（readLines: 読み取った行と最終的な行、lex: 照合用の一覧）
  function learnDoctor(id, bags, readLines, lex) {
    const P = doctorLearn(id);
    P.n++;
    for (const b of bags) {
      const names = (b.drug_names || []).filter(n => n && n !== "（薬品名不明）");
      for (const n of names) bump(P.drugCount, n);
      if (b.site) { bump(P.siteCount, b.site); bump(data.learn.siteCount = data.learn.siteCount || {}, b.site); }
      if (b.type === "gaiyou" && names.length) {
        const g = P.gaiyou[names[0]] || (P.gaiyou[names[0]] = { times: {}, site: {} });
        if (b.times) bump(g.times, b.times);
        if (b.site) bump(g.site, b.site);
      }
    }
    if (readLines && lex && global.KarteReader) {
      for (const l of readLines) if (l.row && l.cur && !l.cur.startsWith("#")) global.KarteReader.learnRow(P.hand, l.row, l.cur, lex);
    }
    save();
  }

  // 印刷を確定したときに呼ぶ。bags: 確定した袋、ocrInitial: 読み取り直後の行 [{text, raw}]（または文字列）、finalText: 確定時の内容
  function learnFrom(bags, ocrInitial, finalText) {
    const L = data.learn;
    L.count = (L.count || 0) + 1;
    for (const b of bags) {
      const names = (b.drug_names || []).filter(n => n && n !== "（薬品名不明）");
      if (!names.length) continue;
      L.drugCount = L.drugCount || {};
      for (const n of names) bump(L.drugCount, n);
      const text = global.KarteParser.bagToText(b);
      const p = L.presets[text] || (L.presets[text] = { n: 0, last: 0 });
      p.n++; p.last = Date.now();
      if (b.type === "naifuku" && !b.tonpuku && b.times) {
        const key = names.slice().sort().join("|");
        L.usage[key] = L.usage[key] || {};
        bump(L.usage[key], JSON.stringify({ times: b.times, timing: b.timing, meal: b.meal, days: b.days }));
      }
      if (b.type === "gaiyou") {
        const g = L.gaiyou[names[0]] || (L.gaiyou[names[0]] = { times: {}, site: {} });
        if (b.times) bump(g.times, b.times);
        if (b.site) bump(g.site, b.site);
      }
    }
    // 読み取り直後の行が、同じ位置で人の入力（候補の選び直し・手入力）に置き換わっていたら、元の読み取り結果と一緒に覚える
    if (ocrInitial && ocrInitial.length) {
      const init = Array.isArray(ocrInitial) ? ocrInitial : ocrInitial.split("\n").map(t => ({ text: t, raw: t.replace(/^#\s*/, "") }));
      const a = init.map(x => x.text), f = finalText.split("\n");
      for (const [i, j] of alignReplaced(a, f)) {
        const to = f[j].trim().replace(/\s*[?？]\s*$/, "");
        const k = global.KarteParser.fuzzkey(init[i].raw || "");
        if (k.length >= 3 && to && !to.startsWith("#")) L.ocrFix[k] = { to, n: ((L.ocrFix[k] || {}).n || 0) + 1 };
      }
    }
    save();
  }
  // 操作なしで印刷したとき：自信を持って読めた袋（推測した項目がないもの）だけを、よく使う薬・部位・用法として覚える
  // （推測を含む袋まで覚えると読み違いを覚えてしまうため。直して作り直したときは learnFrom ですべて覚える）
  function learnConfident(bags, doctorId) {
    const ok = (bags || []).filter(b => !(b.uncertain || []).length && (b.drug_names || []).length && !b.drug_names.includes("（薬品名不明）"));
    if (!ok.length) return 0;
    const L = data.learn, P = doctorLearn(doctorId);
    L.drugCount = L.drugCount || {}; L.siteCount = L.siteCount || {};
    for (const b of ok) {
      for (const n of b.drug_names) { bump(L.drugCount, n); bump(P.drugCount, n); }
      if (b.site) { bump(L.siteCount, b.site); bump(P.siteCount, b.site); }
      if (b.type === "gaiyou") {
        for (const G of [L.gaiyou, P.gaiyou]) {
          const g = G[b.drug_names[0]] || (G[b.drug_names[0]] = { times: {}, site: {} });
          if (b.times) bump(g.times, b.times);
          if (b.site) bump(g.site, b.site);
        }
      } else if (!b.tonpuku && b.times) {
        const key = b.drug_names.slice().sort().join("|");
        L.usage[key] = L.usage[key] || {};
        bump(L.usage[key], JSON.stringify({ times: b.times, timing: b.timing, meal: b.meal, days: b.days }));
      }
    }
    save();
    return ok.length;
  }
  // 行の差分から「a[i] が f[j] に置き換えられた」組を拾う（単純な LCS による対応付け）
  function alignReplaced(a, f) {
    const n = a.length, m = f.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i].trim() === f[j].trim() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const pairs = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i].trim() === f[j].trim()) { i++; j++; continue; }
      if (dp[i + 1][j] === dp[i][j + 1] && !f[j].trim().startsWith("#")) { pairs.push([i, j]); i++; j++; continue; }
      if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    return pairs;
  }
  function presets(limit) {
    const learned = Object.entries(data.learn.presets)
      .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
      .slice(0, limit || 12)
      .map(([text, v]) => ({ title: text.split("\n").map(l => l.replace(/（.*?）/g, "")).join(" / "), text, n: v.n }));
    const seen = new Set(learned.map(p => p.text));
    return [...D.presets.filter(p => !seen.has(p.text)).map(p => Object.assign({ n: 0 }, p)), ...learned];
  }

  function exportJSON() { return JSON.stringify(data, null, 1); }
  function importJSON(text) {
    const obj = JSON.parse(text);
    if (!obj || obj.version !== 1) throw new Error("このアプリのバックアップファイルではありません");
    data = Object.assign(defaults(), obj);
    save();
  }
  function reset(part) {
    const d = defaults();
    if (part === "learn") data.learn = d.learn; else data = d;
    save();
  }

  load();
  global.Store = {
    get data() { return data; }, save, layout, decideSize, ruleText, learnFrom, learnConfident, learnDoctor, learnFor, doctorLearn, presets, exportJSON, importJSON, reset,
  };
})(window);
