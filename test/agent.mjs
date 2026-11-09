#!/usr/bin/env node
/**
 * The real Linux agent the tests run against. The agents are released from
 * SplendidChip758/llama-paddock-agent, so the tests use the release named in test/agent-release,
 * downloaded once into test/.agent/<tag>/ (from the repository at that tag, like install/agent.sh)
 * and checked against that release's SHA256SUMS.
 * PADDOCK_AGENT_SRC=<a clone of llama-paddock-agent> uses its linux/paddock-agent.mjs instead,
 * to test an agent change against this dashboard.
 *
 *   node test/agent.mjs      download the pinned release if it isn't there yet, and print its path
 *
 * Plain Node, no dependencies, like the simulator that reads it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = "SplendidChip758/llama-paddock-agent";

/** The release tag the tests pin, e.g. v0.10.0. */
export function agentRelease() {
  return fs.readFileSync(path.join(HERE, "agent-release"), "utf8").trim();
}

/** Where the agent's source is, whether or not it has been downloaded yet. */
export function agentPath() {
  const src = process.env.PADDOCK_AGENT_SRC;
  if (src) return path.resolve(src, "linux/paddock-agent.mjs");
  return path.join(HERE, ".agent", agentRelease(), "paddock-agent.mjs");
}

/** The agent's source, or null when it hasn't been downloaded (the simulator then uses its defaults). */
export function agentSource() {
  try {
    return fs.readFileSync(agentPath(), "utf8");
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries for GitHub's intermittent 5xx; null on a 404. */
async function download(url, headers = {}) {
  let last;
  for (const delay of [2000, 5000, 0]) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: e.message }));
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    if (r.status === 404) return null;
    last = r.status;
    await sleep(delay);
  }
  throw new Error(`${url}: ${last}`);
}

/** A release file through the API, for when release downloads answer 504; uses GITHUB_TOKEN when set (CI). */
async function apiAsset(tag, name) {
  const auth = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const rel = await download(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { ...auth, Accept: "application/vnd.github+json" });
  const id = rel && JSON.parse(rel.toString()).assets?.find((a) => a.name === name)?.id;
  if (!id) throw new Error(`${tag} has no ${name}`);
  return download(`https://api.github.com/repos/${REPO}/releases/assets/${id}`, { ...auth, Accept: "application/octet-stream" });
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * Download the pinned release's Linux agent unless it's there already; return its path. Like
 * install/agent.sh: the agent from the repository at the release's tag, checked against the
 * release's SHA256SUMS, else the release's own file. (Releases from 0.10.0 on ship it in a
 * tarball, which SHA256SUMS lists the files of; up to 0.10.0-dev.2 as paddock-agent-linux.mjs.)
 */
export async function fetchAgent() {
  const file = agentPath();
  if (process.env.PADDOCK_AGENT_SRC) {
    if (!fs.existsSync(file)) throw new Error(`PADDOCK_AGENT_SRC has no linux/paddock-agent.mjs (${file})`);
    return file;
  }
  if (fs.existsSync(file)) return file;
  const tag = agentRelease();
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const sums = (await download(`${base}/SHA256SUMS`).catch(() => apiAsset(tag, "SHA256SUMS")))?.toString();
  if (!sums) throw new Error(`${tag} has no SHA256SUMS`);
  const listed = (name) => new RegExp(`^([0-9a-f]{64}) +\\*?${name.replace(/[.]/g, "\\.")}$`, "m").exec(sums)?.[1];
  const want = listed("llama-paddock-agent/paddock-agent.mjs") ?? listed("paddock-agent-linux.mjs");
  if (!want) throw new Error(`${tag}'s SHA256SUMS doesn't list the agent`);
  let agent = await download(`https://raw.githubusercontent.com/${REPO}/${tag}/linux/paddock-agent.mjs`).catch(() => null);
  if (!agent || sha256(agent) !== want) {
    if (!listed("paddock-agent-linux.mjs")) throw new Error(`the agent at ${tag} didn't download or doesn't match its SHA256SUMS`);
    agent = await download(`${base}/paddock-agent-linux.mjs`).catch(() => apiAsset(tag, "paddock-agent-linux.mjs"));
  }
  if (!agent || sha256(agent) !== want) throw new Error(`the agent from ${tag} doesn't match its SHA256SUMS`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, agent);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchAgent().then(
    (file) => console.log(`agent: ${path.relative(process.cwd(), file)}`),
    (e) => {
      console.error(`could not get the agent for the tests: ${e.message}`);
      process.exit(1);
    },
  );
}
