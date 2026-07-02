import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import exifr from 'exifr';
import session from 'express-session';
import bcrypt from 'bcryptjs';
const { compareSync } = bcrypt;
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = join(__dirname, 'uploads');
const THUMBS_DIR  = join(UPLOADS_DIR, 'thumbs');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR);
if (!existsSync(THUMBS_DIR))  mkdirSync(THUMBS_DIR);

const db = new DatabaseSync(join(__dirname, 'database.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    lat REAL,
    lng REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + '.jpg');
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

const secretPath = join(__dirname, '.session-secret');
const sessionSecret = existsSync(secretPath)
  ? readFileSync(secretPath, 'utf8').trim()
  : (() => {
      const s = randomBytes(32).toString('hex');
      writeFileSync(secretPath, s);
      return s;
    })();

const app = express();
app.set('trust proxy', 1); // trust the reverse proxy for secure cookies
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax' },
}));

function requireAdmin(req, res, next) {
  if (req.session?.adminId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.adminId = admin.id;
  req.session.username = admin.username;
  res.json({ ok: true, username: admin.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session?.adminId) {
    res.json({ admin: true, username: req.session.username });
  } else {
    res.json({ admin: false });
  }
});

app.post('/api/upload', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });

  let lat = null;
  let lng = null;

  try {
    const gps = await exifr.gps(req.file.path);
    if (gps) {
      lat = gps.latitude;
      lng = gps.longitude;
      console.log(`[gps] ${req.file.originalname} → from EXIF: ${lat}, ${lng}`);
    }
  } catch (err) {
    console.warn(`[exif] parse error for ${req.file.originalname}:`, err.message);
  }

  // Compress uploaded image to JPEG (runs after EXIF extraction so GPS data is already read)
  try {
    const tmp = req.file.path + '.tmp';
    await sharp(req.file.path)
      .rotate()
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toFile(tmp);
    renameSync(tmp, req.file.path);
  } catch (err) {
    console.warn(`[compress] ${req.file.originalname}: ${err.message}`);
  }

  // Generate thumbnail for the gallery grid
  try {
    await sharp(req.file.path)
      .resize(400, 400, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 75 })
      .toFile(join(THUMBS_DIR, req.file.filename));
  } catch (err) {
    console.warn(`[thumb] ${req.file.originalname}: ${err.message}`);
  }

  if (lat == null && req.body.lat && req.body.lng) {
    lat = parseFloat(req.body.lat);
    lng = parseFloat(req.body.lng);
    if (isNaN(lat) || isNaN(lng)) { lat = null; lng = null; }
    else console.log(`[gps] ${req.file.originalname} → from browser: ${lat}, ${lng}`);
  }

  if (lat == null) console.log(`[gps] ${req.file.originalname} → no coordinates`);

  const row = db
    .prepare('INSERT INTO images (filename, original_name, lat, lng) VALUES (?, ?, ?, ?)')
    .run(req.file.filename, req.file.originalname, lat, lng);

  res.json({ id: row.lastInsertRowid, filename: req.file.filename, lat, lng });
});

app.get('/api/images', (req, res) => {
  const images = db.prepare('SELECT * FROM images ORDER BY created_at DESC').all();
  res.json(images);
});

app.delete('/api/images/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const image = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!image) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM images WHERE id = ?').run(id);
  for (const path of [join(UPLOADS_DIR, image.filename), join(THUMBS_DIR, image.filename)]) {
    try { import('fs').then(({ unlinkSync }) => unlinkSync(path)); } catch {}
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sardigna running on http://0.0.0.0:${PORT}`);
});
