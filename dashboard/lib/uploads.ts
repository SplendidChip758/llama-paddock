// ===== GGUF uploads (#29)
// A model can be created from a GGUF file on the admin's computer. Ollama takes the file as a blob
// named by its sha256, so the dashboard needs the whole file before it can send it: it arrives in
// chunks (each under Next.js's 10 MB limit for requests that pass the proxy), is kept in the data
// directory, hashed, sent to Ollama's /api/blobs and deleted. The GGUF header is kept in memory so
// the editor can estimate the fit before the model is created.
import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ggufModelInfo, readGguf } from "./gguf";
import { HttpError, getInstance, ollamaHeaders } from "./server";
import { dataFile } from "./store";

/** Under the 10 MB a request can carry through the proxy. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
/** An upload nobody has added to for this long is dropped, with its file. */
const STALE_MS = 60 * 60_000;
/** Free space to leave on the data directory's disk after the upload. */
const SPARE_BYTES = 512 * 1024 * 1024;

interface Upload {
  id: string;
  instance: string;
  filename: string;
  size: number;
  received: number;
  file: string;
  touched: number;
  /** set while the file is being hashed and sent to Ollama */
  finishing: boolean;
}

/** An uploaded GGUF that Ollama has: what the fit estimate and create need. */
export interface UploadedBlob {
  instance: string;
  digest: string;
  filename: string;
  size: number;
  model_info: Record<string, unknown>;
}

const g = globalThis as unknown as { __paddockUploads?: { open: Map<string, Upload>; blobs: Map<string, UploadedBlob>; swept: boolean } };
const state = (g.__paddockUploads ??= { open: new Map(), blobs: new Map(), swept: false });

const dir = () => dataFile("uploads");

function drop(u: Upload) {
  state.open.delete(u.id);
  fs.rmSync(/*turbopackIgnore: true*/ u.file, { force: true });
}

/** Remove stale uploads, and on the first call files left behind by an earlier run. */
function sweep() {
  for (const u of state.open.values()) if (!u.finishing && Date.now() - u.touched > STALE_MS) drop(u);
  if (state.swept) return;
  state.swept = true;
  try {
    for (const f of fs.readdirSync(/*turbopackIgnore: true*/ dir())) fs.rmSync(/*turbopackIgnore: true*/ path.join(dir(), f), { force: true });
  } catch {
    /* no uploads directory yet */
  }
}

/** A safe file name for the blob in the create request: Ollama only uses it to tell the files apart. */
function cleanName(name: unknown): string {
  const base = path.basename(String(name ?? "")).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  if (!/\.gguf$/i.test(base) || base.length < 6) throw new HttpError(400, "the file must be a .gguf file");
  return base.slice(-120);
}

