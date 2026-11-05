// Dashboard login: user accounts in <data dir>/auth.json, signed session cookies, and bearer tokens (credentials.ts).
// Used by proxy.ts (every request) and the /api/auth, /api/users and /api/tokens routes, so no "server-only".
import crypto from "node:crypto";
import {
  ROLE_SCOPES, findByToken, isExpired, narrowCredentials, pruneOrphans, removeCredentialsOf, touch,
  type CredentialKind, type Scope,
} from "./credentials";
import { HttpError } from "./http-error";
import { mtimeOf, readJson, writeJson } from "./store";

export const SESSION_COOKIE = "paddock_session";
export const SESSION_TTL = 7 * 24 * 3600; // seconds
export const MIN_PASSWORD = 8;

/** admin: full control. viewer: sees everything, changes nothing (enforced in proxy.ts). */
export const ROLES = ["admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const FILE = "auth.json";

interface User {
  /** Sessions name the account by this, so a removed user's cookie can't sign in to a new account with the same name. */
  id: string;
  username: string;
  role: Role;
  hash: string;
  /** Set for the first account and after an admin creates or resets one: the password was handed over and must be replaced. */
  must_change: boolean;
  /** Bumped on every password change or reset, which signs out the user's other sessions. */
  version: number;
}

interface AuthFile {
  /** HMAC key for session cookies. */
  secret: string;
  users: User[];
}

/** auth.json before user accounts: one login, which becomes the first admin. */
interface LegacyAuthFile {
  username: string;
  hash: string;
  must_change: boolean;
  secret: string;
  version: number;
}

export interface Session {
  username: string;
  role: Role;
  mustChange: boolean;
}

/** Who is making a request: a signed-in browser, or a credential acting for its user. */
export interface Caller {
  username: string;
  role: Role;
  /** What this request may do: the role's scopes for a session; for a credential, its scopes that the role still allows. */
  scopes: Scope[];
  credential: { id: string; kind: CredentialKind; name: string } | null;
}

export interface UserInfo {
  username: string;
  role: Role;
  must_change: boolean;
}

/** PADDOCK_AUTH=off disables the login, e.g. behind an auth proxy (Authelia, Authentik, …). */
export const authEnabled = () => process.env.PADDOCK_AUTH !== "off";

// Shared by proxy.ts and the route bundles, which can be separate module instances.
const g = globalThis as unknown as {
  __paddockAuth?: { auth: AuthFile; mtime: number | null };
  __paddockDummyHash?: string;
  __paddockLoginFails?: Map<string, { n: number; until: number; last: number }>;
  /** Timestamps of recent failures from every address, for the global ceiling. */
  __paddockLoginFailsGlobal?: number[];
  __paddockTokenFails?: Map<string, { n: number; until: number; last: number }>;
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

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const sign = (payload: string, secret: string) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

/** A password for an admin to hand over; the user must replace it on first sign-in. */
const tempPassword = () => crypto.randomBytes(12).toString("base64url");

const newId = () => crypto.randomBytes(9).toString("base64url");

function save(auth: AuthFile) {
  writeJson(FILE, auth);
  g.__paddockAuth = { auth, mtime: mtimeOf(FILE) };
}

/**
 * Load auth.json. On first start it is created with one admin from PADDOCK_USERNAME / PADDOCK_PASSWORD,
 * or with a random password printed to the log; either way it must be changed on first login.
 * Deleting auth.json and restarting resets every account the same way.
 */
export function loadAuth(): AuthFile {
  const mtime = mtimeOf(FILE);
  const cached = g.__paddockAuth;
  if (cached && mtime !== null && cached.mtime === mtime) return cached.auth;

  const stored = readJson<AuthFile | LegacyAuthFile>(FILE);
  if (stored && "users" in stored) {
    g.__paddockAuth = { auth: stored, mtime };
    return stored;
  }
  if (stored) {
    // Sessions now name the account by id, so whoever was signed in signs in once more.
    const { username, hash, must_change, secret, version } = stored;
    const auth: AuthFile = { secret, users: [{ id: newId(), username, role: "admin", hash, must_change, version }] };
    save(auth);
    return auth;
  }

  const username = process.env.PADDOCK_USERNAME || "admin";
  let password = process.env.PADDOCK_PASSWORD;
  if (!password) {
    password = tempPassword();
    console.log(`[llama-paddock] initial login: ${username} / ${password} (you'll be asked to change it)`);
  }
  const auth: AuthFile = {
    secret: crypto.randomBytes(32).toString("base64url"),
    users: [{ id: newId(), username, role: "admin", hash: hashPassword(password), must_change: true, version: 1 }],
  };
  save(auth);
  // a reset login starts without the old accounts' tokens
  pruneOrphans(new Set(auth.users.map((u) => u.id)));
  return auth;
}

/** Usernames are matched without regard to case, so "Admin" and "admin" can't be two accounts. */
const findUser = (auth: AuthFile, username: string) => auth.users.find((u) => u.username.toLowerCase() === username.toLowerCase());

// Compared against when the username doesn't exist, so timing doesn't reveal which usernames do.
const dummyHash = () => (g.__paddockDummyHash ??= hashPassword(crypto.randomBytes(12).toString("base64url")));

export async function verifyLogin(username: string, password: string): Promise<UserInfo | null> {
  const user = findUser(loadAuth(), username);
  const ok = await matchesHash(password, user?.hash ?? dummyHash());
  return ok && user ? info(user) : null;
}

export async function checkPassword(username: string, password: string): Promise<boolean> {
  const user = findUser(loadAuth(), username);
  return !!user && (await matchesHash(password, user.hash));
}

/** Replace one user's stored entry; throws 404 when the account is gone. */
function updateUser(username: string, fn: (u: User) => User): User {
  const auth = loadAuth();
  const user = findUser(auth, username);
  if (!user) throw new HttpError(404, `no user "${username}"`);
  const next = fn(user);
  save({ ...auth, users: auth.users.map((u) => (u === user ? next : u)) });
  return next;
}

export function changePassword(username: string, password: string) {
  updateUser(username, (u) => ({ ...u, hash: hashPassword(password), must_change: false, version: u.version + 1 }));
}

// ============================================================================ user management
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

const info = (u: User): UserInfo => ({ username: u.username, role: u.role, must_change: u.must_change });

function checkRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
  return role as Role;
}

export const listUsers = (): UserInfo[] => loadAuth().users.map(info);

/** Returns the temporary password, the only time it is shown. */
export function addUser(username: string, role: unknown): string {
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "username: up to 64 letters, digits and . _ @ -, starting with a letter or digit");
  const r = checkRole(role);
  const auth = loadAuth();
  if (findUser(auth, username)) throw new HttpError(409, `user "${username}" already exists`);
  const password = tempPassword();
  save({ ...auth, users: [...auth.users, { id: newId(), username, role: r, hash: hashPassword(password), must_change: true, version: 1 }] });
  return password;
}

