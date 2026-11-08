// Credentials that act for a user without a browser session (#84): API tokens now, and later the wall
// display's links (#11) and the gateway's client keys (#26), all in <data dir>/credentials.json.
// Used by proxy.ts through lib/auth.ts, so no "server-only".
//
// One record type for every kind, so display links and gateway keys get expiry, revocation, last-used,
// owner cleanup and role narrowing from here instead of growing token systems of their own. A
// credential's power is what both its scopes and its user's current role allow (see auth.ts, verifyToken).
import crypto from "node:crypto";
import type { Role } from "./auth";
import { HttpError } from "./http-error";
import { mtimeOf, readJson, writeJson } from "./store";

const FILE = "credentials.json";

// ============================================================================ kinds and scopes
export const KINDS = ["api", "display", "gateway"] as const;
export type CredentialKind = (typeof KINDS)[number];

/**
 * What a request needs (proxy.ts, requiredScope):
 * - api:read       GET on /api, and the POSTs that only read
 * - api:write      everything else on /api, except managing users, tokens and passwords (sessions only)
 * - display:read   the wall display's read-only feed (#11), and nothing else
 * - gateway:invoke the OpenAI-compatible /v1 gateway (M7), and nothing else
 */
export const SCOPES = ["api:read", "api:write", "display:read", "gateway:invoke"] as const;
export type Scope = (typeof SCOPES)[number];

/** The scopes a kind can carry. Kinds never overlap, so a display link can't be used as an API token or a gateway key. */
export const KIND_SCOPES: Record<CredentialKind, readonly Scope[]> = {
  api: ["api:read", "api:write"],
  display: ["display:read"],
  gateway: ["gateway:invoke"],
};

/**
 * The scopes a role can hold. Checked when a credential is created and on every request, and a role
 * change removes the rest for good (narrowCredentials). Viewers don't get the gateway yet: running
 * models changes what is loaded on a host, and granting it later is a widening, not a break.
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  admin: SCOPES,
  viewer: ["api:read", "display:read"],
};

/** Kinds that can be created now. Display links and gateway keys arrive with their pages and routes. */
export const CREATABLE_KINDS: readonly CredentialKind[] = ["api"];

export const MAX_PER_USER = 50;
const MAX_NAME = 64;
/** last_used is written at most this often per credential, so a busy script doesn't rewrite the file on every request. */
const TOUCH_EVERY_S = 60;

// ============================================================================ storage
export interface Credential {
  /** Public, never reused: part of the token, shown in the UI, and the key for audit records and gateway usage. */
  id: string;
  kind: CredentialKind;
  /** The owning user's id from auth.json. A credential whose user is gone is dead. */
  user: string;
  name: string;
  scopes: Scope[];
  /** sha256 of the secret part of the token. The secret is 256 random bits, so a slow hash adds nothing. */
  hash: string;
  /** Unix seconds. */
  created: number;
  expires: number | null;
  last_used: number | null;
}

interface CredentialsFile {
  version: 1;
  credentials: Credential[];
}

const g = globalThis as unknown as { __paddockCreds?: { file: CredentialsFile; mtime: number | null } };

function load(): CredentialsFile {
  const mtime = mtimeOf(FILE);
  const cached = g.__paddockCreds;
  if (cached && cached.mtime === mtime) return cached.file;
  const file = readJson<CredentialsFile>(FILE) ?? { version: 1, credentials: [] };
  g.__paddockCreds = { file, mtime };
  return file;
}

function save(credentials: Credential[]) {
  const file: CredentialsFile = { version: 1, credentials };
  writeJson(FILE, file);
  g.__paddockCreds = { file, mtime: mtimeOf(FILE) };
}

// ============================================================================ tokens
// paddock_<id: 16 hex>_<secret: 43 base64url>. The fixed prefix makes a leaked token easy to recognise
// (and to add to secret scanners); the id finds the record without comparing against every hash.
const TOKEN_RE = /^paddock_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

const digest = (secret: string) => `sha256$${crypto.createHash("sha256").update(secret).digest("hex")}`;

const nowS = () => Math.floor(Date.now() / 1000);

export const isExpired = (c: Credential, now = nowS()) => c.expires !== null && c.expires <= now;

/** The stored credential this token is for, or null when it names none or the secret doesn't match. */
export function findByToken(token: string): Credential | null {
  const m = TOKEN_RE.exec(token);
  // compare against something either way, so timing doesn't reveal which ids exist
  const cred = m ? load().credentials.find((c) => c.id === m[1]) : undefined;
  const want = Buffer.from(cred?.hash ?? digest("missing"));
  const got = Buffer.from(digest(m?.[2] ?? ""));
  const ok = want.length === got.length && crypto.timingSafeEqual(want, got);
  return ok && cred ? cred : null;
}

