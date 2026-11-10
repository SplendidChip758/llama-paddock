#!/usr/bin/env node
// paddock-backup: full backups of a dashboard install, and restoring them (#87).
//
// A full backup is everything needed to put an install back exactly as it was: a consistent
// snapshot of paddock.db, the other files in the data directory (hosts, users, tokens, pins,
// rules), config.yaml and the service's env file, with the application and schema versions.
// It is for rolling back on the same install. Moving the setup to another install is the
// configuration export (export|import, config-export.mjs).
//
// Plain Node with no dependencies, so it works when the dashboard doesn't start. It ships next to
// server.js and reads the version from the package.json there.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as configExport from "./config-export.mjs";

const FORMAT = 1;
const DB = "paddock.db";
/** Written by a running dashboard: restore refuses while that process is alive. */
const LOCK = "paddock.lock";
/** The dashboard's request to the installer's updater (lib/dashboardUpdate.ts). */
const UPDATE_REQUEST = "update-request.json";
/** Automatic backups kept per reason; manual ones are kept until removed. */
const KEEP = { "pre-update": 5, "pre-restore": 3, "pre-import": 3 };
const REASONS = ["manual", "pre-update", "pre-restore", "pre-import"];

const USAGE = `Usage: paddock-backup <command> [options]

  backup [--reason manual|pre-update] [--keep N]
                      Take a full backup; prints its directory
  list                List backups, newest last
  verify <name>       Check a backup's files against its checksums
  restore <name>      Put the install back as the backup has it. Stop the
                      dashboard first. The current state is backed up first
      --data-only     Leave config.yaml and the env file alone

  export <file>       Export the configuration to move it to another install:
                      hosts, users, API tokens, alert rules and channels,
                      config.yaml. No history. Encrypted with a passphrase
      --unencrypted   Write it in plain text instead
  import <file>       Add the configuration from an export; nothing is
                      removed. Stop the dashboard first, or import it from the
                      dashboard's Backup page. The current state is backed up
      --dry-run       Only list what would be added, replaced or skipped
      --only LIST     Only these parts, comma-separated: hosts, users, tokens,
                      rules, channels, clients, dismissals, config
      --config        Also write config.yaml when the export's differs
  The passphrase is asked for, or read from --passphrase-file FILE or
  $PADDOCK_PASSPHRASE.

Options:
  --dir DIR           Where backups live (default: <data dir>/backups)
  --env-file FILE     The service's env file, backed up and restored with the
                      config (default: $PADDOCK_ENV_FILE)
  --json              Machine-readable output for backup, list and verify

Environment: PADDOCK_DATA_DIR, PADDOCK_CONFIG, PADDOCK_ENV_FILE, as the dashboard uses them.`;

class UsageError extends Error {}

// ============================================================================ paths and versions
const APP_DIR = process.env.PADDOCK_APP_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** Same rule as dashboard/lib/store.ts. */
function dataDir() {
  if (process.env.PADDOCK_DATA_DIR) return path.resolve(process.env.PADDOCK_DATA_DIR);
  return path.join(path.dirname(configPath()), "data");
}
const configPath = () => path.resolve(process.env.PADDOCK_CONFIG || "/config/config.yaml");

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v ?? "");
  return m ? [+m[1], +m[2], +m[3], m[4] ? m[4].split(".") : null] : null;
}

/** Semver order, prereleases first; null when either isn't a version. Same as lib/agentReleases.ts. */
function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (!x[3] || !y[3]) return (x[3] ? -1 : 0) - (y[3] ? -1 : 0);
  for (let i = 0; i < Math.max(x[3].length, y[3].length); i++) {
    const p = x[3][i], q = y[3][i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    return /^\d+$/.test(p) && /^\d+$/.test(q) ? +p - +q : p < q ? -1 : 1;
  }
  return 0;
}

// ============================================================================ files
/**
 * Run as root (the installer's updater), new files would be root's and the service couldn't read
 * them: hand them to whoever owns the data directory.
 */