/** The user's tokens lose, for good, whatever the new role can't do. */
export function setRole(username: string, role: unknown): UserInfo {
  const r = checkRole(role);
  const user = updateUser(username, (u) => ({ ...u, role: r }));
  narrowCredentials(user.id, r);
  return info(user);
}

/** Signs the user out everywhere and returns a temporary password they must replace. */
export function resetPassword(username: string): string {
  const password = tempPassword();
  updateUser(username, (u) => ({ ...u, hash: hashPassword(password), must_change: true, version: u.version + 1 }));
  return password;
}

export function removeUser(username: string) {
  const auth = loadAuth();
  const user = findUser(auth, username);
  if (!user) throw new HttpError(404, `no user "${username}"`);
  save({ ...auth, users: auth.users.filter((u) => u !== user) });
  removeCredentialsOf(user.id);
}

// ============================================================================ sessions
export function createSession(username: string): string {
  const auth = loadAuth();
  const user = findUser(auth, username);
  if (!user) throw new HttpError(404, `no user "${username}"`);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = Buffer.from(JSON.stringify({ i: user.id, v: user.version, exp })).toString("base64url");
  return `${payload}.${sign(payload, auth.secret)}`;
}

/** The role comes from auth.json on every request, not from the cookie, so a role change applies at once. */
export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const auth = loadAuth();
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload, auth.secret))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const user = typeof p.i === "string" ? auth.users.find((u) => u.id === p.i) : undefined;
    if (!user || p.v !== user.version || p.exp < Date.now() / 1000) return null;
    return { username: user.username, role: user.role, mustChange: user.must_change };
  } catch {
    return null;
  }
}

