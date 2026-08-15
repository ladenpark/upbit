import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

async function generateIcons() {
  const svgPath = path.resolve('public/icon.svg');
  const svgBuffer = fs.readFileSync(svgPath);

  const sizes = [
    { name: 'icon-192.png', size: 192 },
    { name: 'icon-512.png', size: 512 },
    { name: 'icon-192-maskable.png', size: 192 },
    { name: 'icon-512-maskable.png', size: 512 },
    { name: 'apple-touch-icon.png', size: 180 },
    { name: 'favicon.png', size: 64 }
  ];

  for (const item of sizes) {
    const outPath = path.resolve('public', item.name);
    await sharp(svgBuffer)
      .resize(item.size, item.size)
      .png()
      .toFile(outPath);
    console.log(`Generated: ${item.name} (${item.size}x${item.size})`);
  }
  console.log('All PNG icons generated successfully!');
}

generateIcons();
