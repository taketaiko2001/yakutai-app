// PC の Claude Code（ご契約のサブスクリプションの範囲。有料APIキーは使わない）に、処方の部分の画像を読ませる。
// 画像はファイルに保存せず、メモリから直接渡す。読み取りの記録（セッション）も PC に残さない。
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
global.window = global.window || {};
require("../docs/js/data.js");
const D = window.DEFAULT_DATA;

// Claude Code の実行ファイル（VS Code の拡張機能に入っているもの。新しい版を優先）
function claudeExe() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const ext = path.join(process.env.USERPROFILE || "", ".vscode", "extensions");
  try {
    const ver = s => (s.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    const dirs = fs.readdirSync(ext).filter(d => /^anthropic\.claude-code-\d/.test(d))
      .sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
    for (const d of dirs) {
      const f = path.join(ext, d, "resources", "native-binary", "claude.exe");
      if (fs.existsSync(f)) return f;
    }
  } catch (e) { /* 見つからなければ PATH の claude */ }
  return "claude";
}

// 薬・部位の一覧（スマホで追加・修正したものが送られてきたらそれを使う。なければ初期データ）
function vocab(own) {
  const srcDrugs = own && Array.isArray(own.drugs) && own.drugs.length ? own.drugs : D.drugs;
  const srcSites = own && Array.isArray(own.sites) && own.sites.length ? own.sites : D.sites;
  const str = x => String(x || "").slice(0, 60);
  const drugs = srcDrugs.filter(d => d && (d.adopted || d.common)).slice(0, 400).map(d => `${str(d.name).replace(/（混合軟膏）$/, "")}${d.aliases && d.aliases.length ? "（" + d.aliases.map(str).filter(a => !/^[ぁ-ん]+$/.test(a)).slice(0, 5).join("・") + "）" : ""}`);
  // 部位は label が正式な書き方。カルテはカタカナで書くので、カタカナの書き方を（）で添える
  const sites = srcSites.filter(s => s && s.label).slice(0, 300).map(s => { const k = (s.aliases || []).map(str).filter(a => /^[ァ-ヶー・]+$/.test(a)); return str(s.label) + (k.length ? "（" + k.join("・") + "）" : ""); });
  const sets = (D.sets || []).map(s => s.name || s);
  return { drugs, sites, sets };
}

