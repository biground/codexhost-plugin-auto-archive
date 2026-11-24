import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

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

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createCanvas(width, height) {
  const data = Buffer.alloc(width * height * 4);
  function blendPixel(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= width || y >= height || a <= 0) return;
    const idx = (y * width + x) * 4;
    const alpha = a / 255;
    const inv = 1 - alpha;
    data[idx] = Math.round(r * alpha + data[idx] * inv);
    data[idx + 1] = Math.round(g * alpha + data[idx + 1] * inv);
    data[idx + 2] = Math.round(b * alpha + data[idx + 2] * inv);
    data[idx + 3] = Math.min(255, Math.round(a + data[idx + 3] * inv));
  }
  function fillRect(x0, y0, w, h, color) {
    const [r, g, b, a = 255] = color;
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
        blendPixel(x, y, r, g, b, a);
      }
    }
  }
  function fillRoundedRect(x0, y0, w, h, radius, color) {
    const [r, g, b, a = 255] = color;
    const rad = Math.min(radius, w / 2, h / 2);
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
        const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad));
        const cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad));
        const dist = Math.hypot(x - cx, y - cy);
        if (dist <= rad) {
          blendPixel(x, y, r, g, b, a);
        }
      }
    }
  }
  function drawLine(x1, y1, x2, y2, thickness, color) {
    const [r, g, b, a = 255] = color;
    const minX = Math.floor(Math.min(x1, x2) - thickness);
    const maxX = Math.ceil(Math.max(x1, x2) + thickness);
    const minY = Math.floor(Math.min(y1, y2) - thickness);
    const maxY = Math.ceil(Math.max(y1, y2) + thickness);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
        const px = x1 + t * dx;
        const py = y1 + t * dy;
        const dist = Math.hypot(x - px, y - py);
        if (dist <= thickness / 2) {
          blendPixel(x, y, r, g, b, a);
        }
      }
    }
  }
  return { width, height, data, blendPixel, fillRect, fillRoundedRect, drawLine };
}

function drawShield(canvas, cx, cy, scale, color) {
  const [r, g, b, a = 255] = color;
  const halfW = 36 * scale;
  const topY = cy - 42 * scale;
  const midY = cy + 2 * scale;
  const botY = cy + 44 * scale;
  for (let y = Math.floor(topY); y <= Math.ceil(botY); y++) {
    for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
      const dx = Math.abs(x - cx) / halfW;
      if (dx > 1) continue;
      const topCurve = topY + dx * 11 * scale;
      if (y < topCurve) continue;
      if (y <= midY) {
        canvas.blendPixel(x, y, r, g, b, a);
      } else {
        const t = (y - midY) / (botY - midY);
        const maxDx = Math.pow(Math.max(0, 1 - t), 0.72);
        if (dx <= maxDx) {
          canvas.blendPixel(x, y, r, g, b, a);
        }
      }
    }
  }
}

function buildIcon() {
  const c = createCanvas(128, 128);
  // Deep slate rounded square background with emerald gradient
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const rad = 28;
      const cx = Math.max(rad, Math.min(x, 127 - rad));
      const cy = Math.max(rad, Math.min(y, 127 - rad));
      if (Math.hypot(x - cx, y - cy) <= rad) {
        const t = (x + y) / 256;
        const r = Math.round(14 + 8 * t);
        const g = Math.round(32 + 34 * t);
        const b = Math.round(40 + 28 * t);
        c.blendPixel(x, y, r, g, b, 255);
      }
    }
  }
  // Subtle outer glow border
  drawShield(c, 64, 65, 0.92, [16, 163, 127, 255]);
  drawShield(c, 64, 65, 0.76, [18, 42, 46, 255]);
  // Archive box tray + check mark
  c.fillRoundedRect(46, 54, 36, 8, 3, [16, 163, 127, 255]);
  c.fillRoundedRect(49, 64, 30, 19, 4, [16, 163, 127, 220]);
  c.drawLine(56, 73, 62, 79, 4, [245, 255, 252, 255]);
  c.drawLine(62, 79, 73, 67, 4, [245, 255, 252, 255]);
  return encodePng(128, 128, c.data);
}