export function startUpload(instance: string, filename: unknown, size: unknown): { id: string; chunk_size: number } {
  getInstance(instance);
  const n = Number(size);
  if (!Number.isSafeInteger(n) || n < 32) throw new HttpError(400, "size must be the file's size in bytes");
  const name = cleanName(filename);
  sweep();
  fs.mkdirSync(/*turbopackIgnore: true*/ dir(), { recursive: true, mode: 0o700 });
  const pending = [...state.open.values()].reduce((a, u) => a + u.size - u.received, 0);
  try {
    const st = fs.statfsSync(/*turbopackIgnore: true*/ dir());
    const free = st.bavail * st.bsize;
    if (free - pending < n + SPARE_BYTES) {
      throw new HttpError(507, `not enough free space in the dashboard's data directory for ${(n / 1e9).toFixed(1)} GB (it keeps the file until Ollama has it)`);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  const id = crypto.randomBytes(12).toString("hex");
  const file = path.join(dir(), `${id}.part`);
  fs.writeFileSync(/*turbopackIgnore: true*/ file, "", { mode: 0o600 });
  state.open.set(id, { id, instance, filename: name, size: n, received: 0, file, touched: Date.now(), finishing: false });
  return { id, chunk_size: CHUNK_SIZE };
}

function open(instance: string, id: string): Upload {
  const u = state.open.get(id);
  if (!u || u.instance !== instance) throw new HttpError(404, "no such upload; it may have expired");
  return u;
}

/** Append a chunk. `offset` must be what was received so far, so a retried chunk can't be written twice. */
export async function addChunk(instance: string, id: string, offset: number, chunk: Uint8Array): Promise<{ received: number; size: number }> {
  const u = open(instance, id);
  if (u.finishing) throw new HttpError(409, "the upload is already being finished");
  if (offset !== u.received) throw new HttpError(409, `expected the chunk at offset ${u.received}, got ${offset}`);
  if (!chunk.byteLength) throw new HttpError(400, "empty chunk");
  if (chunk.byteLength > CHUNK_SIZE) throw new HttpError(413, `chunks are at most ${CHUNK_SIZE} bytes`);
  if (u.received + chunk.byteLength > u.size) throw new HttpError(400, "more data than the file's size");
  if (offset === 0 && new TextDecoder().decode(chunk.subarray(0, 4)) !== "GGUF") {
    drop(u);
    throw new HttpError(400, "not a GGUF file");
  }
  await fs.promises.appendFile(/*turbopackIgnore: true*/ u.file, chunk);
  u.received += chunk.byteLength;
  u.touched = Date.now();
  return { received: u.received, size: u.size };
}

export function cancelUpload(instance: string, id: string) {
  const u = open(instance, id);
  if (!u.finishing) drop(u);
}

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(/*turbopackIgnore: true*/ file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Hash the complete file, read its GGUF header, and send it to Ollama. The file is deleted either way. */
export async function finishUpload(instance: string, id: string): Promise<UploadedBlob> {
  const u = open(instance, id);
  if (u.finishing) throw new HttpError(409, "the upload is already being finished");
  if (u.received !== u.size) throw new HttpError(409, `only ${u.received} of ${u.size} bytes have arrived`);
  u.finishing = true;
  try {
    const fd = await fs.promises.open(/*turbopackIgnore: true*/ u.file, "r");
    let meta;
    try {
      meta = await readGguf(async (offset, length) => {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fd.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      });
    } catch (e) {
      throw new HttpError(400, `can't read the GGUF file: ${(e as Error).message}`);
    } finally {
      await fd.close();
    }
    const digest = `sha256:${await sha256(u.file)}`;
    const inst = getInstance(instance);
    const url = `${inst.ollama_url}/api/blobs/${digest}`;
    // Ollama may have it already, from an earlier upload of the same file
    const head = await fetch(url, { method: "HEAD", headers: ollamaHeaders(inst, false), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (head?.status !== 200) {
      let r: Response;
      try {
        r = await fetch(url, {
          method: "POST",
          headers: { ...ollamaHeaders(inst, false), "Content-Type": "application/octet-stream", "Content-Length": String(u.size) },
          body: Readable.toWeb(fs.createReadStream(/*turbopackIgnore: true*/ u.file)) as ReadableStream,
          duplex: "half",
        } as RequestInit);
      } catch (e) {
        throw new HttpError(502, `sending the file to Ollama failed: ${(e as Error).message}`);
      }
      if (!r.ok) throw new HttpError(502, `Ollama refused the file (${r.status}): ${(await r.text()).slice(0, 300)}`);
    }
    const blob: UploadedBlob = { instance, digest, filename: u.filename, size: u.size, model_info: ggufModelInfo(meta) };
    state.blobs.set(`${instance}|${digest}`, blob);
    if (state.blobs.size > 200) state.blobs.delete(state.blobs.keys().next().value!);
    return blob;
  } finally {
    drop(u);
  }
}

/** A GGUF uploaded to this host through the dashboard since it started. */
export function uploadedBlob(instance: string, digest: string): UploadedBlob | null {
  return state.blobs.get(`${instance}|${digest}`) ?? null;
}