function prompt(own) {
  const v = vocab(own);
  return `皮膚科の手書きカルテの「処方」欄の画像です（処方以外の部分は白く消してあります）。${TWO_STEP ? `書かれている処方を読み取って、次の2つだけを出力してください（説明や前置きは書かない）。
【読み】 カルテに書いてあるとおりに（略記・カタカナ・数字のまま）1行ずつ書き写す
【処方】 【読み】を下の形式に直したもの（1薬1行）

【処方】の形式:` : `書かれている処方を読み取って、下の形式で1薬1行で出力してください。考えたことや説明は書きません。1行目に「【処方】」とだけ書き、その下に処方の行だけを書きます。

出力の形式（〈 〉は画像から読んだものに置き換える。〈 〉は付けない）:`}
〈薬の正式名〉 〈本数〉本 (〈部位〉)
〈薬の正式名〉 〈g数〉g×〈個数〉 (〈部位〉) 〈回数の指示〉
〈混合軟膏の略名〉 -〈容器の番号〉×〈個数〉 (〈部位〉)
〈薬の正式名〉 〈1日量〉T 〈用法〉 〈日数〉TD
〈セット名〉 〈用法〉 〈日数〉TD

ルール:
- 薬の名前は、その行の先頭に書かれた薬の略記を1文字ずつ読んで決め、下の「薬の一覧」の正式名にそろえる（カルテは略記: ヘパlo、GMo、クリーゲル、ダーTlo、クロ(P)lo など。一覧の（）の中が略記）。数量や部位から薬を推測しない。一覧にない薬はカルテの書き方のまま。
- 外用の数量は「2本」「50g×3」。混合軟膏（サヘパ・ベタヘパ・ロヘパ・クロヘパ・サZ・ベZ・ロZ・クロZ）は「サヘパ -3」「ベタヘパ -2×2」のように書く（-数字は容器の番号、×は個数）。
- 用法（2×N・1×タ など）と日数（14TD など）が書いてある行は、のみ薬（錠剤・カプセル）。1日量は 2T・1C のように書く。
- 部位は括弧の中に、カタカナ・ひらがな・漢字をまぜて書いてある（アタマ、カオ、カラダ、ウデ、クビ、からだ、うで、カオホシツ など）。部位は、ほとんどが下の「部位の一覧」のどれか（一覧にない新しい部位は数％だけ）。次の順で決める。
  1. 括弧の中を1文字ずつ読む。
  2. 読めた字を「部位の一覧」と照らし、当てはまるものを一覧の表記で書く（カオ→顔、カラダ→からだ、カオホシツ→顔保湿）。読めない字があっても、読めた部分から当てはまるものを選ぶ（例: 「下〇」なら下肢。「体〇〇〇ところ」なら 体かゆいところ・体わるいところ のうち字の形と字数が合うほう）。
  3. 読めない字を推測で補ったときは、部位の後ろに ? を付ける（例: (〈部位〉?)）。はっきり読めたときは付けない。
  4. 一覧のどれとも合わない言葉や、一覧の言葉に別の言葉が付け足されているとき（左右・場所・症状などが付いたもの）は、新しい部位なので、一覧の言葉に置き換えず読んだとおりに書く。
  括弧のすぐ後ろに続けて書いた言葉も部位に含める（(〈部位〉) 〈言葉〉 → (〈部位〉〈言葉〉)）。上と同じの「〃」はそのまま (〃)。部位が書いていなければ括弧ごと省く。
- 回数の指示（1日1→日1、1日2→日2、夜1、1日数回→日数）が書いてあれば最後に付ける。書いていなければ付けない。
- 内服は「1日量 用法 日数」（2T 2×N 14TD、1T 1×タ 28TD、1C 1×朝 14TD など）。
- 内服の薬をいくつか括弧や線でまとめて、用法と日数を1つだけ書いてあるときは（同じ袋に入れる）、薬を1行ずつ1日量まで書き、その下に用法と日数を1行で書く（〈薬A〉 3T ／ 〈薬B〉 3T ／ 3×N 28TD の3行）。
- 「しみ3つ」などのセット名は「しみ3つ 3×N 60TD」のように書く。
- 「(S)」や「処置」の欄（B-1 など）は処置なので出力しない。検査の結果（KOH(−) など）や説明の文も出力しない。線で消された行も出力しない。日付・医師の印は出力しない。日付が写っていたら、いちばん下の日付より下の処方だけを出力する（上は前回の処方）。
- 読めない字も、一覧と皮膚科の処方として最もありそうなものを推測して必ず埋める。

部位の一覧: ${v.sites.join("、")}
セット: ${v.sets.join("、")}
薬の一覧: ${v.drugs.join("、")}`;
}

// 考える深さ。標準(xhigh)だと手書きで考え込み 1枚 60〜100秒かかる。
// サンプル35枚（Opus）: low 84%・約7秒 / medium 86%・約10秒（sonnet は medium でも 43%）
const EFFORT = process.env.CLAUDE_EFFORT || "low";
// 先に【読み】（カルテのまま書き写し）を出させてから【処方】（正式名に直したもの）を出させる方式
const TWO_STEP = process.env.CLAUDE_TWO_STEP === "1";   // 試した結果、精度は上がらなかった（標準は使わない）

