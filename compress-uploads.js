import sharp from 'sharp';
import { readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS = join(__dirname, 'uploads');
const MAX_PX = 2000;
const QUALITY = 82;
const JPEG_EXTS = new Set(['.jpg', '.jpeg']);

const db = new DatabaseSync(join(__dirname, 'database.sqlite'));

function fmt(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

const files = readdirSync(UPLOADS).filter(f =>
  /\.(jpe?g|png|webp|heic|heif|tiff?)$/i.test(f)
);

if (!files.length) {
  console.log('No images found in uploads/');
  process.exit(0);
}

console.log(`Compressing ${files.length} image(s) in uploads/...\n`);

let totalBefore = 0, totalAfter = 0, skipped = 0;

for (const file of files) {
  const src = join(UPLOADS, file);
  const ext = extname(file).toLowerCase();
  const isJpeg = JPEG_EXTS.has(ext);
  const destName = isJpeg ? file : basename(file, extname(file)) + '.jpg';
  const dest = join(UPLOADS, destName);
  const tmp = src + '.sharp.tmp';
  const before = statSync(src).size;

  try {
    await sharp(src)
      .rotate()
      .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, progressive: true })
      .toFile(tmp);

    renameSync(tmp, dest);
    const after = statSync(dest).size;
    totalBefore += before;
    totalAfter += after;
    const pct = Math.round((1 - after / before) * 100);

    if (!isJpeg) {
      unlinkSync(src);
      const { changes } = db.prepare('UPDATE images SET filename = ? WHERE filename = ?').run(destName, file);
      console.log(`  ${file} → ${destName}: ${fmt(before)} → ${fmt(after)} (-${pct}%, ${changes} DB row${changes !== 1 ? 's' : ''} updated)`);
    } else {
      console.log(`  ${file}: ${fmt(before)} → ${fmt(after)} (${pct > 0 ? `-${pct}%` : '±0%'})`);
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    skipped++;
    console.error(`  SKIP ${file}: ${err.message}`);
  }
}

const n = files.length - skipped;
if (n > 0 && totalBefore > 0) {
  const pct = Math.round((1 - totalAfter / totalBefore) * 100);
  console.log(`\n${n} image${n !== 1 ? 's' : ''} compressed: ${fmt(totalBefore)} → ${fmt(totalAfter)} (${pct > 0 ? `-${pct}%` : '±0%'} saved)`);
}
if (skipped > 0) console.log(`${skipped} skipped`);
