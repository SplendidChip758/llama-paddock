// Notification channels (#8): alerts that fire and resolve are sent to webhook, Discord, Slack and
// email channels, in order, to the channels each rule chooses; secrets never reach the browser;
// failed deliveries are retried or reported; and "Send test" works before a channel is saved.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack, smtp;

/** A tiny SMTP server that accepts every message, for the email channel. */
function startSmtpSink() {
  const messages = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    let buf = "", data = null, from = "", to = [];
    const say = (s) => sock.write(s + "\r\n");
    say("220 sink ESMTP");
    sock.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (data !== null) {
          if (line === ".") {
            const [head, body] = data.split("\n\n");
            messages.push({ from, to, head, text: Buffer.from(body.replace(/\n/g, ""), "base64").toString() });
            data = null;
            say("250 queued");
          } else data += line + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") say("250-sink\r\n250 8BITMIME");
        else if (cmd === "MAIL") (from = /<(.*)>/.exec(line)[1]), say("250 ok");
        else if (cmd === "RCPT") to.push(/<(.*)>/.exec(line)[1]), say("250 ok");
        else if (cmd === "DATA") (data = ""), say("354 go");
        else if (cmd === "QUIT") say("221 bye"), sock.end();
        else say("502 unknown");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port, messages, close: () => server.close(),
  })));
}

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1, gpus: "1" } });
  ({ client: c, sim } = stack);
  smtp = await startSmtpSink();
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => {
  smtp?.close();
  return holder.stack?.stop();
});

const hookUrl = (name) => `${sim.control}/webhook/${name}`;
const received = async (name) => (await (await fetch(hookUrl(name))).json()).received;
const failNext = (name, status, extra = {}) => fetch(`${hookUrl(name)}/fail`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, ...extra }),
});
const reset = (name) => fetch(hookUrl(name), { method: "DELETE" });
/** Wait until the receiver `name` has at least `n` messages. */
const waitReceived = (name, n, what) => {
  let seen;
  return waitFor(async () => {
    seen = await received(name);
    return seen.length >= n && seen;
  }, { timeout: 30_000, what: `${name}: ${what}`, describe: () => seen });
};
const gpuTemp = (v) => sim.scenario("sim-1", { gpu_temp: v });

const TOKEN = "hook-token-secret";
const channels = () => [
  { id: "hook", name: "Webhook", type: "webhook", url: hookUrl("hook"), token: TOKEN },
  { id: "discord", name: "Discord", type: "discord", url: hookUrl("discord") },
  { id: "slack", name: "Slack", type: "slack", url: hookUrl("slack"), send_resolved: false },
  { id: "mail", name: "Email", type: "email", email: { host: "127.0.0.1", port: smtp.port, security: "none", from: "paddock@example.com", to: ["ops@example.com"] } },
];
// a rule of its own for each test: one rule firing again and again would be marked flapping
const hotRule = (id, extra = {}) => ({ id, name: "GPU hot", kind: "gpu_temp", threshold: 80, for_s: 0, clear_s: 1, ...extra });