// Claude を起動する（画像はまだ渡さない）。起動に 2秒ほどかかるので、次の1枚のぶんを先に起動して待たせておく
function start(model) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--tools", "", "--system-prompt", "あなたは手書きカルテの処方を正確に書き起こす薬剤師の助手です。",
    "--effort", EFFORT,
    // PC の Claude Code の設定・接続先（MCP）・コマンドは読み込まない（速くするため・画像をほかへ渡さないため）
    "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands"];
  if (model) args.push("--model", model);
  if (model === "opus") args.push("--fallback-model", "sonnet");   // Opus が混み合っているときだけ sonnet で読む
  // 有料の API キーが設定されていても使わない（サブスクリプションで動かす）
  const env = Object.assign({}, process.env);
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const c = { model, t: Date.now(), out: "", err: "", done: null, p: spawn(claudeExe(), args, { env, cwd: __dirname, windowsHide: true }) };
  c.closed = new Promise(res => {
    c.p.on("error", e => { c.done = { error: e }; res(); });
    c.p.on("close", code => { c.done = c.done || { code }; res(); });
  });
  c.p.stdout.on("data", d => c.out += d); c.p.stderr.on("data", d => c.err += d);
  c.p.stdin.on("error", () => {});   // 先に終わっていた場合（結果は close で扱う）
  return c;
}

let spare = null;
// 次の1枚のぶんを先に起動しておく（サーバーから呼ぶ）。古くなったものは 20分で起動し直す
function warm(model) {
  if (spare) { clearTimeout(spare.timer); spare.p.kill(); }
  spare = start(model);
  spare.timer = setTimeout(() => warm(model), 20 * 60000);
  spare.timer.unref();
}
function take(model) {
  const c = spare;
  if (c) { clearTimeout(c.timer); spare = null; warm(model); }
  if (c && !c.done && c.model === model) return c;
  if (c) c.p.kill();
  return start(model);
}

// 見本（このクリニックのカルテの処方欄 <名前>.jpg と、正しい読み取り <名前>.txt）を読み込む。フォルダがなければ見本なし
function loadExamples(dir) {
  dir = dir || path.join(__dirname, "examples");
  try {
    return fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f)).sort().map(f => {
      const t = path.join(dir, f.replace(/\.jpe?g$/i, ".txt"));
      return fs.existsSync(t) ? { name: f, buf: fs.readFileSync(path.join(dir, f)), text: fs.readFileSync(t, "utf8").trim() } : null;
    }).filter(e => e && e.text);
  } catch (e) { return []; }
}

const jpeg = buf => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });

// buf: JPEG の中身。examples: このクリニックのカルテの見本 [{ buf, text }]（字のくせを覚えさせる）。
// own: スマホの薬・部位の一覧 { drugs, sites }（なければ初期データ）。戻り値 { text, ms, outTok }
function readImage(buf, model, timeoutMs, examples, own) {
  const c = take(model);
  return new Promise((resolve, reject) => {
    const content = [];
    if (examples && examples.length) {
      content.push({ type: "text", text: `まず、このクリニックの医師の字のくせを覚えてください。次の${examples.length}枚は、同じクリニックのカルテの処方欄と、その正しい読み取りです（同じ言葉は同じように崩して書かれます）。` });
      examples.forEach((e, i) => { content.push(jpeg(e.buf), { type: "text", text: `見本${i + 1}の正しい読み取り:\n${e.text}` }); });
      content.push({ type: "text", text: "ここからが読み取る画像です。見本の字のくせを参考に読んでください。" });
    }
    content.push(jpeg(buf), { type: "text", text: prompt(own) });
    const msg = { type: "user", message: { role: "user", content } };
    const t0 = Date.now();
    const timer = setTimeout(() => { c.p.kill(); reject(new Error("時間がかかりすぎたので中止しました")); }, timeoutMs || 180000);
    c.closed.then(() => {
      clearTimeout(timer);
      if (c.done.error) return reject(c.done.error);
      const ev = c.out.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const res = ev.find(e => e.type === "result");
      if (!res || res.is_error) return reject(new Error(res ? String(res.result || "読み取りに失敗しました").slice(0, 200) : `Claude を起動できませんでした（${c.done.code}）${c.err.slice(0, 200)}`));
      let text = String(res.result || "");
      const k = text.lastIndexOf("【処方】");
      if (k >= 0) text = text.slice(k + 4);
      resolve({ text: text.trim(), ms: Date.now() - t0, outTok: res.usage && res.usage.output_tokens });
    });
    c.p.stdin.write(JSON.stringify(msg) + "\n"); c.p.stdin.end();
  });
}
module.exports = { readImage, warm, prompt, claudeExe, loadExamples, EFFORT };
