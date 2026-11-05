// Test prompts (#17): the dashboard streams a chat from a host as it is generated, times the first
// token, and ends with Ollama's figures turned into rates. Errors before the answer starts are
// ordinary JSON errors.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1" } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok, "online");
  await c.waitInstance("sim-2", (x) => x.ollama_ok, "online");
});
after(() => holder.stack?.stop());

/** POST a chat and collect its events, with when each arrived. */
async function chat(host, body) {
  const r = await fetch(`${c.url}/api/instances/${host}/chat`, {
    method: "POST",
    // browsers ask for compression; the stream must still arrive as it is generated
    headers: { Cookie: c.cookie, "Content-Type": "application/json", "Accept-Encoding": "gzip, deflate, br" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { status: r.status, data: await r.json() };
  assert.match(r.headers.get("content-type"), /application\/x-ndjson/);
  const events = [];
  let buf = "";
  for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    for (let nl; (nl = buf.indexOf("\n")) >= 0; buf = buf.slice(nl + 1)) {
      if (buf.slice(0, nl).trim()) events.push({ at: performance.now(), ...JSON.parse(buf.slice(0, nl)) });
    }
  }
  return { status: r.status, events };
}

const ask = (host, model = "llama3.2:3b") => chat(host, { model, messages: [{ role: "user", content: "How fast are you?" }] });

test("a prompt streams its answer and ends with timings", async () => {
  const { status, events } = await ask("sim-1");
  assert.equal(status, 200);
  const tokens = events.filter((e) => e.type === "token");
  const done = events.at(-1);
  assert.equal(done.type, "done", JSON.stringify(events.at(-1)));
  assert.equal(tokens.map((e) => e.content).join(""), "This is a simulated response from llama-paddock's test host.");
  // the simulator sends a word every 20 ms: buffered output would arrive all at once
  assert.ok(tokens.at(-1).at - tokens[0].at > 80, `tokens arrived within ${tokens.at(-1).at - tokens[0].at} ms`);

  const s = done.stats;
  assert.equal(s.tokens, tokens.length);
  assert.ok(s.tps > 10 && s.tps < 100, `tps ${s.tps}`);
  assert.ok(s.prompt_tokens > 0 && s.prompt_tps > 0, JSON.stringify(s));
  assert.ok(s.ttft_ms > 0 && s.ttft_ms <= s.wall_ms, JSON.stringify(s));
  assert.ok(s.eval_ms > 0 && s.total_ms > 0 && s.load_ms != null, JSON.stringify(s));
  assert.equal(s.done_reason, "stop");
});

test("loading the model counts towards the first token", async () => {
  // sim-2 starts with nothing loaded, and a load takes 300 ms
  const cold = (await ask("sim-2", "qwen2.5-coder:7b")).events.at(-1).stats;
  const warm = (await ask("sim-2", "qwen2.5-coder:7b")).events.at(-1).stats;
  assert.ok(cold.load_ms >= 250, JSON.stringify(cold));
  assert.ok(cold.ttft_ms >= 250, JSON.stringify(cold));
  assert.ok(warm.load_ms < 50 && warm.ttft_ms < cold.ttft_ms, JSON.stringify({ cold, warm }));
});

test("hosts can be compared: the slower one has a lower rate", async () => {
  const [a, b] = await Promise.all([ask("sim-1"), ask("sim-2")]);
  const fast = a.events.at(-1).stats, slow = b.events.at(-1).stats;
  assert.ok(fast.tps > slow.tps, JSON.stringify({ fast: fast.tps, slow: slow.tps }));
});

test("errors before the answer starts are JSON errors", async () => {
  let r = await ask("sim-1", "no-such-model:1b");
  assert.equal(r.status, 404);
  assert.match(r.data.detail, /not found/);

  r = await chat("sim-1", { model: "llama3.2:3b", messages: [] });
  assert.equal(r.status, 400);
  r = await chat("sim-1", { model: "llama3.2:3b", messages: [{ role: "tool", content: "x" }] });
  assert.equal(r.status, 400);
  assert.match(r.data.detail, /role/);
  r = await chat("no-such-host", { model: "llama3.2:3b", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 404);
});

test("stopping a prompt stops the host generating", async () => {
  const ctl = new AbortController();
  const r = await fetch(`${c.url}/api/instances/sim-2/chat`, {
    method: "POST", signal: ctl.signal,
    headers: { Cookie: c.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama3.2:3b", messages: [{ role: "user", content: "Tell me a long story" }] }),
  });
  const reader = r.body.getReader();
  await reader.read();
  ctl.abort();
  await waitFor(async () => (await sim.state("sim-2")).answers_stopped === 1, { timeout: 5_000, what: "sim-2 stopped answering" });
});