test("channels are saved with their secrets kept on the server", async () => {
  const empty = await c.get("/api/alerts/channels");
  assert.deepEqual(empty.data.channels, []);
  const put = await c.put("/api/alerts/channels", { channels: channels() });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const list = (await c.get("/api/alerts/channels")).data.channels;
  assert.deepEqual(list.map((x) => x.id), ["hook", "discord", "slack", "mail"]);
  const text = JSON.stringify(list);
  assert.equal(text.includes("/webhook/hook"), false, "webhook URLs never reach the browser");
  assert.equal(text.includes(TOKEN), false, "tokens never reach the browser");
  assert.equal(list[0].url_hint, new URL(hookUrl("hook")).origin + "/…");
  assert.equal(list[0].has_token, true);
  assert.equal(list[3].email.to[0], "ops@example.com");
  const file = path.join(stack.data.data, "alert-channels.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).channels[0].token, TOKEN);
});

test("invalid channels are refused and change nothing", async () => {
  const before = (await c.get("/api/alerts/channels")).data.channels;
  const cases = [
    [{ type: "carrier-pigeon", url: "https://example.com" }, /type must be one of/],
    [{ type: "discord", url: "ftp://example.com/x" }, /http:\/\/ or https:\/\//],
    [{ type: "discord" }, /URL is required/],
    [{ type: "email", email: { host: "127.0.0.1", security: "none", username: "u", password: "p", from: "a@example.com", to: ["b@example.com"] } }, /needs TLS or STARTTLS/],
    [{ type: "email", email: { host: "127.0.0.1", from: "a@example.com", to: ["not-an-address"] } }, /not an email address/],
  ];
  for (const [ch, re] of cases) {
    const r = await c.put("/api/alerts/channels", { channels: [...channels(), ch] });
    assert.equal(r.status, 400, JSON.stringify(ch));
    assert.match(r.data.detail, re);
  }
  assert.deepEqual((await c.get("/api/alerts/channels")).data.channels.map((x) => x.id), before.map((x) => x.id));
});

test("editing a channel with blank secrets keeps the stored ones", async () => {
  const list = (await c.get("/api/alerts/channels")).data.channels;
  // what the editor sends back: blank url and token
  const edited = list.map((x) => ({ ...x, url: "", token: "", email: x.email && { ...x.email, password: "" } }));
  edited[0].name = "Webhook (renamed)";
  assert.equal((await c.put("/api/alerts/channels", { channels: edited })).status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(stack.data.data, "alert-channels.json"), "utf8")).channels;
  assert.equal(stored[0].name, "Webhook (renamed)");
  assert.equal(stored[0].url, hookUrl("hook"));
  assert.equal(stored[0].token, TOKEN);
});

test("Send test uses the stored secrets of a saved channel, and reports failures", async () => {
  await reset("hook");
  const ok = await c.post("/api/alerts/channels/test", { channel: { id: "hook", type: "webhook", url: "" } });
  assert.deepEqual(ok.data, { ok: true, detail: "sent" });
  const [msg] = await waitReceived("hook", 1, "the test message");
  assert.equal(msg.body.state, "test");
  assert.equal(msg.body.alert, null);
  assert.equal(msg.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(msg.headers["user-agent"], /^llama-paddock\//);

  // an unsaved channel, answered with an error
  await failNext("other", 404);
  const bad = await c.post("/api/alerts/channels/test", { channel: { type: "discord", url: hookUrl("other") } });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.detail, /HTTP 404/);

  const mail = await c.post("/api/alerts/channels/test", { channel: { id: "mail", type: "email", email: channels()[3].email } });
  assert.equal(mail.data.ok, true, JSON.stringify(mail.data));
  await waitFor(() => smtp.messages.length >= 1, { what: "the test email" });
  assert.match(smtp.messages[0].text, /This channel works/);
  await reset("hook");
});

test("an alert's firing and resolved messages reach every channel, in order", async () => {
  smtp.messages.length = 0;
  assert.equal((await c.put("/api/alerts/rules", { rules: [hotRule("hot")] })).status, 200);
  await gpuTemp(91);
  const [fired] = await waitReceived("hook", 1, "firing");
  await gpuTemp(null);
  const hook = await waitReceived("hook", 2, "resolved");
  assert.deepEqual(hook.map((x) => x.body.state), ["firing", "resolved"]);
  assert.equal(fired.body.alert.rule, "hot");
  assert.equal(fired.body.alert.instance, "sim-1");
  assert.equal(fired.body.alert.subject, "gpu0");
  assert.equal(fired.body.alert.value, 91);
  assert.match(fired.body.summary, /^Firing: GPU hot on sim-1 · GPU0$/);

  const discord = await waitReceived("discord", 2, "firing and resolved");
  assert.match(discord[0].body.embeds[0].title, /^Firing: GPU hot/);
  assert.deepEqual(discord[0].body.allowed_mentions, { parse: [] });
  assert.notEqual(discord[0].body.embeds[0].color, discord[1].body.embeds[0].color);

  // the Slack channel only wants firing messages
  const slack = await waitReceived("slack", 1, "firing");
  assert.match(slack[0].body.text, /^Firing: GPU hot/);

  await waitFor(() => smtp.messages.length >= 2, { what: "both emails", describe: () => smtp.messages.map((m) => m.head) });
  assert.match(smtp.messages[0].head, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(smtp.messages[0].text, /^Firing: GPU hot on sim-1/);
  assert.match(smtp.messages[1].text, /^Resolved: GPU hot on sim-1/);
  // a few polls later, still nothing more for the Slack channel
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await received("slack")).length, 1);
  for (const n of ["hook", "discord", "slack"]) await reset(n);
});

test("a rule sends only to the channels it chooses", async () => {
  smtp.messages.length = 0;
  const rules = [
    hotRule("hot-chosen", { channels: ["hook"] }),
    { id: "quiet", name: "GPU hot (dashboard only)", kind: "gpu_temp", threshold: 80, for_s: 0, clear_s: 1, channels: [] },
  ];
  const put = await c.put("/api/alerts/rules", { rules });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.rules.map((r) => r.channels), [["hook"], []]);
  await gpuTemp(92);
  await waitReceived("hook", 1, "firing");
  await gpuTemp(null);
  const hook = await waitReceived("hook", 2, "resolved");
  assert.deepEqual(hook.map((x) => x.body.alert.rule), ["hot-chosen", "hot-chosen"], "the dashboard-only rule sent nothing");
  assert.equal((await received("discord")).length, 0);
  assert.equal(smtp.messages.length, 0);

  const unknown = await c.put("/api/alerts/rules", { rules: [hotRule("hot-x", { channels: ["nope"] })] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.detail, /unknown channel nope/);
  await reset("hook");
});

test("a rate-limited message is retried after Retry-After; a refused one is reported", async () => {
  await c.put("/api/alerts/rules", { rules: [hotRule("hot-429", { channels: ["hook"] })] });
  await failNext("hook", 429, { retry_after: 1 });
  await gpuTemp(93);
  const [msg] = await waitReceived("hook", 1, "the firing message after the retry");
  assert.equal(msg.body.state, "firing");
  await gpuTemp(null);
  await waitReceived("hook", 2, "resolved");
  const hookStatus = async () => (await c.get("/api/alerts/channels")).data.channels.find((x) => x.id === "hook").status;
  const st = await hookStatus();
  assert.ok(st.last_ok > st.last_error_at, "the retry succeeded after the 429");
  assert.match(st.last_error, /HTTP 429/);

  // 400: the channel's settings are wrong, so it isn't retried
  await reset("hook");
  await c.put("/api/alerts/rules", { rules: [hotRule("hot-400", { channels: ["hook"] })] });
  await failNext("hook", 400);
  await gpuTemp(94);
  await waitFor(async () => (await hookStatus()).last_error?.includes("HTTP 400"), { what: "the 400 to be reported" });
  await gpuTemp(null);
  const after = await waitReceived("hook", 1, "the resolved message");
  assert.deepEqual(after.map((x) => x.body.state), ["resolved"], "the refused firing message wasn't sent again");
  assert.equal((await hookStatus()).queued, 0);
});
