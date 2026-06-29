import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');
mkdirSync(assetsDir, { recursive: true });

// Morider mark — "Night Ride".
// A carbon tile lit from below by a molten headlight glow; a bold ember "M"
// drawn as a winding mountain-pass road. Reads as both the initial and a route.

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws the mark centered in a `size` box. `bleed` true fills the whole tile
// (app icon); false leaves the carbon plate floating (splash over bg).
function drawMark(ctx, size, { plate = true } = {}) {
  const s = size;

  if (plate) {
    // Carbon plate — vertical gradient, rounded for adaptive masks.
    const bg = ctx.createLinearGradient(0, 0, 0, s);
    bg.addColorStop(0, '#181C22');
    bg.addColorStop(0.55, '#101319');
    bg.addColorStop(1, '#0A0C0F');
    roundRectPath(ctx, 0, 0, s, s, s * 0.225);
    ctx.fillStyle = bg;
    ctx.fill();

    // Headlight glow from the lower third.
    const glow = ctx.createRadialGradient(s * 0.5, s * 0.74, 0, s * 0.5, s * 0.74, s * 0.6);
    glow.addColorStop(0, 'rgba(255,120,30,0.42)');
    glow.addColorStop(0.5, 'rgba(255,90,20,0.12)');
    glow.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.save();
    roundRectPath(ctx, 0, 0, s, s, s * 0.225);
    ctx.clip();
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s, s);
    // Subtle top sheen.
    const sheen = ctx.createLinearGradient(0, 0, 0, s * 0.4);
    sheen.addColorStop(0, 'rgba(255,255,255,0.06)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, s, s * 0.4);
    ctx.restore();
  }

  // The ember "M" as a continuous angular road. Stroke with rounded joins.
  const grad = ctx.createLinearGradient(0, s * 0.32, 0, s * 0.7);
  grad.addColorStop(0, '#FFC24A');
  grad.addColorStop(0.5, '#FF7A1A');
  grad.addColorStop(1, '#E8480A');

  const lw = s * 0.135;
  // Path points (normalised) describing M / twin peaks.
  const pts = [
    [0.255, 0.70],
    [0.255, 0.345],
    [0.5, 0.6],
    [0.745, 0.345],
    [0.745, 0.70],
  ].map(([x, y]) => [x * s, y * s]);

  // Glow underlay.
  ctx.save();
  ctx.shadowColor = 'rgba(255,110,26,0.85)';
  ctx.shadowBlur = s * 0.07;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();

  // Center "valley" dot — a headlight / waypoint accent.
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.6, lw * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = '#FFE6B0';
  ctx.shadowColor = 'rgba(255,200,90,0.9)';
  ctx.shadowBlur = s * 0.04;
  ctx.fill();
}

function icon(size) {
  const canvas = createCanvas(size, size);
  drawMark(canvas.getContext('2d'), size, { plate: true });
  return canvas.toBuffer('image/png');
}

function splash(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  // Solid carbon field (matches app.json splash backgroundColor).
  ctx.fillStyle = '#0B0D10';
  ctx.fillRect(0, 0, size, size);
  // Ambient ember glow behind the mark.
  const glow = ctx.createRadialGradient(size / 2, size * 0.46, 0, size / 2, size * 0.46, size * 0.42);
  glow.addColorStop(0, 'rgba(255,110,26,0.20)');
  glow.addColorStop(1, 'rgba(255,110,26,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Centered mark (no plate) at ~46% width.
  const m = size * 0.46;
  ctx.save();
  ctx.translate((size - m) / 2, size * 0.2);
  drawMark(ctx, m, { plate: false });
  ctx.restore();

  // Wordmark.
  ctx.fillStyle = '#F4F6F8';
  ctx.font = `900 ${size * 0.072}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // letterSpacing isn't supported; fake it by spacing characters.
  const word = 'MORIDER';
  const spaced = word.split('').join(' ');
  ctx.fillText(spaced, size / 2, size * 0.7);

  ctx.fillStyle = '#FF6A1A';
  ctx.font = `800 ${size * 0.03}px Arial`;
  ctx.fillText('S Ü R   ·   K A Y D E T   ·   P A Y L A Ş', size / 2, size * 0.76);
  return canvas.toBuffer('image/png');
}

writeFileSync(join(assetsDir, 'icon.png'), icon(1024));
console.log('✓ assets/icon.png (1024x1024)');

writeFileSync(join(assetsDir, 'adaptive-icon.png'), icon(1024));
console.log('✓ assets/adaptive-icon.png (1024x1024)');

writeFileSync(join(assetsDir, 'splash.png'), splash(2048));
console.log('✓ assets/splash.png (2048x2048)');