/** Record use, at most once a minute per credential. */
export function touch(id: string) {
  const now = nowS();
  const list = load().credentials;
  const c = list.find((x) => x.id === id);
  if (!c || (c.last_used !== null && now - c.last_used < TOUCH_EVERY_S)) return;
  try {
    save(list.map((x) => (x === c ? { ...x, last_used: now } : x)));
  } catch (e) {
    // a read-only data directory must not turn into failed API calls
    console.warn(`[llama-paddock] can't record token use: ${e instanceof Error ? e.message : e}`);
  }
}

// ============================================================================ management
export interface NewCredential {
  kind: CredentialKind;
  user: string;
  role: Role;
  name: unknown;
  scopes: unknown;
  /** Days until it expires; null for never. */
  expiresDays: unknown;
}

function checkScopes(kind: CredentialKind, role: Role, scopes: unknown): Scope[] {
  if (!Array.isArray(scopes) || !scopes.length) throw new HttpError(400, "scopes: a non-empty list");
  const list = [...new Set(scopes.map(String))];
  for (const s of list) {
    if (!KIND_SCOPES[kind].includes(s as Scope)) throw new HttpError(400, `a ${kind} token can't have the scope "${s}" (allowed: ${KIND_SCOPES[kind].join(", ")})`);
    if (!ROLE_SCOPES[role].includes(s as Scope)) throw new HttpError(403, `your ${role} role can't grant "${s}"`);
  }
  return list as Scope[];
}

function checkExpiry(days: unknown): number | null {
  if (days === null || days === undefined || days === "") return null;
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new HttpError(400, "expires_days: whole days from 1 to 3650, or null for never");
  return nowS() + n * 86400;
}

/** Returns the token, the only time it exists outside the client that receives it. */
export function createCredential(x: NewCredential): { token: string; credential: Credential } {
  if (!CREATABLE_KINDS.includes(x.kind)) throw new HttpError(400, `${x.kind} tokens can't be created yet`);
  const name = String(x.name ?? "").trim();
  if (!name || name.length > MAX_NAME) throw new HttpError(400, `name: 1 to ${MAX_NAME} characters`);
  const scopes = checkScopes(x.kind, x.role, x.scopes);
  const expires = checkExpiry(x.expiresDays);
  const list = load().credentials;
  if (list.filter((c) => c.user === x.user).length >= MAX_PER_USER) throw new HttpError(409, `at most ${MAX_PER_USER} tokens per user; revoke some first`);

  let id: string;
  do id = crypto.randomBytes(8).toString("hex");
  while (list.some((c) => c.id === id));
  const secret = crypto.randomBytes(32).toString("base64url");
  const credential: Credential = {
    id, kind: x.kind, user: x.user, name, scopes, hash: digest(secret), created: nowS(), expires, last_used: null,
  };
  save([...list, credential]);
  return { token: `paddock_${id}_${secret}`, credential };
}

export const listCredentials = (filter?: (c: Credential) => boolean): Credential[] =>
  filter ? load().credentials.filter(filter) : load().credentials;

const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());

/** What the browser sees of a credential: never its hash. With `names` (user id → name), also its owner. */
export function tokenInfo(c: Credential, names?: Map<string, string>) {
  return {
    id: c.id, kind: c.kind, name: c.name, scopes: c.scopes,
    created: iso(c.created), expires: iso(c.expires), last_used: iso(c.last_used), expired: isExpired(c),
    ...(names ? { user: names.get(c.user) ?? null } : {}),
  };
}

export const getCredential = (id: string) => load().credentials.find((c) => c.id === id);

export function deleteCredential(id: string) {
  const list = load().credentials;
  if (!list.some((c) => c.id === id)) throw new HttpError(404, "no such token");
  save(list.filter((c) => c.id !== id));
}

/** A removed user's credentials go with them. */
export function removeCredentialsOf(user: string) {
  const list = load().credentials;
  if (list.some((c) => c.user === user)) save(list.filter((c) => c.user !== user));
}

/**
 * After a role change, drop the scopes the new role can't hold, for good: promoting the user again
 * doesn't bring them back. A credential left with no scope is removed.
 */
export function narrowCredentials(user: string, role: Role) {
  const list = load().credentials;
  let changed = false;
  const next: Credential[] = [];
  for (const c of list) {
    if (c.user !== user) {
      next.push(c);
      continue;
    }
    const scopes = c.scopes.filter((s) => ROLE_SCOPES[role].includes(s));
    if (scopes.length !== c.scopes.length) changed = true;
    if (scopes.length) next.push({ ...c, scopes });
  }
  if (changed) save(next);
}

/** Drop credentials whose user no longer exists, e.g. after auth.json was deleted to reset the login. */
export function pruneOrphans(userIds: Set<string>) {
  const list = load().credentials;
  if (list.some((c) => !userIds.has(c.user))) save(list.filter((c) => userIds.has(c.user)));
}
