// 動作確認用の簡易サーバー: node scripts/serve.js
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, ".."), port = process.env.PORT || 8765;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (p.endsWith(path.sep) || p === root) p = path.join(p, "index.html");
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": (types[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" });
    res.end(buf);
  });
}).listen(port, () => console.log(`http://localhost:${port}`));
