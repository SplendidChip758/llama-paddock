// Storage failures (#34, M1): when paddock.db refuses writes, the dashboard keeps monitoring and
// says what it can't save, on /api/storage, /api/healthz and /metrics. Once writes work again the
// failures clear. The test makes the database refuse writes by holding its write lock from here,
// as another process would: the dashboard's writes give up with "database is locked".
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metric, scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, lock;

before(async () => {
  holder.stack = await startStack({ sim: { hosts: 1 } });
  c = holder.stack.client;
});
after(async () => {
  lock?.close();
  await holder.stack?.stop();
});

const failures = async () => (await c.get("/api/storage")).data.failures;
const storageOk = async () => (await c.get("/api/healthz")).data.storage_ok;
const failing = async (area) => metric((await c.get("/metrics")).data, "paddock_storage_failing", { area });

test("while every write works, nothing is reported", async () => {
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "the host online");
  assert.deepEqual(await failures(), []);
  assert.equal(await storageOk(), true);
  assert.equal(await failing("history"), 0);
});

test("a database that refuses writes is reported, and monitoring goes on", async () => {
  lock = new DatabaseSync(path.join(holder.stack.data.data, "paddock.db"));
  lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
  const list = await waitFor(async () => {
    const f = await failures();
    return ["history", "events"].every((a) => f.some((x) => x.area === a)) && f;
  }, { timeout: 60_000, what: "the history and events failures to be reported" });

  const history = list.find((f) => f.area === "history");
  assert.equal(history.label, "metric history");
  assert.match(history.loss, /gap/);
  assert.match(history.error, /locked|busy/i);
  assert.ok(history.since <= history.last && history.count >= 1, JSON.stringify(history));
  assert.equal(await storageOk(), false);
  assert.equal(await failing("history"), 1);
  assert.equal(await failing("benchmarks"), 0);

  // the host is still polled meanwhile: only saving is failing
  const before = (await c.instance("sim-1")).updated;
  await c.waitInstance("sim-1", (x) => x.updated > before, "the host to be polled again", 30_000);
});

test("once writes work again, the failures clear", async () => {
  lock.exec("ROLLBACK");
  lock.close();
  lock = null;
  await waitFor(async () => (await failures()).length === 0, { timeout: 30_000, what: "the failures to clear" });
  assert.equal(await storageOk(), true);
  assert.equal(await failing("history"), 0);
});