function owner() {
  if (process.getuid?.() !== 0) return null;
  try {
    const st = fs.statSync(dataDir());
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}
function chownToData(p) {
  const o = owner();
  if (o) fs.chownSync(p, o.uid, o.gid);
}

function mkdirPrivate(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    chownToData(dir);
  }
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** paddock.db and the files SQLite keeps beside it. */
const isDbFile = (name) => name === DB || /^paddock\.db-(wal|shm|journal)$/.test(name);

/**
 * The data directory's files that belong in a backup, relative to it: everything except the
 * database (snapshotted separately), the lock, half-written temp files, uploads in progress and
 * the backups themselves.
 */
function dataFiles(backups) {
  const root = dataDir();
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(root, r);
      if (abs === backups) continue;
      if (e.isDirectory()) {
        if (!rel && e.name === "uploads") continue;
        walk(r);
      } else if (e.isFile()) {
        // a pending update request would start the update again after a restore
        if (!rel && (isDbFile(e.name) || e.name === LOCK || e.name === UPDATE_REQUEST)) continue;
        if (e.name.endsWith(".tmp")) continue;
        out.push(r);
      }
    }
  };
  walk("");
  return out.sort();
}

/** Copy via a temp file and rename, so a crash never leaves a half-written file in place. */
function placeFile(src, dest, mode, keepOwner) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  let prev = null;
  try {
    prev = fs.statSync(dest);
  } catch {
    // new file
  }
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, keepOwner && prev ? prev.mode & 0o777 : mode);
  if (keepOwner && prev) {
    if (process.getuid?.() === 0) fs.chownSync(tmp, prev.uid, prev.gid);
  } else chownToData(tmp);
  fs.renameSync(tmp, dest);
}

// ============================================================================ sqlite
function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    const mod = process.getBuiltinModule?.("node:sqlite");
    if (!mod) throw new Error(`paddock-backup needs Node.js 22.13 or newer (this is ${process.versions.node})`);
    return mod;
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * A consistent copy of paddock.db while the dashboard keeps writing to it. VACUUM INTO reads the
 * database in one transaction, so the copy is a single point in time (unlike copying the file and
 * its WAL), and it works on every Node with node:sqlite. Returns the schema version.
 */
function snapshotDb(src, dest) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(src);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const schema = Number(db.prepare("PRAGMA user_version").get().user_version);
    db.prepare("VACUUM INTO ?").run(dest);
    return schema;
  } finally {
    db.close();
    // opening it as root may have created the -wal/-shm files, which the service must still write
    for (const f of fs.readdirSync(path.dirname(src))) if (isDbFile(f)) chownToData(path.join(path.dirname(src), f));
  }
}

function checkDb(file) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const r = db.prepare("PRAGMA quick_check").all().map((x) => Object.values(x)[0]);
    if (r.length !== 1 || r[0] !== "ok") throw new Error(`${path.basename(file)} is damaged: ${r.slice(0, 3).join("; ")}`);
  } finally {
    db.close();
  }
}

// ============================================================================ backups
function backupsDir(opts) {
  return path.resolve(opts.dir || path.join(dataDir(), "backups"));
}

function readManifest(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (typeof m.format !== "number" || !Array.isArray(m.files)) throw new Error(`${dir}: not a llama-paddock backup`);
  return m;
}

function listBackups(opts) {
  const dir = backupsDir(opts);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const name of names.sort()) {
    try {
      out.push({ name, path: path.join(dir, name), ...readManifest(path.join(dir, name)) });
    } catch {
      // not a backup, or one whose manifest is gone: leave it alone
    }
  }
  return out.sort((a, b) => a.created - b.created || (a.name < b.name ? -1 : 1));
}

