#!/usr/bin/env node
/**
 * The real Linux agent the tests run against. The agents are released from
 * SplendidChip758/llama-paddock-agent, so the tests use the release named in test/agent-release,
 * downloaded once into test/.agent/<tag>/ and checked against that release's SHA256SUMS.
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

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Download the pinned release's Linux agent unless it's there already; return its path. */
export async function fetchAgent() {
  const file = agentPath();
  if (process.env.PADDOCK_AGENT_SRC) {
    if (!fs.existsSync(file)) throw new Error(`PADDOCK_AGENT_SRC has no linux/paddock-agent.mjs (${file})`);
    return file;
  }
  if (fs.existsSync(file)) return file;
  const tag = agentRelease();
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const [sums, agent] = await Promise.all([download(`${base}/SHA256SUMS`), download(`${base}/paddock-agent-linux.mjs`)]);
  const want = /^([0-9a-f]{64}) +\*?paddock-agent-linux\.mjs$/m.exec(sums.toString())?.[1];
  const got = crypto.createHash("sha256").update(agent).digest("hex");
  if (!want) throw new Error(`${tag}'s SHA256SUMS doesn't list paddock-agent-linux.mjs`);
  if (want !== got) throw new Error(`paddock-agent-linux.mjs from ${tag} doesn't match its SHA256SUMS`);
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
