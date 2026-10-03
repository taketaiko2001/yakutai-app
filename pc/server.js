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
// 市原さんの指示で、アプリを更新しても必ずこの仕組みを残す。
// Windows の SetThreadExecutionState（ES_CONTINUOUS | ES_SYSTEM_REQUIRED）を呼んだ PowerShell を裏で動かしておき、
// サーバーが終わったら（画面を閉じたときも、20秒ごとに確かめて）その PowerShell も終わる。
// 効いたかどうかは PowerShell から返事（OK / NG）をもらって表示し、PowerShell が途中で終わってしまったら立ち上げ直す
const ES_KEEP = 2147483649;   // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
let awakeOk = null;           // 最後に確かめた結果（null: まだ / true / false）
function keepAwake() {
  if (process.platform !== "win32") return;
  const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'
if ([W.P]::SetThreadExecutionState([uint32]${ES_KEEP}) -ne 0) { 'OK' } else { 'NG' }
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20; [void][W.P]::SetThreadExecutionState([uint32]${ES_KEEP}) }`;
  let ending = false;
  const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const report = ok => {
    if (ok === awakeOk) return;   // 同じ知らせはくり返さない
    awakeOk = ok;
    console.log(ok ? "この画面が開いている間は、PCがスリープしないようにしています（閉じれば元どおり）。"
      : "⚠ PCのスリープを止める設定ができませんでした。しばらく使わないと、PCがスリープすることがあります（1分ごとにやり直します）。");
  };
  c.stdout.on("data", d => report(/OK/.test(String(d))));
  c.on("error", () => report(false));
  const stop = () => { ending = true; try { c.kill(); } catch (e) { /* もう終わっている */ } };
  process.on("exit", stop);
  c.on("exit", () => {
    process.removeListener("exit", stop);
    if (ending) return;
    // 途中で終わってしまった（誰かが止めた・PowerShell が落ちた）ので立ち上げ直す。うまくいかなかったときは1分おきにやり直す
    const wait = awakeOk === false ? 60000 : 3000;
    if (awakeOk) { console.log("（PCのスリープを止める見張り役が止まったので、立ち上げ直します）"); awakeOk = null; }
    setTimeout(keepAwake, wait);
  });
}

// スマホで開く QR コードを PC の画面（ブラウザ）に出す。起動のたびに、この PC の今のアドレスで作り直す（アドレスが変わっても開けるように）。
// QR コードは pc/make_qr.py（Python）で作る。作り直せなかったときは前に作ったものを出す。
// 写真アプリで開くと画像ファイルをつかんだままになり、次に起動したとき作り直せないので、ブラウザ（/qr）で見せる
const QR_PNG = path.join(__dirname, "..", "0_スマホで開くQRコード.png");
const QR_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>薬袋プリント QRコード</title>
<style>body{margin:16px;text-align:center;font-family:"BIZ UDGothic",Meiryo,sans-serif;background:#fff;color:#111}
img{max-width:95vw;max-height:80vh}p{font-size:20px;margin:10px}#st{font-weight:bold}.ok{color:#11772d}.ng{color:#c00}</style></head>
<body><img src="/qr.png?t=${Date.now()}" alt="スマホで開くQRコード">
<p id="st"></p><p>このページは閉じてもかまいません。<b>黒い画面（薬袋プリント）は閉じないでください。</b></p>
<script>const st=document.getElementById("st");
async function check(){try{const r=await fetch("/api/ping",{cache:"no-store"});if(!(await r.json()).ok)throw 0;st.className="ok";st.textContent="● PCの準備ができています（スマホからこのQRコードを読み取れます）";}
catch(e){st.className="ng";st.textContent="✕ PCのサーバーが止まっています。「00_薬袋プリント」の「薬袋プリントを起動.bat」をダブルクリックしてください";}}
check();setInterval(check,5000);</script></body></html>`;
function showQR(remake) {
  let shown = false;
  const open = () => {
    if (shown) return; shown = true;
    if (!fs.existsSync(QR_PNG)) return console.log("（QRコードを作れませんでした。上のアドレスをスマホで開いてください）");
    spawn("explorer.exe", [`http://127.0.0.1:${PORT}/qr`], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
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
  // PC の画面に出す QR コード（この PC からだけ）
  if (url.pathname === "/qr" || url.pathname === "/qr.png") {
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress)) { res.writeHead(404); return res.end(); }
    if (url.pathname === "/qr") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(QR_PAGE); }
    return fs.readFile(QR_PNG, (e, b) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); res.end(b);
    });
  }
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
  keepAwake();
  showQR(true);
  warm(MODEL);
});
