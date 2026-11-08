// ===== GGUF header reader
// The fit estimate needs a model's architecture (layers, attention heads, context) before it is
// pulled. GGUF keeps that in key/value metadata at the start of the file, so a few MB read with a
// Range request (or from the start of an uploaded file) is enough. Tensor data is never read.
import "server-only";

export interface GgufMeta {
  version: number;
  tensor_count: number;
  /** scalar metadata; strings longer than MAX_STRING are left out */
  kv: Record<string, string | number | boolean>;
  /** array metadata: its length, and the items when they are numbers (per-layer head counts) */
  arrays: Record<string, { length: number; numbers: number[] | null }>;
}

/** Thrown when the buffer ends before the metadata does: read more and parse again. */
class Incomplete extends Error {}

const MAX_STRING = 1024;
/** Numeric arrays longer than this (token types, scores) are only counted. */
const MAX_NUMBERS = 1024;

const NUM_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** Parse the metadata from the first bytes of a GGUF file. */
export function parseGguf(buf: Uint8Array): GgufMeta {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const need = (n: number) => {
    if (p + n > buf.byteLength) throw new Incomplete();
  };
  const u32 = () => (need(4), (p += 4), view.getUint32(p - 4, true));
  const u64 = () => (need(8), (p += 8), Number(view.getBigUint64(p - 8, true)));
  const str = (keep: boolean) => {
    const n = u64();
    need(n);
    const s = keep && n <= MAX_STRING ? new TextDecoder().decode(buf.subarray(p, p + n)) : null;
    p += n;
    return s;
  };
  const num = (type: number): number | boolean => {
    const size = NUM_SIZE[type];
    if (size === undefined) throw new Error(`unknown GGUF value type ${type}`);
    need(size);
    const at = p;
    p += size;
    switch (type) {
      case 0: return view.getUint8(at);
      case 1: return view.getInt8(at);
      case 2: return view.getUint16(at, true);
      case 3: return view.getInt16(at, true);
      case 4: return view.getUint32(at, true);
      case 5: return view.getInt32(at, true);
      case 6: return view.getFloat32(at, true);
      case 7: return view.getUint8(at) !== 0;
      case 10: return Number(view.getBigUint64(at, true));
      case 11: return Number(view.getBigInt64(at, true));
      default: return view.getFloat64(at, true);
    }
  };

  need(4);
  if (new TextDecoder().decode(buf.subarray(0, 4)) !== "GGUF") throw new Error("not a GGUF file");
  p = 4;
  const version = u32();
  if (version < 2) throw new Error(`GGUF version ${version} is too old`);
  const tensor_count = u64();
  const kvCount = u64();
  const meta: GgufMeta = { version, tensor_count, kv: {}, arrays: {} };
  for (let i = 0; i < kvCount; i++) {
    const key = str(true) ?? "";
    const type = u32();
    if (type === 8) {
      const s = str(true);
      if (s !== null) meta.kv[key] = s;
    } else if (type === 9) {
      const itemType = u32();
      const length = u64();
      let numbers: number[] | null = itemType !== 8 && itemType !== 9 && length <= MAX_NUMBERS ? [] : null;
      if (itemType === 8) {
        for (let j = 0; j < length; j++) str(false);
      } else if (itemType === 9) {
        throw new Error("nested GGUF arrays are not supported");
      } else {
        const size = NUM_SIZE[itemType];
        if (size === undefined) throw new Error(`unknown GGUF value type ${itemType}`);
        if (numbers) for (let j = 0; j < length; j++) numbers.push(Number(num(itemType)));
        else {
          need(size * length);
          p += size * length;
        }
      }
      if (numbers && !numbers.length) numbers = null;
      meta.arrays[key] = { length, numbers };
    } else {
      meta.kv[key] = num(type);
    }
  }
  return meta;
}

/**
 * Read the metadata through `read(offset, length)`, fetching more until it is complete. The
 * tokenizer's vocabulary is the bulk of it (a few MB); `maxBytes` stops a broken file from
 * downloading weights.
 */
export async function readGguf(read: (offset: number, length: number) => Promise<Uint8Array>, maxBytes = 64 * 1024 * 1024): Promise<GgufMeta> {
  let buf = new Uint8Array(0);
  let want = 4 * 1024 * 1024;
  for (;;) {
    const more = await read(buf.byteLength, want - buf.byteLength);
    const next = new Uint8Array(buf.byteLength + more.byteLength);
    next.set(buf);
    next.set(more, buf.byteLength);
    buf = next;
    try {
      return parseGguf(buf);
    } catch (e) {
      if (!(e instanceof Incomplete)) throw e;
      // a short read means the file ended
      if (more.byteLength === 0 || buf.byteLength < want) throw new Error("the GGUF file ends inside its metadata");
      if (want >= maxBytes) throw new Error(`GGUF metadata is larger than ${maxBytes / 1048576} MB`);
      want = Math.min(maxBytes, want * 2);
    }
  }
}

/** /api/show-style model_info from GGUF metadata: scalars as they are, numeric arrays as arrays. */
export function ggufModelInfo(meta: GgufMeta): Record<string, unknown> {
  const info: Record<string, unknown> = { ...meta.kv };
  for (const [k, a] of Object.entries(meta.arrays)) info[k] = a.numbers ?? null;
  // the vocabulary size, which /api/show leaves out with the token list
  // the vocabulary size, which few models state: the token list is too long to pass on
  const tokens = meta.arrays["tokenizer.ggml.tokens"];
  const arch = meta.kv["general.architecture"];
  if (tokens && typeof arch === "string" && info[`${arch}.vocab_size`] === undefined) info[`${arch}.vocab_size`] = tokens.length;
  return info;
}
