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

function vocab() {
  const drugs = D.drugs.filter(d => d.adopted || d.common).map(d => `${d.name}${d.aliases && d.aliases.length ? "（" + d.aliases.filter(a => !/^[ぁ-ん]+$/.test(a)).slice(0, 5).join("・") + "）" : ""}`);
  const sites = D.sites.map(s => s.name || s);
  const sets = (D.sets || []).map(s => s.name || s);
  return { drugs, sites, sets };
}

function prompt() {
  const v = vocab();
  return `皮膚科の手書きカルテの「処方」欄の画像です（処方以外の部分は白く消してあります）。書かれている処方を読み取って、下の形式で1薬1行で出力してください。説明や前置きは書かず、処方の行だけを出力します。

出力の形式（例）:
ヘパリン類似物質ローション 2本 (顔保湿)
クリンダマイシンゲル 2本 (顔ニキビ) 日2
クレナフィン爪外用液 1本 (爪) 夜1
ヘパリン類似物質油性クリーム 4本 (〃)
サヘパ -3×2 (体・頭)
ヘパリン類似物質ローション 50g×3 (全身保湿)
しみ3つ 3×N 60TD
ロラタジン錠 1T 1×タ 28TD
ロキシスロマイシン錠 2T 2×N 14TD
（例の薬・数量・部位は書き方の見本で、画像の内容とは関係ありません）

ルール:
- 薬の名前は、その行の先頭に書かれた薬の略記を読んで決め、下の「薬の一覧」の正式名にそろえる（カルテは略記: ヘパlo、GMo、クリーゲル、ダーTlo、クロ(P)lo など。一覧の（）の中が略記）。数量や部位から薬を推測しない。一覧にない薬はカルテの書き方のまま。
- 外用の数量は「2本」「50g×3」、混合軟膏は「サヘパ -3」「ベタヘパ -2×2」（-数字は容器の番号、×は個数）。
- 部位は括弧の中を読み、下の「部位の一覧」から最も近いものを選んで、一覧の表記そのままで書く（カルテはカタカナ・ひらがな: カオホシツ＝顔保湿、カオニキビ＝顔ニキビ、アタマ＝頭、オヤユビ など）。上と同じの「〃」はそのまま (〃)。部位が書いていなければ括弧ごと省く。
- 回数の指示（1日1→日1、1日2→日2、夜1、1日数回→日数）が書いてあれば最後に付ける。書いていなければ付けない。
- 内服は「1日量 用法 日数」（例 2T 2×N 14TD、1T 1×タ 28TD、1T 1×朝 14TD）。
- 「しみ3つ」などのセット名は「しみ3つ 3×N 60TD」のように書く。
- 「(S)」や「処置」の欄（B-1 など）は処置なので出力しない。線で消された行も出力しない。日付・医師の印は出力しない。
- 読めない字も、一覧と皮膚科の処方として最もありそうなものを推測して必ず埋める。

部位の一覧: ${v.sites.join("、")}
セット: ${v.sets.join("、")}
薬の一覧: ${v.drugs.join("、")}`;
}

// 考える深さ。標準(xhigh)だと手書きで考え込み 1枚 60〜100秒かかる。
// high: 1枚 約5〜10秒（必要なときだけ少し考える） / medium: 少し速い
const EFFORT = process.env.CLAUDE_EFFORT || "high";

// Claude を起動する（画像はまだ渡さない）。起動に 2秒ほどかかるので、次の1枚のぶんを先に起動して待たせておく
function start(model) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--tools", "", "--system-prompt", "あなたは手書きカルテの処方を正確に書き起こす薬剤師の助手です。",
    "--effort", EFFORT,
    // PC の Claude Code の設定・接続先（MCP）・コマンドは読み込まない（速くするため・画像をほかへ渡さないため）
    "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands"];
  if (model) args.push("--model", model);
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

// buf: JPEG の中身。戻り値 { text, ms, outTok }
function readImage(buf, model, timeoutMs) {
  const c = take(model);
  return new Promise((resolve, reject) => {
    const msg = { type: "user", message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
      { type: "text", text: prompt() }] } };
    const t0 = Date.now();
    const timer = setTimeout(() => { c.p.kill(); reject(new Error("時間がかかりすぎたので中止しました")); }, timeoutMs || 180000);
    c.closed.then(() => {
      clearTimeout(timer);
      if (c.done.error) return reject(c.done.error);
      const ev = c.out.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const res = ev.find(e => e.type === "result");
      if (!res || res.is_error) return reject(new Error(res ? String(res.result || "読み取りに失敗しました").slice(0, 200) : `Claude を起動できませんでした（${c.done.code}）${c.err.slice(0, 200)}`));
      resolve({ text: String(res.result || "").trim(), ms: Date.now() - t0, outTok: res.usage && res.usage.output_tokens });
    });
    c.p.stdin.write(JSON.stringify(msg) + "\n"); c.p.stdin.end();
  });
}
module.exports = { readImage, warm, prompt, claudeExe, EFFORT };
