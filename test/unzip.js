/* A minimal ZIP reader, so the tests can look inside a finished batch without
 * adding a dependency the tool itself does not need. Node has no built-in zip
 * reader, and pulling one in just for `npm test` would mean anyone checking out
 * the project has to install it before the tests run.
 *
 * Only handles what archiver produces: stored (0) and deflated (8) entries,
 * no encryption, no zip64. That is enough to read our own output and nothing
 * else, which is exactly the intent.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** @returns {{names: string[], read: (name: string) => Buffer}} */
export function openZip(zipPath) {
  const buf = fs.readFileSync(zipPath);

  /* The end-of-central-directory record sits at the very end, after a comment
     of unknown length, so it has to be found by scanning backwards. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`not a zip file: ${zipPath}`);

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);   // offset of the central directory

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`no such entry: ${name}`);
    /* The local header repeats the name and extra fields, and its extra field
       length can differ from the central one — so the data offset must be
       computed from the local header, not the central directory. */
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compressedSize);
    return e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
  };

  return { names: [...entries.keys()], read };
}
