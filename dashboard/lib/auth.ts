// Dashboard login: one admin account in <data dir>/auth.json, signed session cookies.
// Used by proxy.ts (every request) and the /api/auth routes, so no "server-only".
import crypto from "node:crypto";
import { mtimeOf, readJson, writeJson } from "./store";

export const SESSION_COOKIE = "paddock_session";
export const SESSION_TTL = 7 * 24 * 3600; // seconds
export const MIN_PASSWORD = 8;

const FILE = "auth.json";

interface AuthFile {
  username: string;
  hash: string;
  must_change: boolean;
  /** HMAC key for session cookies. */
  secret: string;
  /** Bumped on every password change, which signs out all other sessions. */
  version: number;
}

export interface Session {
  username: string;
  mustChange: boolean;
}

/** PADDOCK_AUTH=off disables the login, e.g. behind an auth proxy (Authelia, Authentik, …). */
export const authEnabled = () => process.env.PADDOCK_AUTH !== "off";

// Shared by proxy.ts and the route bundles, which can be separate module instances.
const g = globalThis as unknown as {
  __paddockAuth?: { auth: AuthFile; mtime: number | null };
  __paddockLoginFails?: Map<string, { n: number; until: number; last: number }>;
  /** Timestamps of recent failures from every address, for the global ceiling. */
  __paddockLoginFailsGlobal?: number[];
};

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// Async so a burst of login attempts doesn't stall the event loop (and with it the UI and the poller).
const scrypt = (password: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, len, (err, key) => (err ? reject(err) : resolve(key))));

async function matchesHash(password: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = await scrypt(password, Buffer.from(salt, "base64url"), want.length);
  return crypto.timingSafeEqual(got, want);
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const sign = (payload: string, secret: string) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

function save(auth: AuthFile) {
  writeJson(FILE, auth);
  g.__paddockAuth = { auth, mtime: mtimeOf(FILE) };
}

/**
 * Load auth.json. On first start it is created from PADDOCK_USERNAME / PADDOCK_PASSWORD,
 * or with a random password printed to the log; either way it must be changed on first login.
 * Deleting auth.json and restarting resets the login the same way.
 */
export function loadAuth(): AuthFile {
  const mtime = mtimeOf(FILE);
  const cached = g.__paddockAuth;
  if (cached && mtime !== null && cached.mtime === mtime) return cached.auth;

  const stored = readJson<AuthFile>(FILE);
  if (stored) {
    g.__paddockAuth = { auth: stored, mtime };
    return stored;
  }

  const username = process.env.PADDOCK_USERNAME || "admin";
  let password = process.env.PADDOCK_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(12).toString("base64url");
    console.log(`[llama-paddock] initial login: ${username} / ${password} (you'll be asked to change it)`);
  }
  const auth: AuthFile = {
    username,
    hash: hashPassword(password),
    must_change: true,
    secret: crypto.randomBytes(32).toString("base64url"),
    version: 1,
  };
  save(auth);
  return auth;
}

export async function verifyLogin(username: string, password: string): Promise<boolean> {
  const auth = loadAuth();
  const userOk = safeEqual(username, auth.username);
  const passOk = await matchesHash(password, auth.hash); // always run, so timing doesn't reveal the username
  return userOk && passOk;
}

export const checkPassword = (password: string) => matchesHash(password, loadAuth().hash);

export function changePassword(password: string) {
  const auth = loadAuth();
  save({ ...auth, hash: hashPassword(password), must_change: false, version: auth.version + 1 });
}

// ============================================================================ sessions
export function createSession(): string {
  const auth = loadAuth();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = Buffer.from(JSON.stringify({ u: auth.username, v: auth.version, exp })).toString("base64url");
  return `${payload}.${sign(payload, auth.secret)}`;
}

export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const auth = loadAuth();
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload, auth.secret))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (p.u !== auth.username || p.v !== auth.version || p.exp < Date.now() / 1000) return null;
    return { username: p.u, mustChange: auth.must_change };
  } catch {
    return null;
  }
}

/** Cookie attributes for a session token; Secure when the dashboard is reached over https. */
export function sessionCookie(req: Request, value: string, maxAge = SESSION_TTL) {
  const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  return { name: SESSION_COOKIE, value, httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge };
}

// ============================================================================ brute-force guard
const MAX_FAILS = 5;
const LOCKOUT_S = 300;
/** Failed logins allowed from everyone together per LOCKOUT_S: the only limit that holds when addresses can be spoofed. */
const MAX_FAILS_GLOBAL = 20;
const MAX_TRACKED = 10_000;

const fails = () => (g.__paddockLoginFails ??= new Map());
const globalFails = () => (g.__paddockLoginFailsGlobal ??= []);

/**
 * PADDOCK_TRUSTED_PROXIES: how many reverse proxies sit in front of the dashboard, each appending the
 * address it talked to onto X-Forwarded-For. 0 (the default) means clients connect directly.
 */
export const trustedProxies = () => Math.max(0, Math.floor(Number(process.env.PADDOCK_TRUSTED_PROXIES) || 0));

/**
 * The address the lockout is keyed on.
 *
 * Next.js copies the socket address into X-Forwarded-For only when the client sent none, so the
 * header is the only place to look and a direct client can replace it. With no trusted proxy the
 * last entry is used anyway: it still locks out honest clients, and the global ceiling catches
 * the rest. With N trusted proxies the N-th entry from the right is the one the outermost proxy
 * added, whatever the client put in front of it (the proxies' own addresses never appear).
 */
export function clientIp(req: Request): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain.at(-Math.max(1, trustedProxies())) || "unknown";
}

/** Seconds until logins are accepted again from anyone (0 = allowed). Checked before the password, so it also caps the CPU spent on scrypt. */
export function loginLockedGlobally(): number {
  const now = Date.now();
  const list = globalFails();
  while (list.length && list[0] <= now - LOCKOUT_S * 1000) list.shift();
  return list.length >= MAX_FAILS_GLOBAL ? Math.ceil((list[0] + LOCKOUT_S * 1000 - now) / 1000) : 0;
}

/** Seconds until this address may try again (0 = allowed). */
export function loginLockedFor(ip: string): number {
  const f = fails().get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

export function noteLoginFailure(ip: string) {
  const now = Date.now();
  globalFails().push(now);
  const map = fails();
  // forget addresses that have been quiet for a lockout period, and never grow without bound
  for (const [k, v] of map) if (v.last <= now - LOCKOUT_S * 1000 && v.until <= now) map.delete(k);
  while (map.size >= MAX_TRACKED) map.delete(map.keys().next().value!);

  const f = map.get(ip) ?? { n: 0, until: 0, last: now };
  f.n += 1;
  f.last = now;
  if (f.n >= MAX_FAILS) {
    f.n = 0;
    f.until = now + LOCKOUT_S * 1000;
  }
  map.delete(ip); // re-insert so the eviction order stays oldest-first
  map.set(ip, f);
}

export const clearLoginFailures = (ip: string) => fails().delete(ip);