/** A name in the backups directory, or a path to a backup anywhere. */
function resolveBackup(arg, opts) {
  if (!arg) throw new UsageError("which backup? Give its name (see paddock-backup list) or its path");
  const inDir = path.join(backupsDir(opts), arg);
  for (const p of arg.includes("/") ? [path.resolve(arg)] : [inDir, path.resolve(arg)]) {
    if (fs.existsSync(path.join(p, "manifest.json"))) return p;
  }
  throw new Error(`no backup ${arg} in ${backupsDir(opts)}`);
}

function removeStalePartials(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(".partial-")) continue;
    const p = path.join(dir, e.name);
    // a backup that is being written right now is younger than this
    if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60_000) fs.rmSync(p, { recursive: true, force: true });
  }
}

function prune(opts, reason, keep) {
  const old = listBackups(opts).filter((b) => b.reason === reason);
  const removed = [];
  for (const b of old.slice(0, Math.max(0, old.length - keep))) {
    fs.rmSync(b.path, { recursive: true, force: true });
    removed.push(b.name);
  }
  return removed;
}

function envFile(opts) {
  const f = opts["env-file"] || process.env.PADDOCK_ENV_FILE;
  return f ? path.resolve(f) : null;
}

export function backup(opts = {}) {
  const reason = opts.reason || "manual";
  if (!REASONS.includes(reason)) throw new UsageError(`--reason must be ${REASONS.join(", ")}`);
  const keep = opts.keep !== undefined ? Number(opts.keep) : KEEP[reason];
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) throw new UsageError("--keep must be a whole number of at least 1");
  // the dashboard passes its own version: bundled into the server, this file can't find package.json by its path
  const version = opts.version ?? appVersion();
  const data = dataDir();
  if (!fs.existsSync(data)) throw new Error(`the data directory ${data} doesn't exist: nothing to back up (set PADDOCK_DATA_DIR)`);
  const dir = backupsDir(opts);
  mkdirPrivate(dir);
  removeStalePartials(dir);

  const created = Date.now() / 1000;
  const stamp = new Date(created * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let name = `${stamp}-${version ? `v${version}` : "unknown"}-${reason}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stamp}-${version ? `v${version}` : "unknown"}-${reason}-${i}`;
  const partial = path.join(dir, `.partial-${name}`);
  fs.mkdirSync(partial, { mode: 0o700 });
  chownToData(partial);

  try {
    const files = [];
    let schema = null;
    const add = (role, rel, source) => {
      const abs = path.join(partial, rel);
      fs.chmodSync(abs, 0o600);
      chownToData(abs);
      files.push({ path: rel, role, source, size: fs.statSync(abs).size, sha256: sha256(abs) });
    };
    const copy = (role, rel, source) => {
      fs.mkdirSync(path.dirname(path.join(partial, rel)), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.resolve(data, source), path.join(partial, rel));
      add(role, rel, source);
    };

    const db = path.join(data, DB);
    let warning = null;
    if (fs.existsSync(db)) {
      fs.mkdirSync(path.join(partial, "data"), { mode: 0o700 });
      try {
        schema = snapshotDb(db, path.join(partial, `data/${DB}`));
        checkDb(path.join(partial, `data/${DB}`));
        add("data", `data/${DB}`, DB);
      } catch (e) {
        // a damaged database is what a restore often replaces: keep its files as they are, and restore anyway
        if (reason !== "pre-restore") throw e;
        warning = `the database couldn't be read (${e.message}); its files were copied as they were`;
        fs.rmSync(path.join(partial, `data/${DB}`), { force: true });
        for (const f of fs.readdirSync(data)) if (isDbFile(f)) copy("data", `data/${f}`, f);
      }
    }
    for (const rel of dataFiles(dir)) copy("data", `data/${rel}`, rel);
    const cfg = configPath();
    if (fs.existsSync(cfg)) copy("config", "config/config.yaml", cfg);
    const env = envFile(opts);
    if (env) {
      if (!fs.existsSync(env)) throw new Error(`the env file ${env} doesn't exist`);
      copy("env", `config/${path.basename(env)}`, env);
    }
    for (const d of fs.readdirSync(partial, { recursive: true, withFileTypes: true })) {
      if (d.isDirectory()) chownToData(path.join(d.parentPath, d.name));
    }

    const manifest = {
      format: FORMAT,
      app_version: version,
      schema,
      created,
      reason,
      host: os.hostname(),
      data_dir: data,
      ...(warning && { warning }),
      files,
    };
    fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    chownToData(path.join(partial, "manifest.json"));
    fs.renameSync(partial, path.join(dir, name));
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw e;
  }

  const pruned = keep ? prune(opts, reason, keep) : [];
  return { name, path: path.join(dir, name), pruned, warning: listBackups(opts).find((b) => b.name === name)?.warning ?? null };
}

