// Configuration export and import (#87): moves a dashboard's setup to another install.
//
// An export holds what was set up, not what was recorded: hosts added in the UI, learned agent key
// pins, users, API tokens, alert rules and channels, client names, security dismissals and
// config.yaml. Metric history, jobs, the audit log and the session key stay behind. It is not a
// backup to roll back to: that is `paddock-backup backup`.
//
// Shared by paddock-backup (export|import) and the dashboard's /api/config routes, so it is plain
// Node with no dependencies, and takes the data directory and config path from its caller.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FORMAT = 1;
export const MIN_PASSPHRASE = 12;
const MAGIC = "llama-paddock-config";

/** What an import can be limited to, in the order the plan lists them. */
export const SECTIONS = ["hosts", "users", "tokens", "rules", "channels", "clients", "dismissals", "config"];

const FILES = {
  hosts: "hosts.json",
  pins: "agent-pins.json",
  auth: "auth.json",
  credentials: "credentials.json",
  rules: "alert-rules.json",
  channels: "alert-channels.json",
  clients: "request-clients.json",
  dismissals: "security-dismissals.json",
};

// ============================================================================ files
function readJson(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`can't read ${name}: ${e.message}`);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Via a temp file and rename, mode 600, as lib/store.ts writes them. */
function writeFile(file, text, { chown, keepMode = false } = {}) {
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
  let prev = null;
  try {
    prev = fs.statSync(/*turbopackIgnore: true*/ file);
  } catch {
    // new file
  }
  const tmp = `${file}.${process.pid}.tmp`;
  // run as root by paddock-backup import, in a directory the dashboard's user can change: never
  // write through something already at the temp name
  fs.rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
  fs.writeFileSync(/*turbopackIgnore: true*/ tmp, text, { mode: 0o600, flag: "wx" });
  if (keepMode && prev) {
    fs.chmodSync(/*turbopackIgnore: true*/ tmp, prev.mode & 0o777);
    if (process.getuid?.() === 0) fs.chownSync(/*turbopackIgnore: true*/ tmp, prev.uid, prev.gid);
  } else chown?.(tmp);
  fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
}

