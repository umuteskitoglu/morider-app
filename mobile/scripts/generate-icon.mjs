import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');
mkdirSync(assetsDir, { recursive: true });

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#CC1F1F';
  ctx.fillRect(0, 0, size, size);

  // Rounded corner feel — dark inner shadow ring
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = size * 0.04;
  ctx.strokeRect(size * 0.02, size * 0.02, size * 0.96, size * 0.96);

  // "M" letter
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${size * 0.62}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('M', size / 2, size / 2 + size * 0.03);

  return canvas.toBuffer('image/png');
}

writeFileSync(join(assetsDir, 'icon.png'), drawIcon(1024));
console.log('✓ assets/icon.png (1024x1024)');

writeFileSync(join(assetsDir, 'splash.png'), drawIcon(2048));
console.log('✓ assets/splash.png (2048x2048)');
