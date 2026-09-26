// 一度読み込んだら電波がなくても使えるように、アプリのファイルを端末に保存する
const CACHE = "yakutai-2026-09-26-2";
const FILES = [
  "./", "index.html", "css/app.css", "manifest.webmanifest",
  "js/data.js", "js/render.js", "js/parser.js", "js/reader.js", "js/store.js", "js/ocr.js", "js/pdf.js", "js/app.js",
  "lib/ort.wasm.min.js", "lib/ort-wasm-simd-threaded.mjs", "lib/ort-wasm-simd-threaded.wasm",
  "lib/pdf-lib.min.js", "lib/fontkit.umd.min.js",
  "models/det.onnx", "models/rec.onnx", "models/rec_dict.txt", "models/recj.onnx", "models/recj_dict.txt", "models/ndl.onnx", "models/ndl_chars.json",
  "fonts/BIZUDGothic-Bold-jis.ttf",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
