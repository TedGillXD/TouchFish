import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const green = [27, 166, 112];

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buffer) {
  let c = 0xffffffff;
  for (const value of buffer) c = crcTable[(c ^ value) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function ellipse(x, y, cx, cy, rx, ry) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}
function triangle(x, y, ax, ay, bx, by, cx, cy) {
  const sign = (px, py, qx, qy, rx, ry) =>
    (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const a = sign(x, y, ax, ay, bx, by);
  const b = sign(x, y, bx, by, cx, cy);
  const c = sign(x, y, cx, cy, ax, ay);
  return !((a < 0 || b < 0 || c < 0) && (a > 0 || b > 0 || c > 0));
}
function roundedSquare(x, y, radius) {
  if (x < 0.035 || y < 0.035 || x > 0.965 || y > 0.965) return false;
  const cx = Math.max(0.035 + radius, Math.min(x, 0.965 - radius));
  const cy = Math.max(0.035 + radius, Math.min(y, 0.965 - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
function fish(x, y, appIcon) {
  if (appIcon) {
    x = (x - 0.5) / 0.78 + 0.5;
    y = (y - 0.5) / 0.78 + 0.5;
  }
  const tail = triangle(x, y, 0.1, 0.28, 0.1, 0.72, 0.4, 0.5);
  const body = ellipse(x, y, 0.57, 0.5, 0.31, 0.255);
  const eye = ellipse(x, y, 0.715, 0.43, 0.029, 0.029);
  return (tail || body) && !eye;
}
function png(size, style = "app") {
  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  const samples = 3;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      let red = 0,
        grn = 0,
        blue = 0,
        alpha = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          if (style === "app") {
            if (!roundedSquare(px, py, 0.21)) continue;
            const color = fish(px, py, true) ? [255, 255, 255] : green;
            red += color[0];
            grn += color[1];
            blue += color[2];
            alpha++;
          } else if (fish(px, py, false)) {
            const color = style === "template" ? [0, 0, 0] : green;
            red += color[0];
            grn += color[1];
            blue += color[2];
            alpha++;
          }
        }
      const offset = row + 1 + x * 4;
      if (alpha) {
        scanlines[offset] = Math.round(red / alpha);
        scanlines[offset + 1] = Math.round(grn / alpha);
        scanlines[offset + 2] = Math.round(blue / alpha);
        scanlines[offset + 3] = Math.round((255 * alpha) / (samples * samples));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function generateIcons() {
  await mkdir(assets, { recursive: true });
  const icon256 = png(256);
  const icon512 = png(512);
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  icoHeader[8] = 0;
  icoHeader[9] = 0;
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(icon256.length, 14);
  icoHeader.writeUInt32LE(22, 18);
  const icns256 = Buffer.alloc(8);
  icns256.write("ic08");
  icns256.writeUInt32BE(icon256.length + 8, 4);
  const icns512 = Buffer.alloc(8);
  icns512.write("ic09");
  icns512.writeUInt32BE(icon512.length + 8, 4);
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns");
  icnsHeader.writeUInt32BE(
    8 + icns256.length + icon256.length + icns512.length + icon512.length,
    4,
  );
  await Promise.all([
    writeFile(join(assets, "icon.png"), icon512),
    writeFile(join(assets, "icon.ico"), Buffer.concat([icoHeader, icon256])),
    writeFile(
      join(assets, "icon.icns"),
      Buffer.concat([icnsHeader, icns256, icon256, icns512, icon512]),
    ),
    writeFile(join(assets, "tray.png"), png(32, "tray")),
    writeFile(join(assets, "trayTemplate.png"), png(16, "template")),
    writeFile(join(assets, "trayTemplate@2x.png"), png(32, "template")),
    writeFile(
      join(assets, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="3.5" y="3.5" width="93" height="93" rx="21" fill="#1ba670"/><g fill="white"><ellipse cx="55.5" cy="50" rx="24.2" ry="19.9"/><path d="M18.8 32.8v34.4L42.2 50z"/></g><circle cx="66.8" cy="44.5" r="2.3" fill="#1ba670"/></svg>\n',
    ),
  ]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await generateIcons();