/** Problems with a backup's files, or [] when every checksum matches. */
export function verify(dir) {
  const m = readManifest(dir);
  const problems = [];
  for (const f of m.files) {
    const abs = path.join(dir, f.path);
    // a manifest is only data: never follow it out of the backup
    if (path.relative(dir, abs).startsWith("..") || path.isAbsolute(f.path)) {
      problems.push(`${f.path}: outside the backup`);
      continue;
    }
    if (!fs.existsSync(abs)) problems.push(`${f.path}: missing`);
    else if (sha256(abs) !== f.sha256) problems.push(`${f.path}: checksum doesn't match`);
  }
  if (!problems.length && m.files.some((f) => f.path === `data/${DB}`)) {
    try {
      checkDb(path.join(dir, `data/${DB}`));
    } catch (e) {
      problems.push(e.message);
    }
  }
  return problems;
}

/** The pid of a dashboard that is running on this data directory, or null. */
function runningDashboard() {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dataDir(), LOCK), "utf8"));
  } catch {
    return null;
  }
  // another container or machine: its pid means nothing here
  if (lock.host !== os.hostname() || !Number.isInteger(lock.pid) || lock.pid === process.pid) return null;
  try {
    process.kill(lock.pid, 0);
    return lock.pid;
  } catch (e) {
    return e.code === "EPERM" ? lock.pid : null;
  }
}

