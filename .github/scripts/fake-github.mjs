// GitHub as the installer and the dashboard see it, for installer-update-test.sh: the releases API
// (PADDOCK_GITHUB_API, and agent_releases_url in config.yaml), the release downloads, and the
// installer script (PADDOCK_SELF_URL).
//   node fake-github.mjs <address> <port> <releases folder> <script>
// It listens on <address> only: Docker's bridge address, where the test's container reaches it.
// <releases folder>/<tag>/ holds each release's assets; a tag with a "-" is a prerelease. Folders
// are read on every request, so the test publishes and withdraws releases while this runs.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [host, port, root, script] = [process.argv[2], Number(process.argv[3]), path.resolve(process.argv[4]), path.resolve(process.argv[5])];
const base = `http://${host}:${port}`;

const ver = (t) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(t);
  return m ? [+m[1], +m[2], +m[3], m[4] ?? null] : null;
};
const newest = (a, b) => {
  const x = ver(a.tag_name), y = ver(b.tag_name);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return (x[3] ? 1 : 0) - (y[3] ? 1 : 0);
};

function release(tag) {
  const dir = path.join(root, tag);
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-"),
    body: `Release ${tag}, published for the installer update test.`,
    html_url: `${base}/releases/tag/${tag}`,
    published_at: fs.statSync(dir).mtime.toISOString(),
    assets: fs.readdirSync(dir).map((name) => ({ name, browser_download_url: `${base}/download/${tag}/${name}` })),
  };
}

const releases = () =>
  fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && ver(d.name)).map((d) => release(d.name)).sort(newest);

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

http.createServer((req, res) => {
  const url = new URL(req.url, base);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`);
  let m;
  if (url.pathname === "/dashboard.sh") return send(res, 200, fs.readFileSync(script), "text/plain");
  if ((m = /^\/repos\/[^/]+\/[^/]+\/releases$/.exec(url.pathname))) return send(res, 200, releases());
  if ((m = /^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.exec(url.pathname))) {
    const stable = releases().find((r) => !r.prerelease);
    return stable ? send(res, 200, stable) : send(res, 404, { message: "Not Found" });
  }
  if ((m = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/.exec(url.pathname))) {
    return fs.existsSync(path.join(root, m[1])) ? send(res, 200, release(m[1])) : send(res, 404, { message: "Not Found" });
  }
  if ((m = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
    const file = path.join(root, m[1], m[2]);
    if (path.dirname(path.dirname(file)) === root && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), "application/octet-stream");
  }
  send(res, 404, { message: "Not Found" });
}).listen(port, host, () => console.log(`fake GitHub on ${base}, releases from ${root}`));
