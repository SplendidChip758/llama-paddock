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
  __paddockLoginFails?: Map<string, { n: number; until: number }>;
};

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function matchesHash(password: string, stored: string): boolean {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64url"), want.length);
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

export function verifyLogin(username: string, password: string): boolean {
  const auth = loadAuth();
  const userOk = safeEqual(username, auth.username);
  const passOk = matchesHash(password, auth.hash); // always run, so timing doesn't reveal the username
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

const fails = () => (g.__paddockLoginFails ??= new Map());

export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

/** Seconds until this IP may try again (0 = allowed). */
export function loginLockedFor(ip: string): number {
  const f = fails().get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

export function noteLoginFailure(ip: string) {
  const f = fails().get(ip) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) {
    f.n = 0;
    f.until = Date.now() + LOCKOUT_S * 1000;
  }
  fails().set(ip, f);
}

export const clearLoginFailures = (ip: string) => fails().delete(ip);
