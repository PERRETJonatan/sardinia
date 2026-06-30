import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
const { hashSync } = bcrypt;
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(__dirname, 'database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )
`);

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: node add-admin.js <username> <password>');
  process.exit(1);
}

const hash = hashSync(password, 12);

const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(hash, username);
  console.log(`Password updated for admin "${username}".`);
} else {
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Admin "${username}" created.`);
}