function buildPreview() {
  const c = createCanvas(760, 460);
  // Dark CodexHost workspace backdrop
  c.fillRect(0, 0, 760, 460, [17, 20, 25, 255]);
  // Sidebar
  c.fillRect(0, 0, 232, 460, [22, 26, 33, 255]);
  c.fillRect(232, 0, 1, 460, [44, 50, 62, 255]);

  // Sidebar rows
  const rows = [
    { y: 54, protected: true, active: true },
    { y: 102, protected: false, active: false },
    { y: 150, protected: true, active: false },
    { y: 198, protected: false, active: false },
    { y: 246, protected: false, active: false },
  ];
  for (const row of rows) {
    c.fillRoundedRect(12, row.y, 208, 38, 8, row.active ? [33, 41, 52, 255] : [26, 31, 39, 255]);
    c.fillRoundedRect(24, row.y + 13, 118, 10, 4, [180, 190, 205, 190]);
    if (row.protected) {
      drawShield(c, 168, row.y + 19, 0.19, [16, 163, 127, 255]);
    }
    // More "..." button dots
    c.fillRoundedRect(190, row.y + 17, 4, 4, 2, [150, 160, 175, 220]);
    c.fillRoundedRect(198, row.y + 17, 4, 4, 2, [150, 160, 175, 220]);
    c.fillRoundedRect(206, row.y + 17, 4, 4, 2, [150, 160, 175, 220]);
  }

  // Right management page cards
  c.fillRoundedRect(262, 28, 470, 86, 12, [24, 29, 37, 255]);
  drawShield(c, 292, 64, 0.36, [16, 163, 127, 255]);
  c.fillRoundedRect(320, 48, 190, 14, 5, [230, 236, 245, 235]);
  c.fillRoundedRect(320, 70, 290, 9, 4, [130, 142, 160, 200]);
  c.fillRoundedRect(634, 46, 82, 24, 12, [16, 163, 127, 55]);

  // 4 stat cards
  const statsColors = [
    [230, 236, 245, 230],
    [16, 185, 144, 255],
    [239, 98, 98, 255],
    [160, 172, 190, 220],
  ];
  for (let i = 0; i < 4; i++) {
    const x = 262 + i * 120;
    c.fillRoundedRect(x, 128, 110, 68, 10, [24, 29, 37, 255]);
    c.fillRoundedRect(x + 14, 142, 62, 8, 4, [130, 142, 160, 180]);
    c.fillRoundedRect(x + 14, 160, 42, 18, 5, statsColors[i]);
  }

  // Rules panel + session list
  c.fillRoundedRect(262, 212, 470, 188, 12, [24, 29, 37, 255]);
  c.fillRoundedRect(280, 232, 84, 26, 8, [16, 163, 127, 210]);
  c.fillRoundedRect(374, 232, 64, 26, 13, [38, 46, 58, 255]);
  c.fillRoundedRect(446, 232, 64, 26, 13, [16, 163, 127, 65]);
  c.fillRoundedRect(518, 232, 64, 26, 13, [38, 46, 58, 255]);

  for (let i = 0; i < 3; i++) {
    const y = 276 + i * 38;
    c.fillRoundedRect(280, y, 434, 30, 7, [18, 22, 29, 255]);
    c.fillRoundedRect(292, y + 10, 180, 9, 4, [210, 218, 230, 200]);
    c.fillRoundedRect(618, y + 6, 84, 18, 6, i === 0 ? [16, 163, 127, 70] : [42, 50, 62, 255]);
  }

  // Floating bottom-right widget pill
  c.fillRoundedRect(584, 412, 152, 32, 16, [28, 34, 44, 255]);
  drawShield(c, 603, 428, 0.18, [16, 163, 127, 255]);
  c.fillRoundedRect(620, 424, 72, 8, 4, [215, 224, 235, 220]);
  c.fillRoundedRect(706, 420, 20, 16, 8, [239, 98, 98, 230]);

  // Open "More" dropdown menu layered on top with "Keep from Auto-Archive" highlight
  c.fillRoundedRect(138, 92, 214, 152, 12, [14, 18, 24, 240]);
  c.fillRoundedRect(140, 94, 210, 148, 12, [31, 37, 48, 255]);
  c.fillRoundedRect(148, 104, 194, 28, 7, [42, 50, 64, 150]);
  c.fillRoundedRect(160, 114, 96, 8, 4, [185, 195, 210, 210]);
  c.fillRoundedRect(148, 138, 194, 28, 7, [42, 50, 64, 110]);
  c.fillRoundedRect(160, 148, 84, 8, 4, [185, 195, 210, 190]);
  // Separator
  c.fillRect(152, 172, 186, 1, [66, 76, 92, 255]);
  // Highlighted "Keep from Auto-Archive" menu item
  c.fillRoundedRect(148, 179, 194, 30, 7, [16, 163, 127, 52]);
  drawShield(c, 165, 194, 0.19, [16, 185, 144, 255]);
  c.fillRoundedRect(180, 190, 108, 8, 4, [22, 218, 170, 255]);
  c.fillRoundedRect(306, 186, 28, 16, 8, [16, 163, 127, 110]);
  // Archive menu item below
  c.fillRoundedRect(148, 213, 194, 22, 6, [42, 50, 64, 90]);
  c.fillRoundedRect(160, 220, 76, 8, 4, [160, 170, 186, 185]);

  return encodePng(760, 460, c.data);
}

const root = path.resolve(import.meta.dirname, "..");
const assetsDir = path.join(root, "assets");
await mkdir(assetsDir, { recursive: true });
await writeFile(path.join(assetsDir, "icon.png"), buildIcon());
await writeFile(path.join(assetsDir, "preview-page.png"), buildPreview());
console.log("Generated assets/icon.png and assets/preview-page.png");
