// 薬袋プリント：PC で読むためのサーバー（院内の Wi-Fi の中だけで使う）
//  ・スマホに アプリ（docs）を配る:  http://<このPCのアドレス>:8787/
//  ・/api/read  スマホから「処方の部分だけ」の画像（と、スマホの薬・部位の一覧）を受け取り、Claude に読ませて結果を返す
//    画像はファイルに保存しない。読み取った内容も記録しない（時刻と秒数だけ表示）
//  ・pc/examples/ に置いた見本（このクリニックのカルテの処方欄と正しい読み取り）を毎回いっしょに渡し、医師の字のくせを覚えさせる
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os"), { spawn } = require("child_process");
const { readImage, warm, claudeExe, loadExamples, EFFORT } = require("./claude_read.js");

const PORT = +process.env.PORT || 8787;
// 手書きの読み取りは Opus が大きく上回る（サンプル35枚で sonnet 43% / Opus 84%）
const MODEL = process.env.CLAUDE_MODEL || "opus";
const ROOT = path.join(__dirname, "..", "docs");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8", ".ttf": "font/ttf" };

// 院内のネットワーク（192.168.x.x / 10.x / 172.16-31.x）とこのPCからだけ受け付ける
function isLocal(ip) {
  ip = String(ip || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// このPCが放置でスリープすると、スマホから送った写真が届かず、読み取りが止まったように見える。
// この画面（サーバー）が開いている間だけ、PCがスリープしないようにする（画面の消灯はそのまま。この画面を閉じれば元の設定どおり）。
// Windows の SetThreadExecutionState（ES_CONTINUOUS | ES_SYSTEM_REQUIRED）を呼んだ PowerShell を裏で動かしておき、
// サーバーが終わったら（画面を閉じたときも、20秒ごとに確かめて）その PowerShell も終わる
function keepAwake() {
  if (process.platform !== "win32") return false;
  const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'
[void][W.P]::SetThreadExecutionState([uint32]2147483649)
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`;
  const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
  c.on("error", () => {});
  process.on("exit", () => { try { c.kill(); } catch (e) { /* もう終わっている */ } });
  return true;
}

// スマホで開く QR コードを PC の画面に出す。起動のたびに、この PC の今のアドレスで作り直す（アドレスが変わっても開けるように）。
// QR コードは pc/make_qr.py（Python）で作る。作り直せなかったときは前に作ったものを出す
const QR_PNG = path.join(__dirname, "..", "0_スマホで開くQRコード.png");
function showQR(remake) {
  let shown = false;
  const open = () => {
    if (shown) return; shown = true;
    if (!fs.existsSync(QR_PNG)) return console.log("（QRコードを作れませんでした。上のアドレスをスマホで開いてください）");
    spawn("explorer.exe", [QR_PNG], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  };
  if (!remake) return open();
  const py = spawn("python", [path.join(__dirname, "make_qr.py")], { env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, stdio: "ignore" });
  py.on("error", open);   // Python が見つからない
  py.on("close", code => { if (code) console.log("（QRコードを作り直せなかったので、前に作ったものを表示します）"); open(); });
}

let queue = Promise.resolve();   // 1枚ずつ順に読む
// まれに考えすぎて1分以上かかることがあるので、この秒数たっても終わらなければ、もう1つ同じ読み取りを始めて早いほうを使う
const HEDGE_MS = 20000;
// 一時的に失敗することがあるので、1回だけ読み直す
function readQueued(buf, own) {
  const ex = loadExamples();   // 見本は読むたびに読み込む（入れ替えても再起動いらず）
  const p = queue.then(() => readImage(buf, MODEL, 0, ex, own, HEDGE_MS).catch(() => readImage(buf, MODEL, 0, ex, own, HEDGE_MS)));
  queue = p.catch(() => {}); return p;
}

const server = http.createServer((req, res) => {
  if (!isLocal(req.socket.remoteAddress)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/ping") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, model: MODEL })); }
  if (url.pathname === "/api/read" && req.method === "POST") {
    const chunks = []; let size = 0, over = false;
    req.on("data", c => { size += c.length; if (size > 8e6) { over = true; req.destroy(); } else chunks.push(c); });
    req.on("end", async () => {
      if (over) return;
      let buf = Buffer.concat(chunks), own = null;
      chunks.length = 0;
      // 新しいスマホ画面は JSON（画像＋薬・部位の一覧）で送る。古い画面は JPEG だけ
      if (/json/.test(req.headers["content-type"] || "")) {
        try {
          const j = JSON.parse(buf.toString("utf8"));
          buf = Buffer.from(String(j.image || "").replace(/^data:image\/\w+;base64,/, ""), "base64");
          own = { drugs: j.drugs, sites: j.sites };
        } catch (e) { res.writeHead(400); return res.end(); }
      }
      const t = new Date().toLocaleTimeString("ja-JP");
      try {
        const r = await readQueued(buf, own);
        console.log(`${t} 読み取り ${(r.ms / 1000).toFixed(1)}秒（出力 ${r.outTok} トークン${r.hedged ? "・時間がかかったので2つ目で読み直し" : ""}）`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text: r.text, ms: r.ms, model: MODEL }));
      } catch (e) {
        console.log(`${t} 読み取りできませんでした: ${e.message}`);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // アプリのファイル
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(302, { Location: "/" }); return res.end(); }
    const ext = path.extname(f).toLowerCase();
    const big = /^\/(models|lib|fonts|icons)\//.test(p);
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": big ? "max-age=604800" : "no-cache" });
    fs.createReadStream(f).pipe(res);
  });
});

// もう1つ起動していたとき（bat を2回ダブルクリックしたときなど）は、動いているほうをそのまま使い、QR コードだけ出して閉じる
server.on("error", e => {
  if (e.code !== "EADDRINUSE") throw e;
  let done = false;
  const answer = ok => {
    if (done) return; done = true;
    if (ok) {
      console.log("薬袋プリントは、もう起動しています（ほかの黒い画面で動いています）。そのまま使えます。");
      console.log("スマホで開くQRコードを表示します。この画面は15秒後に自動で閉じます。");
      showQR(false);
      setTimeout(() => process.exit(0), 15000);
    } else {
      console.log(`起動できませんでした（${PORT}番の接続口を、ほかのソフトが使っています）。`);
      console.log("前に開いた薬袋プリントの黒い画面が残っていたら閉じてから、もう一度ダブルクリックしてください。それでもだめなときは、PCを再起動してください。");
      process.exitCode = 1;
    }
  };
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/ping", timeout: 4000 }, r => {
    let body = ""; r.on("data", c => body += c);
    r.on("end", () => { let ok = false; try { ok = !!JSON.parse(body).ok; } catch (x) { /* 薬袋プリントではない */ } answer(ok); });
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => answer(false));
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address);
  console.log("薬袋プリント（PCで読む）を起動しました。");
  console.log("スマホで開くQRコードを、このあとPCの画面に出します。スマホのカメラで読み取ってください。");
  console.log("");
  console.log("★ この黒い画面を閉じると、スマホから使えなくなります。じゃまなときは右上の「ー」で小さくしてください。");
  console.log("");
  console.log("QRコードが読めないときは、スマホ（院内のWi-Fi）で次のアドレスを開いてください:");
  for (const ip of ips) console.log(`   http://${ip}:${PORT}/`);
  console.log(`読み取り: Claude（${MODEL}・effort ${EFFORT}）  ${claudeExe()}`);
  console.log(`見本: ${loadExamples().length}枚（pc/examples）`);
  if (keepAwake()) console.log("この画面が開いている間は、PCがスリープしないようにしています（閉じれば元どおり）。");
  showQR(true);
  warm(MODEL);
});
