// New models (#29): create one from a model on the host, from a library model pulled first, or from
// a GGUF file uploaded in chunks through the dashboard, with parameters, system prompt and template.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

before(async () => {
  stack = holder.stack = await startStack({
    sim: { hosts: 1, gpus: "1", pullSeconds: 1 },
    data: (s) => ({ extra: `model_registry_url: ${s.control}/registry\nmodel_library_url: ${s.control}/ollama.com` }),
  });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok && x.stats, "online");
});
after(() => holder.stack?.stop());

const models = async () => (await c.get("/api/instances/sim-1/models")).data.models;
const job = (id) => waitFor(async () => {
  const j = (await c.get("/api/jobs")).data.jobs.find((x) => x.id === id);
  return j && j.state !== "running" && j;
}, { what: `job ${id} to finish` });

async function create(body) {
  const r = await c.post("/api/instances/sim-1/models/create", body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return job(r.data.id);
}

/** A small GGUF file: a llama header with 32 layers and 8 KV heads, then `extra` bytes standing in for the weights. */
function gguf(extra) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s); u64(b.length); parts.push(b); };
  const kv = [["general.architecture", "llama"], ["general.name", "Test Model"], ["llama.context_length", 8192], ["llama.block_count", 32],
    ["llama.embedding_length", 4096], ["llama.attention.head_count", 32], ["llama.attention.head_count_kv", 8], ["llama.vocab_size", 32000]];
  parts.push(Buffer.from("GGUF"));
  u32(3);
  u64(0);
  u64(kv.length);
  for (const [k, v] of kv) {
    str(k);
    if (typeof v === "string") {
      u32(8);
      str(v);
    } else {
      u32(4);
      u32(v);
    }
  }
  parts.push(crypto.randomBytes(extra));
  return Buffer.concat(parts);
}

const put = (id, offset, body, type = "application/octet-stream") => fetch(`${c.url}/api/instances/sim-1/models/upload/${id}?offset=${offset}`, {
  method: "PUT", headers: { Cookie: c.cookie, "Content-Type": type }, body,
});

/** Upload a file the way the editor does; returns the finish response. */
async function upload(file, filename = "Test-Model.Q4_K_M.gguf") {
  const start = await c.post("/api/instances/sim-1/models/upload", { filename, size: file.length });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const { id, chunk_size } = start.data;
  for (let off = 0; off < file.length; off += chunk_size) {
    const r = await put(id, off, file.subarray(off, off + chunk_size));
    assert.equal(r.status, 200, await r.text());
  }
  return c.post(`/api/instances/sim-1/models/upload/${id}`, {});
}

test("a new model from one on the host gets its own parameters, system prompt and template", async () => {
  const j = await create({
    model: "llama3.2:3b-coder", from: "llama3.2:3b", parameters: { temperature: 0.2, stop: ["<|end|>"] },
    system: "You write code.", template: "{{ .System }} | {{ .Prompt }}",
  });
  assert.equal(j.state, "done", j.error);
  const show = await c.post("/api/instances/sim-1/models/show", { model: "llama3.2:3b-coder" });
  assert.equal(show.status, 200);
  assert.equal(show.data.system, "You write code.");
  assert.equal(show.data.template, "{{ .System }} | {{ .Prompt }}");
  assert.equal(show.data.parameters.temperature, 0.2);
  assert.deepEqual(show.data.parameters.stop, ["<|end|>"]);
});

test("a library base that isn't on the host is pulled first, as one job", async () => {
  assert.ok(!(await models()).some((m) => m.name === "phi4:14b"));
  const j = await create({ model: "phi4-chat", from: "phi4:14b", pull: true, parameters: { num_ctx: 8192 } });
  assert.equal(j.state, "done", j.error);
  assert.equal(j.kind, "create");
  assert.match(j.detail, /^pull phi4:14b, then from phi4:14b/);
  const names = (await models()).map((m) => m.name);
  assert.ok(names.includes("phi4:14b") && names.includes("phi4-chat:latest"), names.join(", "));

  // without pull, a missing base fails as before
  const missing = await create({ model: "nope", from: "gemma3:27b" });
  assert.equal(missing.state, "error");
  assert.match(missing.error, /not found/);
});

