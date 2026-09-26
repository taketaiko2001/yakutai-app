// 手書きカルテの読み取り結果（2つの認識モデルが出した「各位置でどの文字らしいか」の確率）を、
// 院内の薬・部位の一覧と照らし合わせて、カルテの書き方の行（例:「ヘパリン類似物質ローション 4本 (顔保湿)」）に組み立てる。
// 1文字ずつの読み取りが崩れていても、一覧の中で最も当てはまる名前を選べるのがポイント。
(function (global) {
  "use strict";

  // 手書きで区別しにくい文字のグループ（同じグループの文字は同じとみなして照合する）
  const GROUPS = ["ヘへ", "ベべ", "ペぺ", "ー一-－—ｰ~〜_", "ロ口□", "カ力か", "ニ二", "エ工", "タ夕", "ト卜", "ハ八", "リりソ", "ミ三",
    "l1Iі|丨", "o0O。°", "ソン", "ツシ", "ナ十", "チ千", "オ才", "ホ木", "ム△", "cC", "n几", "T丁", "オォ", "ツッ", "ユュ", "ヤャ", "ヨョ",
    "イィ", "アァ", "エェ", "ウゥ", "クグ", "ミシ", "ラう", "×xX", "Nn", "Zz", "Pp",
    "ハバパ", "ヒビピ", "フブプ", "ヘベペ", "ホボポ", "カガ", "キギ", "ケゲ", "コゴ", "サザ", "シジ", "スズ", "セゼ", "ソゾ", "タダ", "チヂ", "ツヅ", "テデ", "トド"];
  const DAYS_COMMON = [3, 4, 5, 7, 10, 14, 21, 28, 30, 35, 42, 56, 60, 84, 90];
  // 行の中の「回数」の書き方（カルテ → 印字）
  const TIMES_TOKENS = [["夜1", "夜1"], ["日1", "1"], ["日2", "2"], ["日3", "3"], ["数回", "数"]];

  const P = { confMinN: 3, confExtra: 3.0, bonus: 1.0, common: 1.0, adopted: 0.3, drugMin: -2.5, drugSure: 1.0, siteMin: 0.5, tokenMin: 0.4 };   // 判定のしきい値（テストで調整）

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
    const used = (learn && learn.drugCount) || {}, usedSite = (learn && learn.siteCount) || {};
    const prior = d => (d.common ? P.common : 0) + (d.adopted ? P.adopted : 0) + Math.min(1.5, 0.5 * Math.log2(1 + (used[d.name] || 0)));
    for (const d of data.drugs || []) {
      const emit = d.mix ? (d.aliases && d.aliases[0]) || d.name : d.name;
      const keys = [...new Set([d.name, ...(d.aliases || [])].map(keyOf))].filter(k => k.length >= 2 && k.length <= 16);
      // 2文字の略称（ミノ・GM など）は他の行に誤って当てはまりやすいので、長い呼び名がある薬では使わない
      // よく使う薬以外は、3文字の略称も（4文字以上の呼び名があれば）使わない。採用薬を増やしたときの誤検出を防ぐ
      const minLen = d.mix ? 0 : d.common ? 3 : 4;
      const useKeys = keys.some(k => k.length >= minLen) ? keys.filter(k => k.length >= minLen) : keys.filter(k => k.length >= Math.min(3, minLen)).length ? keys.filter(k => k.length >= Math.min(3, minLen)) : keys;
      for (const k of useKeys) drugs.push({ key: k, emit, drug: d, prior: prior(d) });
    }
    for (const s of data.sets || []) {
      const d = { name: s.name, type: "naifuku", set: true };
      for (const w of new Set([s.name, ...(s.aliases || [])])) {
        const k = keyOf(w);
        if (k.length >= 4) drugs.push({ key: k, emit: s.name, drug: d, prior: prior(d) });   // 短い書き方は他の行に当てはまりやすいので使わない
      }
    }
    const variants = (global.KarteParser && global.KarteParser.siteVariants) || (w => [w]);
    for (const s of data.sites || []) {
      for (const w of new Set([s.label, ...(s.aliases || [])].flatMap(variants))) {
        const k = keyOf(w);
        if (k.length >= 2) sites.push({ key: k, emit: s.label, prior: (s.common ? P.common * 0.5 : 0) + Math.min(1.5, 0.5 * Math.log2(1 + (usedSite[s.label] || 0))) });   // 1文字（手・足など）は誤検出が多いので照合しない
      }
    }
    const times = TIMES_TOKENS.map(([w, emit]) => ({ key: w, emit }));
    return { drugs, sites, times };
  }
  // ---------------------------------------------------------------- カタカナ優先の読み取り
  // カルテはカタカナで書かれることが多いので、読み取りの文字を「カタカナ・数字・カルテで使う記号と一部の漢字」に絞る。
  // ひらがなや形の似た漢字として読まれたものは、カタカナとして数える（例: う→ウ、口→ロ、力→カ）。
  const KATAKANA = (() => { let t = ""; for (let c = 0x30A1; c <= 0x30F6; c++) t += String.fromCharCode(c); return t + "ー"; })();
  const OUT_OTHER = "0123456789lorncgmpsTDNPZAGMVS()×.-/〃・本夜日回数錠包朝昼前後分顔体首手足虫頭全身保湿下肢指爪裏汗止刺悪所痒塩酪";
  const FOLD = { "口": "ロ", "□": "ロ", "力": "カ", "工": "エ", "夕": "タ", "卜": "ト", "八": "ハ", "二": "ニ", "三": "ミ", "千": "チ",
    "才": "オ", "一": "ー", "〜": "ー", "~": "ー", "—": "ー", "－": "-", "十": "ナ", "木": "ホ", "年": "本", "平": "本", "未": "本",
    "x": "×", "X": "×", "（": "(", "）": ")", "O": "o", "L": "l", "I": "l", "|": "l", "丁": "T", "〻": "〃", "々": "〃", "″": "〃", "\"": "〃" };
  // 出力する文字ごとに、それとみなす元の文字の一覧
  const OUT_MAP = (() => {
    const m = new Map();
    const add = (out, src) => { if (!m.has(out)) m.set(out, new Set([out])); m.get(out).add(src); };
    for (const c of KATAKANA) add(c, c);
    for (let c = 0x3041; c <= 0x3096; c++) add(String.fromCharCode(c + 0x60), String.fromCharCode(c));   // ひらがな → カタカナ
    for (const c of OUT_OTHER) add(c, c);
    for (const [src, out] of Object.entries(FOLD)) add(out, src);
    return [...m.entries()].map(([out, set]) => [out, [...set]]);
  })();
  const OUT_SRC = new Map(OUT_MAP);
  // 認識モデルの出力から残しておく文字（辞書の照合・数量や用法の読み取り・カタカナ優先の読み取りに使うもの）
  function keepChars(lex) {
    const set = new Set("0123456789×xXTDNnタ夕朝昼ネル前本錠包()（）-ー.,cgmlo夜日数回〃々");
    for (const e of [...lex.drugs, ...lex.sites, ...lex.times]) for (const c of e.key) for (const x of eqChars(c)) set.add(x);
    for (const [, srcs] of OUT_MAP) for (const c of srcs) set.add(c);
    return [...set].join("");
  }
  // m（1行分）をカタカナ優先で読む → [{t, ch}]
  function decodeKana(m) {
    const outs = [];
    for (const [out, srcs] of OUT_MAP) {
      const cols = srcs.map(c => m.cols.get(c)).filter(x => x != null);
      if (cols.length) outs.push([out, cols]);
    }
    const seq = [];
    let last = null;
    for (let t = 0; t < m.T; t++) {
      const off = t * m.K;
      let best = null, bv = m.seq ? -Infinity : m.blank[t];
      for (const [out, cols] of outs) {
        let v = -Infinity;
        for (const c of cols) if (m.lp[off + c] > v) v = m.lp[off + c];
        if (v > bv) { bv = v; best = out; }
      }
      if (best && (m.seq || best !== last)) seq.push({ t, ch: best });
      last = best;
    }
    return seq;
  }

  // ---------------------------------------------------------------- 医師ごとの字の癖
  // 確認済みの行から「本当の文字 c が、どの文字 r と読まれたか」を数えておき（profile.conf[モデル][c][r]）、
  // 照合のときに c の候補として r も（少しの減点で）認める。例: この先生の「ケ」は「ラ」と読まれやすい
  function confMap(counts) {
    const out = new Map();
    for (const [c, rs] of Object.entries(counts || {})) {
      const tot = Object.values(rs).reduce((a, b) => a + b, 0);
      const m = new Map();
      for (const [r, n] of Object.entries(rs)) {
        if (r === c || n < P.confMinN) continue;
        m.set(r, Math.max(-4, Math.min(-0.3, Math.log(n / tot))) - P.confExtra);
      }
      if (m.size) out.set(c, m);
    }
    return out;
  }
  // 照合する語 word の各文字について、見る列と減点
  function labOf(m, word) {
    const lab = [];
    for (const c of word) {
      const cols = [], pens = [];
      for (const x of eqChars(c)) { const k = m.cols.get(x); if (k != null) { cols.push(k); pens.push(0); } }
      const learned = m.conf && m.conf.get(c);
      if (learned) for (const [r, pen] of learned) for (const x of OUT_SRC.get(r) || [r]) {
        const k = m.cols.get(x);
        if (k != null) { cols.push(k); pens.push(pen); }
      }
      if (!cols.length) return null;
      lab.push({ ch: c, cols, pens });
    }
    return lab;
  }
  function labScore(m, off, l) {
    let v = -1e9;
    for (let k = 0; k < l.cols.length; k++) { const x = m.lp[off + l.cols[k]] + l.pens[k]; if (x > v) v = x; }
    return v;
  }
  // 2つの文字列の対応（編集距離）から、置き換わった文字の組を取り出す
  function alignPairs(a, b) {
    const n = a.length, m = b.length;
    const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    const pairs = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      if (d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { pairs.push([a[i - 1], b[j - 1]]); i--; j--; }
      else if (d[i][j] === d[i - 1][j] + 1) i--;
      else j--;
    }
    return pairs;
  }
  // 確認済みの1行（row）で、正しい語 key がどう読まれていたかを profile に数える
  function learnKey(profile, row, key) {
    profile.conf = profile.conf || {};
    for (const w of ["A", "J", "B"]) {
      const m = row[w];
      if (!m || !m.T) continue;
      const sp = (m.seq ? spotSeq : spot)(m, key);
      if (!sp) continue;
      const read = m.chars.filter(c => c.t >= sp.span[0] && c.t <= sp.span[1]).map(c => c.ch).join("");
      if (!read) continue;
      const cw = profile.conf[w] = profile.conf[w] || {};
      for (const [c, r] of alignPairs(key, read)) { const x = cw[c] = cw[c] || {}; x[r] = (x[r] || 0) + 1; }
    }
    profile.n = (profile.n || 0) + 1;
  }
  // 確認済みの行（読み取った行と、最終的な「カルテの内容」の行）から、医師の癖を覚える
  function learnRow(profile, row, finalLine, lex) {
    const t = String(finalLine || "").replace(/\s*[?？]\s*$/, "").trim();
    if (!t || t.startsWith("#")) return;
    const pick = (entries, emit) => {
      let best = null;
      for (const e of entries) {
        if (e.emit !== emit) continue;
        for (const w of ["A", "J", "B"]) {
          const m = row[w];
          if (!m || !m.T) continue;
          const sp = (m.seq ? spotSeq : spot)(m, e.key);
          if (sp && (!best || sp.pen + e.key.length > best.s)) best = { s: sp.pen + e.key.length, key: e.key };
        }
      }
      return best && best.key;
    };
    const d = lex.drugs.filter(e => t.startsWith(e.emit + " ") || t === e.emit).sort((a, b) => b.emit.length - a.emit.length)[0];
    if (d) { const k = pick(lex.drugs, d.emit); if (k) learnKey(profile, row, k); }
    const sm = t.match(/\(([^)〃]+)\)/);
    if (sm) { const k = pick(lex.sites, sm[1].trim()); if (k) learnKey(profile, row, k); }
  }

  // ---------------------------------------------------------------- 単語さがし（CTC）
  // m: { T, cols: Map(文字→列), K, lp: Float32Array(T*K) 各文字の対数確率, blank: Float32Array(T), max: Float32Array(T) }
  // word が行のどこか一部分として最も自然に当てはまるときの減点（0が最良）と、その区間 [t0, t1]
  function spot(m, word, from, to) {
    from = from || 0; to = to == null ? m.T : to;
    const L = word.length;
    const lab = labOf(m, word);
    if (!lab) return null;
    const S = 2 * L + 1, NEG = -1e9;
    let dp = new Float64Array(S).fill(NEG), st = new Int32Array(S);
    let nd = new Float64Array(S), ns = new Int32Array(S);
    let best = NEG, span = [0, 0];
    const ls = new Float64Array(L);
    for (let t = from; t < to; t++) {
      const off = t * m.K, mx = m.max[t];
      for (let i = 0; i < L; i++) ls[i] = labScore(m, off, lab[i]) - mx;
      const bl = m.blank[t] - mx;
      for (let s = 0; s < S; s++) {
        let v = dp[s], a = st[s];
        if (s >= 1 && dp[s - 1] > v) { v = dp[s - 1]; a = st[s - 1]; }
        if (s >= 3 && s % 2 === 1 && lab[(s - 1) / 2].ch !== lab[(s - 3) / 2].ch && dp[s - 2] > v) { v = dp[s - 2]; a = st[s - 2]; }
        if (s <= 1 && 0 > v) { v = 0; a = t; }         // どこからでも始めてよい
        nd[s] = v + (s % 2 === 0 ? bl : ls[(s - 1) / 2]);
        ns[s] = a;
      }
      [dp, nd] = [nd, dp]; [st, ns] = [ns, st];
      for (const s of [S - 2, S - 1]) if (dp[s] > best) { best = dp[s]; span = [st[s], t]; }
    }
    return { pen: best, span };
  }
  // 1文字ずつ順に出すモデル（NDLOCR-Lite の PARSeq）用の単語さがし。
  // 各位置の「その文字らしさ」で置き換えの減点を決め、文字の抜け・余分な文字も少しの減点で許す（行のどこか一部分に当てはめる）
  const SEQ = { ins: 2.5, del: 2.5, subMax: 6 };
  function spotSeq(m, word, from, to) {
    from = from || 0; to = to == null ? m.T : to;
    const L = word.length;
    const lab = labOf(m, word);
    if (!lab) return null;
    let prev = new Float64Array(L + 1), cur = new Float64Array(L + 1);
    let ps = new Int32Array(L + 1), cs = new Int32Array(L + 1);
    for (let j = 1; j <= L; j++) { prev[j] = j * SEQ.del; ps[j] = from; }
    let best = Infinity, span = [from, from];
    for (let i = from; i < to; i++) {
      const off = i * m.K, mx = m.max[i];
      cur[0] = 0; cs[0] = i + 1;
      for (let j = 1; j <= L; j++) {
        const sub = Math.min(SEQ.subMax, mx - labScore(m, off, lab[j - 1]));
        let cost = prev[j - 1] + sub, st = j === 1 ? i : ps[j - 1];
        if (cur[j - 1] + SEQ.del < cost) { cost = cur[j - 1] + SEQ.del; st = cs[j - 1]; }
        if (j < L && prev[j] + SEQ.ins < cost) { cost = prev[j] + SEQ.ins; st = ps[j]; }
        cur[j] = cost; cs[j] = st;
      }
      if (cur[L] < best) { best = cur[L]; span = [cs[L], i]; }
      [prev, cur] = [cur, prev]; [ps, cs] = [cs, ps];
    }
    return best === Infinity ? null : { pen: -best, span };
  }

  // 3つのモデル（A=汎用 v5・J=日本語 v4 は CTC、B=NDLOCR-Lite は1文字ずつ）の点数を合わせて、
  // 辞書の中から当てはまる語を良い順に k 個（印字する名前が同じものは1つにまとめる）。
  // w: モデルの種類ごとの重み。薬は両方を足し、部位・回数は手書きに強い B だけで見る
  const W_DRUG = { ctc: 1, seq: 1 }, W_SITE = { ctc: 0, seq: 1 };
  const FLOOR = -5;
  function rankOf(row, entries, range, k, w) {
    w = w || W_DRUG;
    if (!row.B) w = { ctc: 1, seq: 0 };                  // B がない（読み取れなかった）ときは CTC だけで
    const best = new Map();
    for (const e of entries) {
      let ctc = null, seq = null, pen = -Infinity;
      const spans = {};
      for (const which of ["A", "J", "B"]) {
        const m = row[which];
        if (!m) continue;
        if ((m.seq ? w.seq : w.ctc) === 0) continue;
        const r = range ? range[which] : null;
        if (range && !r) continue;
        const sp = (m.seq ? spotSeq : spot)(m, e.key, r ? r[0] : 0, r ? r[1] : m.T);
        if (!sp) continue;
        const sc = sp.pen + P.bonus * e.key.length;
        spans[which] = sp.span;
        if (sp.pen > pen) pen = sp.pen;
        if (m.seq) seq = seq == null ? sc : Math.max(seq, sc); else ctc = ctc == null ? sc : Math.max(ctc, sc);
      }
      if (ctc == null && seq == null) continue;
      const score = w.ctc * (ctc == null ? FLOOR : ctc) + w.seq * (seq == null ? FLOOR : seq) + (e.prior || 0);
      const cur = best.get(e.emit);
      if (!cur || score > cur.score) best.set(e.emit, { score, pen, e, spans, wsum: w.ctc + w.seq });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k || 5);
  }
  function bestOf(row, entries, range, w) { return rankOf(row, entries, range, 1, w)[0] || null; }

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
    // 書き方ごとに、各モデルの読みを集めて多数決（同数なら小さいほう。本数の読みすぎで袋のサイズを誤らないように）
    for (const [re, f] of pats) {
      const got = ts.map(t => t.match(re)).filter(Boolean).map(f);
      if (!got.length) continue;
      const cnt = new Map();
      got.forEach(g => cnt.set(g, (cnt.get(g) || 0) + 1));
      const best = [...cnt.entries()].sort((a, b) => b[1] - a[1] || parseFloat(a[0].replace(/^-/, "")) - parseFloat(b[0].replace(/^-/, "")))[0][0];
      return { text: best, sure: cnt.get(best) >= 2 };
    }
    return null;
  }

  // 行の頭の「Rp)」とその読み違い（{P) =P) 2P) など）・箇条書きの点を除く
  function stripHead(t) {
    return norm(t).trim().replace(/^[(（]?[RrＲ尺2{}=]?[PpＰ][)）][\s.。、・]*/, "").replace(/^[^\s(（]{1,3}\)[\s.。、・]*/, "").replace(/^[\s・.\-ー—]+/, "");
  }
  function startsParen(row) {
    return /^[(（Cc<{[]/.test(stripHead(row.ta)) || /^[(（]/.test(stripHead(row.tb));
  }

  function timesText(tm) { return tm.e.emit === "夜1" ? "夜1" : tm.e.emit === "数" ? "1日数回" : `日${tm.e.emit}`; }

  // 候補の薬 cand で、この行を「カルテの書き方の1行」にする
  function composeDrug(row, cand, lex, usage) {
    const d = cand.e.drug;
    const tails = ["B", "A", "J"].filter(w => row[w]).map(w => tailText(row[w], cand.spans[w] ? cand.spans[w][1] : -1));
    const type = d.type === "gaiyou" ? "gaiyou" : "naifuku";
    let q = d.set ? null : readQty(tails, type);
    let guessed = false;
    if (!q && type === "naifuku" && d.dose) { q = { text: d.dose }; guessed = true; }
    const parts = [cand.e.emit];
    if (q) parts.push(q.text);
    if (type === "gaiyou") {
      const range = {};
      for (const w of ["A", "J", "B"]) if (row[w]) range[w] = [cand.spans[w] ? cand.spans[w][1] + 1 : 0, row[w].T];
      const site = bestOf(row, lex.sites, range, W_SITE);
      if (site && site.score >= P.siteMin) parts.push(`(${site.e.emit})`);
      const tm = bestOf(row, lex.times, range, W_SITE);
      if (tm && tm.pen > -P.tokenMin * 3) parts.push(timesText(tm));
    } else if (usage.times || usage.days) {
      if (usage.times) parts.push(`${usage.times}×${usage.code}`);
      if (usage.days) parts.push(`${usage.days}TD`);
    }
    // 本数が多い（袋のサイズに関わる）のにモデル間で読みがそろわないときも確認してもらう
    const bigQty = q && /^\d+本$/.test(q.text) && parseInt(q.text) >= 5 && !q.sure;
    const unsure = cand.score < P.drugSure * cand.wsum || guessed || bigQty;
    return parts.join(" ") + (unsure ? " ？" : "");
  }

  // rows: makeRows の結果（上から順）。lex: buildLexicon の結果。
  // 戻り値: 行ごとの { kind, text, alts: [{label, text}]（選び直し候補）, row }
  const RE_QTY_HINT = /\d\s*[本木末平年T丁]|[-ー~]\s*[1-4](?![\d.])|\d\s*g(?![a-z])/;
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
        const st = bestOf(row, lex.sites, null, W_SITE);
        if (st && st.score * drugs[0].wsum > drugs[0].score) { paren = true; drugs = []; }
      }
      const drugAlts = drugs.map(c => ({ label: c.e.emit, text: composeDrug(row, c, lex, usage) }));
      if (drugs.length && drugs[0].score >= P.drugMin * drugs[0].wsum) {
        return { kind: "drug", text: drugAlts[0].text, alts: drugAlts, row };
      }
      // 点数は低くても「2本」「3T」「-3」のような数量が読めた行は薬の行とみて、いちばん近い薬を「？」付きで出す（候補から選び直せる）
      if (drugs.length && !usage.times && RE_QTY_HINT.test(ta + " " + tb)) {
        const t = drugAlts[0].text;
        return { kind: "drug", text: /[?？]\s*$/.test(t) ? t : t + " ？", alts: drugAlts, row, guess: true };
      }
      if (usage.times) {
        return { kind: "usage", text: `${usage.times}×${usage.code}` + (usage.days ? ` ${usage.days}TD` : ""), alts: drugAlts, row };
      }
      if (paren || /[(（]/.test(ta + tb)) {
        const sites = rankOf(row, lex.sites, null, 5, W_SITE);
        const tm = bestOf(row, lex.times, null, W_SITE);
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
    const m = { T, K, cols, lp, blank, max, chars: seq, seq: list[0].kind === "seq" };
    m.chars = decodeKana(m);   // 表示・数量の読み取りには、カタカナ優先で読んだ文字を使う
    return m;
  }
  // profile: その医師の癖（learnRow で覚えたもの。省略可）
  function makeRows(items, profile) {
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
      const A = unpack(r.items.map(i => i.A)), B = unpack(r.items.map(i => i.B));
      // 文字の塊（検出した枠）の切れ目に空白を入れて1行の文字列にする
      const text = (m, list) => {
        if (!m) return "";
        const ends = []; let off = 0;
        for (const it of list) { off += it.T; ends.push(off); }
        let s = "", k = 0;
        for (const c of m.chars) { while (k < ends.length - 1 && c.t >= ends[k]) { if (s && !s.endsWith(" ")) s += " "; k++; } s += c.ch; }
        return s.trim();
      };
      const J = r.items[0].J ? unpack(r.items.map(i => i.J)) : null;
      if (profile && profile.conf) for (const [w, m] of [["A", A], ["J", J], ["B", B]]) if (m) m.conf = confMap(profile.conf[w]);
      return { ta: text(A, r.items.map(i => i.A)), tb: B && B.T ? text(B, r.items.map(i => i.B)) : (J ? text(J, r.items.map(i => i.J)) : ""), A, B: B && B.T ? B : null, J,
        box: { x: Math.min(...r.items.map(i => i.x)), x2: Math.max(...r.items.map(i => i.x2 != null ? i.x2 : i.x)), top: r.top, bottom: r.bottom } };
    });
  }

  global.KarteReader = { buildLexicon, keepChars, spot, spotSeq, read, learnRow, learnKey, alignPairs, keyOf, makeRows, bestOf, rankOf, P };
})(typeof window !== "undefined" ? window : globalThis);