/** Cookie attributes for a session token; Secure when the dashboard is reached over https. */
export function sessionCookie(req: Request, value: string, maxAge = SESSION_TTL) {
  const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  return { name: SESSION_COOKIE, value, httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge };
}

/** The signed-in admin, for routes that manage accounts. proxy.ts already refuses viewers; this is a second line. */
export function requireAdmin(req: { cookies: { get(name: string): { value: string } | undefined } }): Session {
  if (!authEnabled()) throw new HttpError(400, "login is disabled (PADDOCK_AUTH=off)");
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) throw new HttpError(401, "not signed in");
  if (session.role !== "admin") throw new HttpError(403, "your account is read-only");
  return session;
}

/** The signed-in user, for routes that only a browser session may use (managing tokens). */
export function requireSession(req: { cookies: { get(name: string): { value: string } | undefined } }): Session & { id: string } {
  if (!authEnabled()) throw new HttpError(400, "login is disabled (PADDOCK_AUTH=off)");
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) throw new HttpError(401, "not signed in");
  const user = findUser(loadAuth(), session.username)!;
  return { ...session, id: user.id };
}

/** Usernames by user id, to show who owns a credential. */
export const usernamesById = () => new Map(loadAuth().users.map((u) => [u.id, u.username]));

// ============================================================================ tokens
/** The token from `Authorization: Bearer …`, or undefined when the request has none. */
export function bearerToken(req: { headers: { get(name: string): string | null } }): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m?.[1];
}

export type TokenCheck =
  | { caller: Caller }
  /** guess: the token matches nothing stored, which counts towards the lockout. A known but expired or orphaned one doesn't. */
  | { caller: null; detail: string; guess: boolean };

/**
 * Like readSession, the user and role come from auth.json on every request. What the credential may do
 * is its own scopes cut down to what the role allows now, so it can never do more than its user.
 */
export function verifyToken(token: string, { record = true } = {}): TokenCheck {
  const cred = findByToken(token);
  if (!cred) return { caller: null, detail: "invalid token", guess: true };
  if (isExpired(cred)) return { caller: null, detail: "token expired", guess: false };
  const user = loadAuth().users.find((u) => u.id === cred.user);
  if (!user) return { caller: null, detail: "invalid token", guess: false };
  if (record) touch(cred.id);
  return {
    caller: {
      username: user.username,
      role: user.role,
      scopes: cred.scopes.filter((s) => ROLE_SCOPES[user.role].includes(s)),
      credential: { id: cred.id, kind: cred.kind, name: cred.name },
    },
  };
}

/** The caller of a request that proxy.ts already let in: the bearer token if there is one, else the session. */
export function currentCaller(req: { headers: { get(name: string): string | null }; cookies: { get(name: string): { value: string } | undefined } }): Caller | null {
  const token = bearerToken(req);
  if (token !== undefined) return verifyToken(token, { record: false }).caller;
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  return session && { username: session.username, role: session.role, scopes: [...ROLE_SCOPES[session.role]], credential: null };
}

/** Admins can't demote, reset or remove themselves, so there is always an admin left who can sign in. */
export function notSelf(session: Session, username: string, what: string) {
  if (username.toLowerCase() === session.username.toLowerCase()) throw new HttpError(400, `you can't ${what} your own account`);
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

type FailMap = Map<string, { n: number; until: number; last: number }>;

const lockedFor = (map: FailMap, ip: string) => {
  const f = map.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
};

/** Seconds until this address may try again (0 = allowed). */
export const loginLockedFor = (ip: string) => lockedFor(fails(), ip);

export function noteLoginFailure(ip: string) {
  globalFails().push(Date.now());
  noteFailure(fails(), ip);
}

export const clearLoginFailures = (ip: string) => fails().delete(ip);

/**
 * Failed bearer tokens lock out their address like failed logins, but on a separate count and with no
 * global ceiling: guessing a 256-bit secret is hopeless, and a script left running with a revoked
 * token must not lock everyone out of the login, or every other script out of the API.
 */
const tokenFails = () => (g.__paddockTokenFails ??= new Map());
export const tokenLockedFor = (ip: string) => lockedFor(tokenFails(), ip);
export const noteTokenFailure = (ip: string) => noteFailure(tokenFails(), ip);
export const clearTokenFailures = (ip: string) => tokenFails().delete(ip);

function noteFailure(map: FailMap, ip: string) {
  const now = Date.now();
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
