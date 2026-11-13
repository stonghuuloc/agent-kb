import fs from "node:fs";
import zlib from "node:zlib";

/**
 * Entries of a zip file whose name passes `want`, as { name, data } (data a Buffer). Stored and
 * deflated entries only, no zip64 or encryption: enough for Claude's data export. Throws on anything else.
 */
export function readZip(file, want = () => true) {
  const buf = fs.readFileSync(file);
  // End of central directory: the last "PK\x05\x06", within 64K of the end (comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file}: not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const zip64 = () => new Error(`${file}: zip64 is not supported`);
  if (p === 0xffffffff || count === 0xffff) throw zip64();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: bad central directory`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !want(name)) continue;
    if (size === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw zip64();
    if (flags & 1) throw new Error(`${file}: ${name} is encrypted`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${file}: bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, data: Buffer.from(body) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(body) });
    else throw new Error(`${file}: ${name} uses compression method ${method}`);
  }
  return out;
}
