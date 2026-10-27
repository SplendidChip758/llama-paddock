// Small JSON files in the writable data directory (hosts added in the UI, login).
// No "server-only" here: proxy.ts imports this via lib/auth.ts and isn't bundled
// with the react-server condition that package relies on.
import fs from "node:fs";
import path from "node:path";

/** PADDOCK_DATA_DIR, or a "data" directory next to the config file. */
export function dataDir(): string {
  if (process.env.PADDOCK_DATA_DIR) return process.env.PADDOCK_DATA_DIR;
  return path.join(path.dirname(process.env.PADDOCK_CONFIG || "/config/config.yaml"), "data");
}

export const dataFile = (name: string) => path.join(dataDir(), name);

export function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ dataFile(name), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written file. Mode 600: these hold secrets. */
export function writeJson(name: string, value: unknown) {
  const dir = dataDir();
  fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
  const file = dataFile(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
}

export function mtimeOf(name: string): number | null {
  try {
    return fs.statSync(/*turbopackIgnore: true*/ dataFile(name)).mtimeMs;
  } catch {
    return null;
  }
}
