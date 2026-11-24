import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const INCLUDE_ROOT_FILES = ["manifest.json", "README.md", "LICENSE"];
const INCLUDE_DIRS = ["assets", "shared", "backend", "page", "widget", "web", "desktop"];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date) {
  const dt = date instanceof Date ? date : new Date();
  const year = Math.max(1980, dt.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  const dosTime =
    (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
  return { dosTime, dosDate };
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { dosTime, dosDate } = dosTimeDate(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

async function collectFiles() {
  const files = [];
  for (const name of INCLUDE_ROOT_FILES) {
    const abs = path.join(ROOT, name);
    const info = await stat(abs);
    files.push({ name, data: await readFile(abs), mtime: info.mtime });
  }
  async function walk(relDir) {
    const absDir = path.join(ROOT, relDir);
    const items = await readdir(absDir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const rel = `${relDir}/${item.name}`;
      const abs = path.join(ROOT, rel);
      if (item.isDirectory()) {
        await walk(rel);
      } else if (item.isFile()) {
        const info = await stat(abs);
        files.push({ name: rel, data: await readFile(abs), mtime: info.mtime });
      }
    }
  }
  for (const dir of INCLUDE_DIRS) {
    await walk(dir);
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

const manifest = JSON.parse(await readFile(path.join(ROOT, "manifest.json"), "utf8"));
const entries = await collectFiles();
const zipBuffer = createZipBuffer(entries);
const distDir = path.join(ROOT, "dist");
await mkdir(distDir, { recursive: true });
const outFile = path.join(distDir, `${manifest.id}-${manifest.version}.zip`);
await writeFile(outFile, zipBuffer);

const hash = createHash("sha256").update(zipBuffer).digest("hex");
console.log(`Built: ${outFile}`);
console.log(`Size: ${zipBuffer.length} bytes (${entries.length} files)`);
console.log(`SHA-256: ${hash}`);
console.log("Files:", entries.map((e) => e.name).join(", "));