function writable(file) {
  try {
    fs.accessSync(/*turbopackIgnore: true*/ fs.existsSync(/*turbopackIgnore: true*/ file) ? file : path.dirname(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const list = (v) => (Array.isArray(v) ? v : []);
const record = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Order-independent comparison of two JSON values, for "unchanged". */
function same(a, b) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// ============================================================================ export
/** The current configuration, as plain data. */
export function collect({ dataDir, configPath }) {
  const auth = readJson(dataDir, FILES.auth);
  if (auth && !Array.isArray(auth.users)) throw new Error("auth.json is from an older version: start the dashboard once so it is upgraded, then export");
  return {
    hosts: list(readJson(dataDir, FILES.hosts)?.instances),
    agent_pins: record(readJson(dataDir, FILES.pins)),
    // the session key stays: a new install signs its own sessions, and everyone signs in again
    users: list(auth?.users).map(({ id, username, role, hash, must_change }) => ({ id, username, role, hash, must_change })),
    tokens: list(readJson(dataDir, FILES.credentials)?.credentials),
    // null: never edited, so the defaults apply, and an import leaves the other install's rules alone
    alert_rules: readJson(dataDir, FILES.rules)?.rules ?? null,
    alert_channels: list(readJson(dataDir, FILES.channels)?.channels),
    client_names: record(readJson(dataDir, FILES.clients)?.names),
    security_dismissals: list(readJson(dataDir, FILES.dismissals)?.dismissals),
    config_yaml: readText(configPath),
  };
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const maxmem = (k) => 256 * k.N * k.r;

function deriveKey(passphrase, salt, k) {
  return crypto.scryptSync(passphrase, salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: maxmem(k) });
}

const aad = () => Buffer.from(`${MAGIC}/${FORMAT}`);

/**
 * The export file's contents. With a passphrase the configuration is sealed with AES-256-GCM under a
 * scrypt key; without one (passphrase null) it is in the clear, which the caller must have asked for.
 */
export function buildExport(config, { passphrase, appVersion }) {
  const head = { [MAGIC]: FORMAT, app_version: appVersion ?? null, created: new Date().toISOString(), source: os.hostname() };
  if (passphrase === null) return { ...head, encryption: null, config };
  if (typeof passphrase !== "string" || [...passphrase].length < MIN_PASSPHRASE) {
    throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(aad());
  const data = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return {
    ...head,
    encryption: {
      kdf: "scrypt", ...SCRYPT, salt: salt.toString("base64"),
      cipher: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    },
    data: data.toString("base64"),
  };
}

export const isEncrypted = (file) => !!file?.encryption;

/** Check the file's header: throws when it isn't an export this version can read. */
export function inspect(file) {
  if (!file || typeof file !== "object" || Array.isArray(file) || !(MAGIC in file)) {
    throw new Error("this isn't a llama-paddock configuration export");
  }
  if (typeof file[MAGIC] !== "number" || file[MAGIC] > FORMAT) {
    throw new Error(`this export was written by a newer llama-paddock (${file.app_version ?? "unknown version"}); update this install first`);
  }
  return { app_version: file.app_version ?? null, created: file.created ?? null, source: file.source ?? null, encrypted: isEncrypted(file) };
}

/** The configuration inside an export. Throws on a wrong passphrase, a damaged file or a missing passphrase. */
export function openExport(file, passphrase) {
  inspect(file);
  if (!file.encryption) return record(file.config);
  const e = file.encryption;
  if (!passphrase) throw new Error("this export is encrypted: enter its passphrase");
  // the parameters come from the file: keep them where scrypt stays quick and small
  const k = { N: Number(e.N), r: Number(e.r), p: Number(e.p) };
  const ok = e.kdf === "scrypt" && e.cipher === "aes-256-gcm" && Number.isInteger(Math.log2(k.N)) && k.N >= 1 << 14 && k.N <= 1 << 20
    && Number.isInteger(k.r) && k.r >= 1 && k.r <= 16 && Number.isInteger(k.p) && k.p >= 1 && k.p <= 4;
  if (!ok) throw new Error("the export's encryption settings aren't ones this version uses");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, Buffer.from(e.salt, "base64"), k), Buffer.from(e.iv, "base64"));
    decipher.setAAD(aad());
    decipher.setAuthTag(Buffer.from(e.tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8");
    return record(JSON.parse(text));
  } catch {
    throw new Error("wrong passphrase, or the file is damaged");
  }
}

// ============================================================================ import
const HOST_ID = /^[A-Za-z0-9_.-]+$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const TOKEN_ID = /^[0-9a-f]{16}$/;

const hostLabel = (h) => `${h.name ?? h.id} (${h.ollama_url})`;

/**
 * What an import would do, and the files it would write. Each item is added (new), replaced (the
 * same id or name exists here and differs) or skipped (unchanged, or can't be imported, with why).
 * Nothing is ever removed.
 *
 * opts:
 * - sections: the SECTIONS to import (default all)
 * - configIds: ids of hosts that config.yaml defines here; a host added in the UI can't shadow them
 * - currentRules: the rules in effect when alert-rules.json doesn't exist yet (the defaults)
 * - writeConfig: write config.yaml; otherwise a different one is only reported
 */
export function planImport(config, { dataDir, configPath, sections = SECTIONS, configIds = [], currentRules = null, writeConfig = false }) {
  const want = new Set(sections);
  const items = [];
  const writes = {};
  const item = (section, key, label, action, reason = null) => items.push({ section, key, label, action, reason });

  /** Merge `incoming` into `current` by key; returns the merged list, or null when nothing changes. */
  function merge(section, current, incoming, { key, label, check, adapt = (x) => x, skip }) {
    const out = [...current];
    let changed = false;
    const seen = new Set();
    for (const raw of incoming) {
      const problem = check(raw);
      const k = problem ? null : key(raw);
      if (problem || seen.has(k)) {
        item(section, k ?? "?", problem ? "an entry that isn't valid" : label(raw), "skip", problem ?? "repeated in the export");
        continue;
      }
      seen.add(k);
      const why = skip?.(raw);
      if (why) {
        item(section, k, label(raw), "skip", why);
        continue;
      }
      const i = out.findIndex((x) => key(x) === k);
      const next = adapt(raw, i >= 0 ? out[i] : undefined);
      if (next === null) continue;
      if (i >= 0 && same(out[i], next)) item(section, k, label(raw), "skip", "unchanged");
      else {
        item(section, k, label(raw), i >= 0 ? "replace" : "add");
        if (i >= 0) out[i] = next;
        else out.push(next);
        changed = true;
      }
    }
    return changed ? out : null;
  }

  // ----- hosts, and the key pins learned for config.yaml hosts
  if (want.has("hosts")) {
    const configured = new Set(configIds);
    const current = list(readJson(dataDir, FILES.hosts)?.instances);
    const hosts = merge("hosts", current, list(config.hosts), {
      key: (h) => h.id,
      label: hostLabel,
      check: (h) => (!h || typeof h !== "object" || !HOST_ID.test(String(h.id ?? "")) || typeof h.ollama_url !== "string" ? "needs an id and an Ollama URL" : null),
      skip: (h) => (configured.has(h.id) ? "config.yaml defines a host with this id here" : null),
    });
    if (hosts) writes[FILES.hosts] = { instances: hosts };

    const pins = record(readJson(dataDir, FILES.pins));
    let pinsChanged = false;
    for (const [id, pin] of Object.entries(record(config.agent_pins))) {
      if (!HOST_ID.test(id) || typeof pin?.fingerprint !== "string" || typeof pin?.agent_url !== "string") continue;
      const label = `agent key pinned for ${id}`;
      if (same(pins[id], pin)) item("hosts", `pin:${id}`, label, "skip", "unchanged");
      else {
        item("hosts", `pin:${id}`, label, pins[id] ? "replace" : "add");
        pins[id] = pin;
        pinsChanged = true;
      }
    }
    if (pinsChanged) writes[FILES.pins] = pins;
  }

  // ----- users, matched by name; tokens follow their user
  const auth = readJson(dataDir, FILES.auth);
  if (auth && !Array.isArray(auth.users)) throw new Error("auth.json here is from an older version: start the dashboard once so it is upgraded, then import");
  const users = list(auth?.users);
  const byName = (name) => users.find((u) => u.username.toLowerCase() === String(name).toLowerCase());
  const exportedUsers = list(config.users);
  /** The id a user from the export has here, after the import. */
  const idHere = new Map();
  for (const u of exportedUsers) {
    const here = byName(u?.username);
    if (here) idHere.set(u.id, here.id);
  }

  if (want.has("users")) {
    const next = merge("users", users, exportedUsers, {
      key: (u) => u.username.toLowerCase(),
      label: (u) => `${u.username} (${u.role})`,
      check: (u) => (!u || !USERNAME.test(String(u.username ?? "")) || !["admin", "viewer"].includes(u.role) || !String(u.hash ?? "").startsWith("scrypt$") ? "needs a user name, a role and a password hash" : null),
      adapt: (u, here) => {
        if (here) {
          // the password may change: sign out the account's sessions
          const merged = { ...here, role: u.role, hash: u.hash, must_change: !!u.must_change };
          return same({ ...here, version: 0 }, { ...merged, version: 0 }) ? here : { ...merged, version: (here.version ?? 1) + 1 };
        }
        const taken = new Set(users.map((x) => x.id));
        const id = typeof u.id === "string" && u.id && !taken.has(u.id) ? u.id : crypto.randomBytes(9).toString("base64url");
        idHere.set(u.id, id);
        return { id, username: u.username, role: u.role, hash: u.hash, must_change: !!u.must_change, version: 1 };
      },
    });
    if (next) {
      if (!next.some((u) => u.role === "admin")) throw new Error("after this import no account would be an admin; nothing was changed");
      writes[FILES.auth] = { secret: auth?.secret ?? crypto.randomBytes(32).toString("base64url"), users: next };
    }
  }

  if (want.has("tokens")) {
    const finalUsers = writes[FILES.auth]?.users ?? users;
    const nameOf = new Map(exportedUsers.map((u) => [u?.id, u?.username]));
    const current = list(readJson(dataDir, FILES.credentials)?.credentials);
    const tokens = merge("tokens", current, list(config.tokens), {
      key: (c) => c.id,
      label: (c) => `${c.name} (${nameOf.get(c.user) ?? "unknown user"})`,
      check: (c) => (!c || !TOKEN_ID.test(String(c.id ?? "")) || !String(c.hash ?? "").startsWith("sha256$") || !Array.isArray(c.scopes) ? "needs an id, a hash and scopes" : null),
      skip: (c) => {
        const id = idHere.get(c.user);
        if (!id || !finalUsers.some((u) => u.id === id)) return `its user ${nameOf.get(c.user) ?? c.user} isn't here; import the users too`;
        return null;
      },
      adapt: (c) => ({ ...c, user: idHere.get(c.user) }),
    });
    if (tokens) writes[FILES.credentials] = { version: 1, credentials: tokens };
  }

  // ----- alert rules and channels, by id
  if (want.has("rules") && Array.isArray(config.alert_rules)) {
    const stored = readJson(dataDir, FILES.rules)?.rules;
    const rules = merge("rules", list(stored ?? currentRules), config.alert_rules, {
      key: (r) => r.id,
      label: (r) => r.name ?? r.id,
      check: (r) => (!r || typeof r.id !== "string" || typeof r.kind !== "string" ? "needs an id and a kind" : null),
    });
    if (rules) writes[FILES.rules] = { rules };
  }
  if (want.has("channels")) {
    const current = list(readJson(dataDir, FILES.channels)?.channels);
    const channels = merge("channels", current, list(config.alert_channels), {
      key: (c) => c.id,
      label: (c) => `${c.name ?? c.id} (${c.type})`,
      check: (c) => (!c || typeof c.id !== "string" || typeof c.type !== "string" ? "needs an id and a type" : null),
    });
    if (channels) writes[FILES.channels] = { channels };
  }

  // ----- request client names, by address; dismissals, by host and check
  if (want.has("clients")) {
    const current = Object.entries(record(readJson(dataDir, FILES.clients)?.names)).map(([address, name]) => ({ address, name }));
    const incoming = Object.entries(record(config.client_names)).map(([address, name]) => ({ address, name }));
    const names = merge("clients", current, incoming, {
      key: (x) => x.address,
      label: (x) => `${x.address} → ${x.name}`,
      check: (x) => (typeof x.name !== "string" || !x.name ? "needs a name" : null),
    });
    if (names) writes[FILES.clients] = { names: Object.fromEntries(names.map((x) => [x.address, x.name])) };
  }
  if (want.has("dismissals")) {
    const current = list(readJson(dataDir, FILES.dismissals)?.dismissals);
    const dismissals = merge("dismissals", current, list(config.security_dismissals), {
      key: (d) => `${d.instance}/${d.check}`,
      label: (d) => `${d.check} on ${d.instance}`,
      check: (d) => (!d || typeof d.instance !== "string" || typeof d.check !== "string" ? "needs a host and a check" : null),
    });
    if (dismissals) writes[FILES.dismissals] = { dismissals };
  }

  // ----- config.yaml, whole
  let configText = null;
  if (want.has("config") && typeof config.config_yaml === "string") {
    const here = readText(configPath);
    const label = "config.yaml (settings and the hosts it defines)";
    if (here === config.config_yaml) item("config", "config.yaml", label, "skip", "unchanged");
    else if (!writeConfig) item("config", "config.yaml", label, "skip", "it differs; the dashboard doesn't write config.yaml: import it with paddock-backup import --config, or copy the settings by hand");
    else if (!writable(configPath)) item("config", "config.yaml", label, "skip", `can't write ${configPath}`);
    else {
      item("config", "config.yaml", label, here === null ? "add" : "replace");
      configText = config.config_yaml;
    }
  }

  return { items, writes, configText };
}

/** Write what planImport decided. */
export function applyImport(plan, { dataDir, configPath, chown }) {
  const written = [];
  for (const [name, value] of Object.entries(plan.writes)) {
    writeFile(path.join(dataDir, name), JSON.stringify(value, null, 2) + "\n", { chown });
    written.push(name);
  }
  if (plan.configText !== null) {
    // keep its owner and mode: the installer makes it readable by the service but not writable
    writeFile(configPath, plan.configText, { chown, keepMode: true });
    written.push(configPath);
  }
  return written;
}

/** Counts per action, for messages and the audit log. */
export function summarize(items) {
  const n = { add: 0, replace: 0, skip: 0 };
  for (const i of items) n[i.action]++;
  return n;
}