test("a GGUF file uploads in chunks, reaches Ollama, and its header gives the fit estimate", async () => {
  // a little over two chunks
  const file = gguf(17 * 1024 * 1024);
  const r = await upload(file);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const digest = `sha256:${crypto.createHash("sha256").update(file).digest("hex")}`;
  assert.equal(r.data.digest, digest);
  assert.equal(r.data.size, file.length);
  assert.equal(r.data.architecture, "llama");
  assert.equal(r.data.name, "Test Model");
  assert.equal(r.data.context_length, 8192);
  assert.equal(r.data.filename, "Test-Model.Q4_K_M.gguf");

  const head = await fetch(`${sim.host("sim-1").ollama_url}/api/blobs/${digest}`, { method: "HEAD" });
  assert.equal(head.status, 200, "Ollama has the blob");
  // the dashboard keeps no copy
  assert.deepEqual(fs.readdirSync(path.join(stack.data.data, "uploads")), []);

  const fit = await c.post("/api/instances/sim-1/models/fit", { blob: digest, num_ctx: 4096 });
  assert.equal(fit.status, 200, JSON.stringify(fit.data));
  assert.equal(fit.data.source, "upload");
  assert.equal(fit.data.model.weights, file.length);
  assert.equal(fit.data.model.max_context, 8192);
  assert.equal(fit.data.estimates[0].kv, 4096 * 128 * 1024);

  const j = await create({ model: "test-model:q4", blob: digest, template: "{{ .Prompt }}", parameters: { temperature: 0.7 } });
  assert.equal(j.state, "done", j.error);
  const created = (await models()).find((m) => m.name === "test-model:q4");
  assert.equal(created?.size, file.length);

  const audit = (await c.get("/api/audit?action=model.upload")).data;
  assert.ok(JSON.stringify(audit).includes("Test-Model.Q4_K_M.gguf"), JSON.stringify(audit).slice(0, 500));
});

test("uploads refuse what isn't a GGUF, chunks out of order and early finishes", async () => {
  assert.equal((await c.post("/api/instances/sim-1/models/upload", { filename: "notes.txt", size: 100 })).status, 400);
  assert.equal((await c.post("/api/instances/sim-1/models/upload", { filename: "x.gguf", size: "big" })).status, 400);

  const notGguf = await c.post("/api/instances/sim-1/models/upload", { filename: "fake.gguf", size: 64 });
  const bad = await put(notGguf.data.id, 0, Buffer.alloc(64, 1));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).detail, /not a GGUF/);
  // a refused first chunk drops the upload
  assert.equal((await put(notGguf.data.id, 0, gguf(0))).status, 404);

  const file = gguf(1000);
  const { data: { id } } = await c.post("/api/instances/sim-1/models/upload", { filename: "ok.gguf", size: file.length });
  assert.equal((await put(id, 10, file.subarray(10))).status, 409, "a chunk at the wrong offset");
  assert.equal((await put(id, 0, file, "text/plain")).status, 415);
  assert.equal((await put(id, 0, file.subarray(0, 100))).status, 200);
  const early = await c.post(`/api/instances/sim-1/models/upload/${id}`, {});
  assert.equal(early.status, 409, JSON.stringify(early.data));
  assert.equal((await c.del(`/api/instances/sim-1/models/upload/${id}`)).status, 200);
  assert.equal((await c.post(`/api/instances/sim-1/models/upload/${id}`, {})).status, 404);

  const r = await c.post("/api/instances/sim-1/models/create", { model: "x", blob: "sha256:nothex" });
  assert.equal(r.status, 400);
  const both = await c.post("/api/instances/sim-1/models/create", { model: "x", from: "llama3.2:3b", blob: `sha256:${"a".repeat(64)}` });
  assert.equal(both.status, 400);
});
