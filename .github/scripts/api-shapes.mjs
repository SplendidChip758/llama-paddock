// The /api compatibility check of installer-update-test.sh (#34): every GET endpoint docs/api.md
// documents is asked on the installed release, and the shape of each answer is recorded. After
// the update, the same endpoints, on the same data, must still answer with every field they had,
// of the same type. New endpoints and new fields are fine; a field that's gone, or changed type,
// is a break of the upgrade promise.
//   node api-shapes.mjs snapshot URL PASSWORD API_MD > shapes.json
//   node api-shapes.mjs compare URL PASSWORD API_MD shapes.json
import fs from "node:fs";

const [mode, url, password, apiMd, saved] = process.argv.slice(2);

async function login() {
  const r = await fetch(`${url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }),
  });
  if (!r.ok) throw new Error(`login: ${r.status} ${await r.text()}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** The documented GET paths, with {id} as the first host's id; a query in the docs is left out. */
async function endpoints(cookie) {
  const md = fs.readFileSync(apiMd, "utf8");
  const paths = [...md.matchAll(/^\| GET \| `(\/api\/[^`?]+)/gm)].map((m) => m[1]);
  const hosts = await (await fetch(`${url}/api/instances`, { headers: { cookie } })).json();
  const id = hosts.instances?.[0]?.id;
  return [...new Set(paths.map((p) => p.replace(/\{id\}/g, id ?? "{id}")).filter((p) => !/\{[^}]+\}|…/.test(p)))];
}

/** A value's shape: types instead of values, the first item of a list. */
function shape(v) {
  if (v === null) return null;
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

/** Where `now` lost something `before` had: missing fields, changed types. Null on either side is data, not a type. */
function breaks(before, now, at = "") {
  if (before === null || now === null) return [];
  if (Array.isArray(before)) {
    if (!Array.isArray(now)) return [`${at || "/"}: was a list, now ${JSON.stringify(now)}`];
    return before.length && now.length ? breaks(before[0], now[0], `${at}[0]`) : [];
  }
  if (typeof before === "object") {
    if (typeof now !== "object" || Array.isArray(now)) return [`${at || "/"}: was an object, now ${JSON.stringify(now)}`];
    return Object.keys(before).flatMap((k) => (k in now ? breaks(before[k], now[k], `${at}.${k}`) : [`${at}.${k}: gone`]));
  }
  return before === now ? [] : [`${at || "/"}: was ${before}, now ${now}`];
}

async function snapshot() {
  const cookie = await login();
  const out = {};
  for (const p of await endpoints(cookie)) {
    const r = await fetch(`${url}${p}`, { headers: { cookie } });
    // an endpoint this release doesn't have, or that needs a query, isn't part of what it promised
    if (r.ok && r.headers.get("content-type")?.includes("json")) out[p] = shape(await r.json());
  }
  return out;
}

if (mode === "snapshot") {
  console.log(JSON.stringify(await snapshot(), null, 1));
} else if (mode === "compare") {
  const before = JSON.parse(fs.readFileSync(saved, "utf8"));
  const cookie = await login();
  const found = [];
  for (const [p, s] of Object.entries(before)) {
    const r = await fetch(`${url}${p}`, { headers: { cookie } });
    if (!r.ok) found.push(`${p}: answered ${r.status}, 200 before the update`);
    else found.push(...breaks(s, shape(await r.json())).map((b) => `${p} ${b}`));
  }
  console.log(`compared ${Object.keys(before).length} endpoints`);
  for (const f of found) console.log(`  ${f}`);
  process.exit(found.length ? 1 : 0);
} else {
  console.error("usage: api-shapes.mjs snapshot|compare URL PASSWORD API_MD [shapes.json]");
  process.exit(2);
}
