// 手書きカルテの読み取り結果（2つの認識モデルが出した「各位置でどの文字らしいか」の確率）を、
// 院内の薬・部位の一覧と照らし合わせて、カルテの書き方の行（例:「ヘパリン類似物質ローション 4本 (顔保湿)」）に組み立てる。
// 1文字ずつの読み取りが崩れていても、一覧の中で最も当てはまる名前を選べるのがポイント。
(function (global) {
  "use strict";

  // 手書きで区別しにくい文字のグループ（同じグループの文字は同じとみなして照合する）
  const GROUPS = ["ヘへ", "ベべ", "ペぺ", "ー一-－—ｰ~〜_", "ロ口□", "カ力か", "ニ二", "エ工", "タ夕", "ト卜", "ハ八", "リりソ", "ミ三",
    "l1Iі|丨", "o0O。°", "ソン", "ツシ", "ナ十", "チ千", "オ才", "ホ木", "ム△", "cC", "n几", "T丁", "オォ", "ツッ", "ユュ", "ヤャ", "ヨョ",
    "イィ", "アァ", "エェ", "ウゥ", "クグ", "ミシ", "ラう", "×xX", "Nn", "Zz2", "Pp"];
  const DAYS_COMMON = [3, 4, 5, 7, 10, 14, 21, 28, 30, 35, 42, 56, 60, 84, 90];
  // 行の中の「回数」の書き方（カルテ → 印字）
  const TIMES_TOKENS = [["夜1", "夜1"], ["日1", "1"], ["日2", "2"], ["日3", "3"], ["数回", "数"]];

  const P = { bonus: 1.0, common: 1.0, drugMin: -1.0, drugSure: 1.5, siteMin: 1.0, tokenMin: 0.4 };   // 判定のしきい値（テストで調整）

  function kata(s) {
    return String(s || "").normalize("NFKC").replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  // 照合に使う形（全角→半角、ひらがな→カタカナ、空白・括弧などを除く）
  function keyOf(w) {
    return kata(w).replace(/（[^）]*）|\([^)]*\)$/g, "").replace(/[\s()（）・.、。]/g, "");
  }
  const EQ = new Map();
  function eqChars(c) {
    if (EQ.has(c)) return EQ.get(c);
    const set = new Set([c, c.toLowerCase(), c.toUpperCase()]);
    if (c >= "ァ" && c <= "ヶ") set.add(String.fromCharCode(c.charCodeAt(0) - 0x60));
    for (const g of GROUPS) if (g.includes(c)) for (const x of g) set.add(x);
    const out = [...set];
    EQ.set(c, out);
    return out;
  }

  // ---------------------------------------------------------------- 一覧（辞書）
  // learn: 学習データ（よく使う薬ほど選ばれやすくする）
  function buildLexicon(data, learn) {
    const drugs = [], sites = [];
    const used = (learn && learn.drugCount) || {};
    const prior = d => (d.common ? P.common : 0) + Math.min(1.5, 0.5 * Math.log2(1 + (used[d.name] || 0)));
    for (const d of data.drugs || []) {
      const emit = d.mix ? (d.aliases && d.aliases[0]) || d.name : d.name;
      const keys = [...new Set([d.name, ...(d.aliases || [])].map(keyOf))].filter(k => k.length >= 2 && k.length <= 16);
      // 2文字の略称（ミノ・GM など）は他の行に誤って当てはまりやすいので、長い呼び名がある薬では使わない
      const useKeys = keys.some(k => k.length >= 3) && !d.mix ? keys.filter(k => k.length >= 3) : keys;
      for (const k of useKeys) drugs.push({ key: k, emit, drug: d, prior: prior(d) });
    }
    for (const s of data.sets || []) {
      const d = { name: s.name, type: "naifuku", set: true, common: true };
      for (const w of new Set([s.name, ...(s.aliases || [])])) {
        const k = keyOf(w);
        if (k.length >= 2) drugs.push({ key: k, emit: s.name, drug: d, prior: prior(d) });
      }
    }
    const variants = (global.KarteParser && global.KarteParser.siteVariants) || (w => [w]);
    for (const s of data.sites || []) {
      for (const w of new Set([s.label, ...(s.aliases || [])].flatMap(variants))) {
        const k = keyOf(w);
        if (k.length >= 2) sites.push({ key: k, emit: s.label, prior: s.common ? P.common * 0.5 : 0 });   // 1文字（手・足など）は誤検出が多いので照合しない
      }
    }
    const times = TIMES_TOKENS.map(([w, emit]) => ({ key: w, emit }));
    return { drugs, sites, times };
  }
  // 認識モデルの出力から残しておく文字（辞書の照合と数量・用法の読み取りに使うもの）
  function keepChars(lex) {
    const set = new Set("0123456789×xXTDNnタ夕朝昼ネル前本錠包()（）-ー.,cgmlo夜日数回〃々");
    for (const e of [...lex.drugs, ...lex.sites, ...lex.times]) for (const c of e.key) for (const x of eqChars(c)) set.add(x);
    return [...set].join("");
  }

  // ---------------------------------------------------------------- 単語さがし（CTC）
  // m: { T, cols: Map(文字→列), K, lp: Float32Array(T*K) 各文字の対数確率, blank: Float32Array(T), max: Float32Array(T) }
  // word が行のどこか一部分として最も自然に当てはまるときの減点（0が最良）と、その区間 [t0, t1]
  function spot(m, word, from, to) {
    from = from || 0; to = to == null ? m.T : to;
    const L = word.length;
    const lab = [];
    for (const c of word) {
      const cols = eqChars(c).map(x => m.cols.get(x)).filter(x => x != null);
      if (!cols.length) return null;
      lab.push(cols);
    }
    const S = 2 * L + 1, NEG = -1e9;
    let dp = new Float64Array(S).fill(NEG), st = new Int32Array(S);
    let nd = new Float64Array(S), ns = new Int32Array(S);
    let best = NEG, span = [0, 0];
    const ls = new Float64Array(L);
    for (let t = from; t < to; t++) {
      const off = t * m.K, mx = m.max[t];
      for (let i = 0; i < L; i++) {
        let v = NEG;
        for (const c of lab[i]) if (m.lp[off + c] > v) v = m.lp[off + c];
        ls[i] = v - mx;
      }
      const bl = m.blank[t] - mx;
      for (let s = 0; s < S; s++) {
        let v = dp[s], a = st[s];
        if (s >= 1 && dp[s - 1] > v) { v = dp[s - 1]; a = st[s - 1]; }
        if (s >= 3 && s % 2 === 1 && lab[(s - 1) / 2] !== lab[(s - 3) / 2] && dp[s - 2] > v) { v = dp[s - 2]; a = st[s - 2]; }
        if (s <= 1 && 0 > v) { v = 0; a = t; }         // どこからでも始めてよい
        nd[s] = v + (s % 2 === 0 ? bl : ls[(s - 1) / 2]);
        ns[s] = a;
      }
      [dp, nd] = [nd, dp]; [st, ns] = [ns, st];
      for (const s of [S - 2, S - 1]) if (dp[s] > best) { best = dp[s]; span = [st[s], t]; }
    }
    return { pen: best, span };
  }
  // 2つのモデルのうち良いほうで、辞書の中から当てはまる語を良い順に k 個（印字する名前が同じものは1つにまとめる）
  function rankOf(row, entries, range, k) {
    const best = new Map();
    for (const e of entries) {
      for (const which of ["A", "B"]) {
        const m = row[which];
        if (!m) continue;
        const r = range ? range[which] : null;
        if (range && !r) continue;
        const sp = spot(m, e.key, r ? r[0] : 0, r ? r[1] : m.T);
        if (!sp) continue;
        const score = sp.pen + P.bonus * e.key.length + (e.prior || 0);
        const cur = best.get(e.emit);
        if (!cur || score > cur.score) best.set(e.emit, { score, pen: sp.pen, e, which, span: sp.span });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k || 5);
  }
  function bestOf(row, entries, range) { return rankOf(row, entries, range, 1)[0] || null; }

  // ---------------------------------------------------------------- 行の組み立て
  function norm(s) { return String(s || "").normalize("NFKC"); }
  const RE_DATE = /(?<!\d)(\d{1,2})\s*[.,/。、]\s*(\d{1,2})\s*[.,/。、]\s*(\d{1,2})/;
  const RE_USAGE = /(?:^|[^\d])([1-3lI|(])\s*[x×X+ナメ]\s*([NnWwuU4√HhVvタ夕7クネ朝昼])/;
  const RE_TD = /(\d{1,3})\s*(?:[TtＴ7]\s*)?[DdＤ0OoPpV]/;

  function readUsage(t) {
    t = norm(t);
    const u = {};
    const m = t.match(RE_USAGE);
    if (m) {
      u.times = /[lI|(]/.test(m[1]) ? "1" : m[1];
      const c = m[2];
      u.code = /[タ夕7ク]/.test(c) ? "タ" : c === "ネ" ? "ネル前" : c === "朝" ? "朝" : c === "昼" ? "昼" : "N";
      if (u.times === "1" && u.code === "N") u.code = "タ";
      const rest = t.slice(m.index + m[0].length);
      const d = readDays(rest);
      if (d) u.days = d;
    } else {
      const d = /td|日分/i.test(t) ? readDays(t) : null;
      if (d) u.days = d;
    }
    return u;
  }
  function readDays(t) {
    const m = norm(t).match(/(\d{1,4})/);
    if (!m) return null;
    const s = m[1];
    if (s.length >= 2 && DAYS_COMMON.includes(+s.slice(0, 2))) return s.slice(0, 2);
    if (DAYS_COMMON.includes(+s.slice(0, 1)) && s.length === 1) return s;
    if (s.length >= 2 && RE_TD.test(t)) return s.slice(0, 2) + "？";
    return null;
  }

  // 各フレームの位置に対応する文字（貪欲読み）→ 区間より後ろの文字列
  function tailText(m, t1) {
    if (!m || !m.chars) return "";
    return m.chars.filter(c => c.t > t1).map(c => c.ch).join("");
  }
  // tails: 2つのモデルの「薬の名前より後ろ」の文字列。書き方ごとに、どちらかで読めたものを採る
  function readQty(tails, type) {
    const ts = tails.map(norm);
    const pats = type === "gaiyou" ? [
      [/(\d{2,3})\s*(?:cc|CC|ml|mL)/, m => `${m[1]}cc`],
      [/([1-9]\d?)\s*[本年平木不下未]/, m => `${m[1]}本`],
      [/[-ー~_一]\s*([1-4])(?:\s*[x×X]\s*([1-9]))?(?!\d)/, m => `-${m[1]}${m[2] ? "×" + m[2] : ""}`],
    ] : [
      [/([1-9])\s*[TtＴてテ丁]/, m => `${m[1]}T`],
      [/([1-9])\s*(?:C|カ)/, m => `${m[1]}C`],
      [/([1-9])\s*包/, m => `${m[1]}包`],
      [/([1-9])\s*7/, m => `${m[1]}T`],
    ];
    for (const [re, f] of pats) for (const t of ts) { const m = t.match(re); if (m) return { text: f(m) }; }
    return null;
  }

  // 行の頭の「Rp)」とその読み違い（{P) =P) 2P) など）・箇条書きの点を除く
  function stripHead(t) { return norm(t).trim().replace(/^[^\s(（]{1,3}\)[\s.。、・]*/, "").replace(/^[\s・.\-ー—]+/, ""); }
  function startsParen(row) {
    return /^[(（Cc<{[]/.test(stripHead(row.ta)) || /^[(（]/.test(stripHead(row.tb));
  }

  function timesText(tm) { return tm.e.emit === "夜1" ? "夜1" : tm.e.emit === "数" ? "1日数回" : `日${tm.e.emit}`; }

  // 候補の薬 cand で、この行を「カルテの書き方の1行」にする
  function composeDrug(row, cand, lex, usage) {
    const d = cand.e.drug;
    const tailA = tailText(row.A, cand.which === "A" ? cand.span[1] : -1);
    const tailB = tailText(row.B, cand.which === "B" ? cand.span[1] : -1);
    const type = d.type === "gaiyou" ? "gaiyou" : "naifuku";
    let q = d.set ? null : readQty([tailA, tailB], type);
    let guessed = false;
    if (!q && type === "naifuku" && d.dose) { q = { text: d.dose }; guessed = true; }
    const parts = [cand.e.emit];
    if (q) parts.push(q.text);
    if (type === "gaiyou") {
      const range = {};
      range[cand.which] = [cand.span[1] + 1, row[cand.which].T];
      const other = cand.which === "A" ? "B" : "A";
      if (row[other]) range[other] = [0, row[other].T];
      const site = bestOf(row, lex.sites, range);
      if (site && site.score >= P.siteMin) parts.push(`(${site.e.emit})`);
      const tm = bestOf(row, lex.times, range);
      if (tm && tm.pen > -P.tokenMin * 3) parts.push(timesText(tm));
    } else if (usage.times || usage.days) {
      if (usage.times) parts.push(`${usage.times}×${usage.code}`);
      if (usage.days) parts.push(`${usage.days}TD`);
    }
    const unsure = cand.score < P.drugSure || guessed;
    return parts.join(" ") + (unsure ? " ？" : "");
  }

  // rows: makeRows の結果（上から順）。lex: buildLexicon の結果。
  // 戻り値: 行ごとの { kind, text, alts: [{label, text}]（選び直し候補）, row }
  function read(rows, lex) {
    let dateIdx = -1, dateVal = -1;
    const lines = rows.map((row, i) => {
      const ta = norm(row.ta), tb = norm(row.tb);
      const dm = ta.match(RE_DATE) || tb.match(RE_DATE);
      if (dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[3] >= 1 && +dm[3] <= 31) {
        const v = +dm[1] * 10000 + +dm[2] * 100 + +dm[3];
        if (v >= dateVal) { dateVal = v; dateIdx = i; }
        return { kind: "date", text: `${+dm[1]}.${+dm[2]}.${+dm[3]}`, alts: [], row };
      }
      let paren = startsParen(row);
      const usage = readUsage(ta);
      let drugs = paren ? [] : rankOf(row, lex.drugs, null, 5);
      if (!paren && drugs.length && /[(（]/.test(ta + tb)) {
        const st = bestOf(row, lex.sites);
        if (st && st.score > drugs[0].score) { paren = true; drugs = []; }
      }
      const drugAlts = drugs.map(c => ({ label: c.e.emit, text: composeDrug(row, c, lex, usage) }));
      if (drugs.length && drugs[0].score >= P.drugMin) {
        return { kind: "drug", text: drugAlts[0].text, alts: drugAlts, row };
      }
      if (usage.times) {
        return { kind: "usage", text: `${usage.times}×${usage.code}` + (usage.days ? ` ${usage.days}TD` : ""), alts: drugAlts, row };
      }
      if (paren || /[(（]/.test(ta + tb)) {
        const sites = rankOf(row, lex.sites, null, 5);
        const tm = bestOf(row, lex.times);
        const tmText = tm && tm.pen > -P.tokenMin * 3 ? " " + timesText(tm) : "";
        const siteAlts = [{ label: "〃（上と同じ）", text: "(〃)" }, ...sites.map(c => ({ label: c.e.emit, text: `(${c.e.emit})${tmText}` }))];
        const inner = t => (norm(t).match(/[(（]([^)）]*)/) || [, "xxx"])[1].replace(/\s/g, "");
        const ditto = /[〃々"″]/.test(ta + tb) || (inner(ta).length <= 2 && inner(tb).length <= 2);
        if (ditto) return { kind: "site", text: "(〃)", alts: siteAlts, row };
        if (sites.length && sites[0].score >= P.siteMin) return { kind: "site", text: siteAlts[1].text, alts: siteAlts, row };
        return { kind: "raw", text: "# " + (ta || tb), alts: siteAlts, row };
      }
      return { kind: "raw", text: "# " + (ta || tb), alts: drugAlts, row };
    });
    // 同じ紙に以前の日付の処方があれば、いちばん新しい日付より後ろだけを使う
    return lines.filter((l, i) => (dateIdx < 0 || i >= dateIdx) &&
      !(l.kind === "raw" && norm(l.text).replace(/[#\s]/g, "").length < 2));
  }

  // ---------------------------------------------------------------- 行にまとめる
  // items: [{ x, top, bottom, A, B }]。A/B は { T, chars: 残した文字の並び, lp: T×K の対数確率, blank, max, seq: [{t, ch}] }
  function unpack(list) {
    if (!list.length) return null;
    const chars = list[0].chars, K = chars.length;
    const T = list.reduce((a, m) => a + m.T, 0);
    const lp = new Float32Array(T * K), blank = new Float32Array(T), max = new Float32Array(T);
    const seq = [];
    let off = 0;
    for (const m of list) {
      lp.set(m.lp, off * K); blank.set(m.blank, off); max.set(m.max, off);
      for (const c of m.seq) seq.push({ t: c.t + off, ch: c.ch });
      off += m.T;
    }
    const cols = new Map(chars.map((c, i) => [c, i]));
    return { T, K, cols, lp, blank, max, chars: seq };
  }
  function makeRows(items) {
    items = items.slice().sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
    const rows = [];
    for (const it of items) {
      const r = rows.find(r => Math.min(r.bottom, it.bottom) - Math.max(r.top, it.top) > 0.4 * Math.min(r.bottom - r.top, it.bottom - it.top));
      if (r) { r.items.push(it); r.top = Math.min(r.top, it.top); r.bottom = Math.max(r.bottom, it.bottom); }
      else rows.push({ top: it.top, bottom: it.bottom, items: [it] });
    }
    rows.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      const text = w => r.items.map(i => i[w].seq.map(c => c.ch).join("")).join(" ").trim();
      return { ta: text("A"), tb: text("B"), A: unpack(r.items.map(i => i.A)), B: unpack(r.items.map(i => i.B)),
        box: { x: Math.min(...r.items.map(i => i.x)), x2: Math.max(...r.items.map(i => i.x2 != null ? i.x2 : i.x)), top: r.top, bottom: r.bottom } };
    });
  }

  global.KarteReader = { buildLexicon, keepChars, spot, read, keyOf, makeRows, bestOf, rankOf, P };
})(typeof window !== "undefined" ? window : globalThis);