function writable(file) {
  try {
    fs.accessSync(fs.existsSync(file) ? file : path.dirname(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function restore(arg, opts = {}) {
  const src = resolveBackup(arg, opts);
  const m = readManifest(src);
  if (m.format > FORMAT) throw new Error(`this backup was written by a newer paddock-backup (format ${m.format}); install llama-paddock ${m.app_version ?? "of that version"} to restore it`);
  const version = appVersion();
  const cmp = compareVersions(m.app_version, version);
  if (cmp === null && m.app_version !== version) {
    throw new Error(`can't tell whether this backup (from ${m.app_version ?? "an unknown version"}) works with this install (${version ?? "unknown version"})`);
  }
  if (cmp > 0) {
    // its database and files may use a format this version doesn't know
    throw new Error(`this backup is from llama-paddock ${m.app_version}, newer than this install (${version}). Install v${m.app_version} first (installer: update-llama-paddock v${m.app_version}; Docker: image ghcr.io/splendidchip758/llama-paddock:${m.app_version}), then restore`);
  }
  const problems = verify(src);
  if (problems.length) throw new Error(`the backup is damaged, nothing was changed:\n  ${problems.join("\n  ")}`);
  const pid = runningDashboard();
  if (pid) throw new Error(`the dashboard is running (pid ${pid}); stop it first, then restore`);

  const data = dataDir();
  const targets = [];
  for (const f of m.files) {
    if (f.role === "data") targets.push({ f, dest: path.join(data, f.path.slice("data/".length)), mode: 0o600, keepOwner: false });
    else if (opts["data-only"]) continue;
    else if (f.role === "config") targets.push({ f, dest: configPath(), mode: 0o600, keepOwner: true });
    else if (f.role === "env") {
      const dest = envFile(opts) || f.source;
      targets.push({ f, dest, mode: 0o600, keepOwner: true });
    }
  }
  // an unchanged config needn't be writable: Docker mounts config.yaml read-only
  const changed = targets.filter((t) => t.f.role === "data" || !fs.existsSync(t.dest) || sha256(t.dest) !== t.f.sha256);
  targets.length = 0;
  targets.push(...changed);
  for (const t of targets) {
    if (path.relative(data, t.dest).startsWith("..") && t.f.role === "data") throw new Error(`${t.f.path}: outside the data directory`);
    if (!writable(t.dest)) {
      throw new Error(`can't write ${t.dest}${t.f.role === "data" ? "" : " (use --data-only to restore only the data directory)"}; nothing was changed`);
    }
  }

  mkdirPrivate(data);
  // the state being replaced, so a restore can be undone too
  const before = fs.readdirSync(data).length ? backup({ ...opts, reason: "pre-restore" }) : null;

  // files that appeared after the backup was taken go too: credentials created since then must not survive
  const keep = new Set(m.files.filter((f) => f.role === "data").map((f) => f.path.slice("data/".length)));
  for (const rel of dataFiles(backupsDir(opts))) if (!keep.has(rel)) fs.rmSync(path.join(data, rel), { force: true });
  // a WAL left next to the old database would be replayed into the restored one
  for (const f of fs.readdirSync(data)) if (isDbFile(f)) fs.rmSync(path.join(data, f), { force: true });

  for (const t of targets) placeFile(path.join(src, t.f.path), t.dest, t.mode, t.keepOwner);
  return { restored: src, manifest: m, before: before && { name: before.name, warning: before.warning }, files: targets.map((t) => t.dest) };
}

// ============================================================================ configuration export
async function passphrase(opts, { confirm }) {
  if (opts["passphrase-file"]) {
    const f = opts["passphrase-file"];
    return fs.readFileSync(f === "-" ? 0 : f, "utf8").replace(/\r?\n$/, "");
  }
  if (process.env.PADDOCK_PASSPHRASE) return process.env.PADDOCK_PASSPHRASE;
  if (!process.stdin.isTTY) throw new UsageError("no passphrase: use --passphrase-file FILE or $PADDOCK_PASSPHRASE");
  const first = await ask("Passphrase: ");
  if (confirm && (await ask("Again: ")) !== first) throw new Error("the passphrases don't match");
  return first;
}

/** A line from the terminal, not echoed. */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write(question);
  rl._writeToOutput = () => {};
  return new Promise((resolve) => rl.question("", (answer) => {
    rl.close();
    process.stderr.write("\n");
    resolve(answer);
  }));
}

const paths = () => ({ dataDir: dataDir(), configPath: configPath() });

export async function exportConfig(file, opts = {}) {
  if (!file) throw new UsageError("where to? Give a file name, or - for standard output");
  const config = configExport.collect(paths());
  const pass = opts.unencrypted ? null : await passphrase(opts, { confirm: true });
  const text = JSON.stringify(configExport.buildExport(config, { passphrase: pass, appVersion: appVersion() }), null, 2) + "\n";
  if (file === "-") process.stdout.write(text);
  // never over an existing file: it may be the only copy of another export
  else fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
  return { file, encrypted: !opts.unencrypted };
}

export async function importConfig(file, opts = {}) {
  if (!file) throw new UsageError("which export? Give its file name");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`can't read ${file}: ${e.message}`);
  }
  const info = configExport.inspect(data);
  const config = configExport.openExport(data, info.encrypted ? await passphrase(opts, { confirm: false }) : null);
  const sections = opts.only ? opts.only.split(",").map((s) => s.trim()).filter(Boolean) : configExport.SECTIONS;
  const unknown = sections.filter((s) => !configExport.SECTIONS.includes(s));
  if (unknown.length) throw new UsageError(`--only: unknown ${unknown.join(", ")} (use ${configExport.SECTIONS.join(", ")})`);
  const plan = configExport.planImport(config, { ...paths(), sections, writeConfig: !!opts.config });
  const result = { export: info, items: plan.items, counts: configExport.summarize(plan.items), applied: false, written: [], before: null };
  if (opts["dry-run"]) return result;
  const pid = runningDashboard();
  if (pid) throw new Error(`the dashboard is running (pid ${pid}); stop it first, or import from its Backup page`);
  if (!plan.items.some((i) => i.action !== "skip")) return result;
  mkdirPrivate(dataDir());
  const before = fs.readdirSync(dataDir()).length ? backup({ ...opts, reason: "pre-import" }) : null;
  const written = configExport.applyImport(plan, { ...paths(), chown: chownToData });
  return { ...result, applied: true, written, before: before && before.name };
}

// ============================================================================ CLI
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (["json", "data-only", "help", "unencrypted", "dry-run", "config"].includes(k)) opts[k] = true;
    else if (["dir", "env-file", "reason", "keep", "passphrase-file", "only"].includes(k)) {
      const val = v ?? argv[++i];
      if (val === undefined) throw new UsageError(`--${k} needs a value`);
      opts[k] = val;
    } else throw new UsageError(`unknown option --${k}`);
  }
  return opts;
}

