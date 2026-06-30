import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import exifr from 'exifr';
import session from 'express-session';
import bcrypt from 'bcryptjs';
const { compareSync } = bcrypt;
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { networkInterfaces } from 'os';
import selfsigned from 'selfsigned';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = join(__dirname, 'uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR);

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
    cb(null, unique + extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// Session secret — generated once and persisted
const secretPath = join(__dirname, '.session-secret');
const sessionSecret = existsSync(secretPath)
  ? readFileSync(secretPath, 'utf8').trim()
  : (() => {
      const s = randomBytes(32).toString('hex');
      writeFileSync(secretPath, s);
      return s;
    })();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax' },
}));

function requireAdmin(req, res, next) {
  if (req.session?.adminId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Auth routes
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

// Image routes
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

  res.json({
    id: row.lastInsertRowid,
    filename: req.file.filename,
    lat,
    lng,
  });
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
  try { import('fs').then(({ unlinkSync }) => unlinkSync(join(UPLOADS_DIR, image.filename))); } catch {}
  res.json({ ok: true });
});

// TLS setup
const CERT_DIR = join(__dirname, '.certs');
if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR);
const certPath = join(CERT_DIR, 'cert.pem');
const keyPath  = join(CERT_DIR, 'key.pem');

let tlsOptions;
if (existsSync(certPath) && existsSync(keyPath)) {
  tlsOptions = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
} else {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'sardigna.local' }], {
    days: 3650, keySize: 2048,
  });
  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private);
  tlsOptions = { cert: pems.cert, key: pems.private };
  console.log('Generated self-signed TLS certificate (.certs/)');
}

const HTTP_PORT  = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

createHttpServer((req, res) => {
  const host = req.headers.host?.replace(/:.*/, '');
  res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
  res.end();
}).listen(HTTP_PORT, '0.0.0.0');

createHttpsServer(tlsOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log('\nSardigna is running.');
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`\n  Open on your phone: https://${addr.address}:${HTTPS_PORT}`);
        console.log('  (Accept the certificate warning once — it\'s your own server)');
      }
    }
  }
  console.log();
});
