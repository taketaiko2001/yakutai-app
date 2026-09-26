// 薬袋プリント：PC で読むためのサーバー（院内の Wi-Fi の中だけで使う）
//  ・スマホに アプリ（docs）を配る:  http://<このPCのアドレス>:8787/
//  ・/api/read  スマホから「処方の部分だけ」の画像を受け取り、Claude に読ませて結果を返す
//    画像はファイルに保存しない。読み取った内容も記録しない（時刻と秒数だけ表示）
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { readImage, claudeExe } = require("./claude_read.js");

const PORT = +process.env.PORT || 8787;
const MODEL = process.env.CLAUDE_MODEL || "sonnet";
const ROOT = path.join(__dirname, "..", "docs");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8", ".ttf": "font/ttf" };

// 院内のネットワーク（192.168.x.x / 10.x / 172.16-31.x）とこのPCからだけ受け付ける
function isLocal(ip) {
  ip = String(ip || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

let queue = Promise.resolve();   // 1枚ずつ順に読む
function readQueued(buf) { const p = queue.then(() => readImage(buf, MODEL)); queue = p.catch(() => {}); return p; }

const server = http.createServer((req, res) => {
  if (!isLocal(req.socket.remoteAddress)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/ping") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, model: MODEL })); }
  if (url.pathname === "/api/read" && req.method === "POST") {
    const chunks = []; let size = 0, over = false;
    req.on("data", c => { size += c.length; if (size > 8e6) { over = true; req.destroy(); } else chunks.push(c); });
    req.on("end", async () => {
      if (over) return;
      const buf = Buffer.concat(chunks);
      chunks.length = 0;
      const t = new Date().toLocaleTimeString("ja-JP");
      try {
        const r = await readQueued(buf);
        console.log(`${t} 読み取り ${(r.ms / 1000).toFixed(1)}秒`);
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

server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address);
  console.log("薬袋プリント（PCで読む）を起動しました。この画面は閉じないでください。");
  console.log("スマホ（院内のWi-Fi）で次のアドレスを開いてください:");
  for (const ip of ips) console.log(`   http://${ip}:${PORT}/`);
  console.log(`読み取り: Claude（${MODEL}）  ${claudeExe()}`);
});