const when = (t) => new Date(t * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const size = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);

async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, arg] = opts._;
  if (opts.help || !cmd || cmd === "help") {
    console.log(USAGE);
    return;
  }
  const out = (x, text) => console.log(opts.json ? JSON.stringify(x, null, 2) : text);
  switch (cmd) {
    case "backup": {
      const r = backup(opts);
      if (!opts.json) for (const n of r.pruned) console.error(`removed old backup ${n}`);
      if (!opts.json && r.warning) console.error(`warning: ${r.warning}`);
      out(r, r.path);
      break;
    }
    case "list": {
      const list = listBackups(opts).map(({ files, ...b }) => ({ ...b, size: files.reduce((s, f) => s + f.size, 0) }));
      const lines = list.map((b) => `${b.name}  ${when(b.created)}  ${b.reason}  ${size(b.size)}`);
      out(list, lines.length ? lines.join("\n") : `no backups in ${backupsDir(opts)}`);
      break;
    }
    case "verify": {
      const dir = resolveBackup(arg, opts);
      const problems = verify(dir);
      out({ backup: dir, ok: !problems.length, problems }, problems.length ? `damaged:\n  ${problems.join("\n  ")}` : `ok: ${dir}`);
      if (problems.length) process.exitCode = 1;
      break;
    }
    case "restore": {
      const r = restore(arg, opts);
      if (r.before) console.error(`the state it replaced is in backup ${r.before.name}${r.before.warning ? ` (${r.before.warning})` : ""}`);
      out(r, `restored ${path.basename(r.restored)} (llama-paddock ${r.manifest.app_version}); start the dashboard if it isn't running`);
      break;
    }
    case "export": {
      const r = await exportConfig(arg, opts);
      if (arg !== "-") out(r, `wrote ${arg}${r.encrypted ? "" : " (unencrypted: it holds every secret in plain text)"}`);
      break;
    }
    case "import": {
      const r = await importConfig(arg, opts);
      const lines = r.items.map((i) => `${i.action.padEnd(8)}${i.section.padEnd(11)}${i.label}${i.reason ? `: ${i.reason}` : ""}`);
      const { add, replace, skip } = r.counts;
      const verb = r.applied ? "imported" : opts["dry-run"] ? "would import" : "nothing to import";
      lines.push(`${verb}: ${add} to add, ${replace} to replace, ${skip} skipped`);
      if (r.before) lines.push(`the state it replaced is in backup ${r.before}`);
      out(r, lines.join("\n"));
      break;
    }
    default:
      throw new UsageError(`unknown command ${cmd}`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`paddock-backup: ${e.message}`);
    if (e instanceof UsageError) console.error(`\n${USAGE}`);
    process.exitCode = 2;
  });
}
