// Base de datos SQLite embebida (node:sqlite, sin dependencias nativas).
// Para producción/SaaS se puede migrar a PostgreSQL manteniendo el mismo esquema.
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Un cliente = una tarjeta de lealtad.
CREATE TABLE IF NOT EXISTS customers (
  id               INTEGER PRIMARY KEY,
  full_name        TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone            TEXT NOT NULL UNIQUE,
  serial           TEXT NOT NULL UNIQUE,   -- id público: URL de la tarjeta, serial Apple, objeto Google
  code             TEXT NOT NULL UNIQUE,   -- lo que lleva el QR y se puede digitar en caja
  auth_token       TEXT NOT NULL,          -- token del web service de Apple Wallet
  points           INTEGER NOT NULL DEFAULT 0,
  lifetime_points  INTEGER NOT NULL DEFAULT 0,
  visits           INTEGER NOT NULL DEFAULT 0,
  total_spent      INTEGER NOT NULL DEFAULT 0,  -- en unidades menores de la moneda
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  consent_at       TEXT,
  source           TEXT NOT NULL DEFAULT 'qr',
  apple_installed  INTEGER NOT NULL DEFAULT 0,
  google_clicked   INTEGER NOT NULL DEFAULT 0,
  last_visit_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE IF NOT EXISTS rewards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  points_cost INTEGER NOT NULL CHECK (points_cost > 0),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Libro mayor de puntos: el saldo del cliente siempre se puede reconstruir desde aquí.
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('welcome', 'earn', 'redeem', 'adjust', 'void')),
  amount      INTEGER NOT NULL DEFAULT 0,
  points      INTEGER NOT NULL,
  reward_id   INTEGER REFERENCES rewards(id) ON DELETE SET NULL,
  reward_name TEXT,
  note        TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_by   INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_customer ON transactions (customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_created  ON transactions (created_at);

-- Campañas/promociones. Se guarda a quién le llegó (solo clientes que aceptaron promociones).
CREATE TABLE IF NOT EXISTS promotions (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  segment    TEXT NOT NULL DEFAULT 'all',
  recipients INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS promotion_recipients (
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (promotion_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_recipients_customer ON promotion_recipients (customer_id);

-- Dispositivos Apple que instalaron un pase (para enviarles actualizaciones por APNs).
CREATE TABLE IF NOT EXISTS apple_registrations (
  device_id  TEXT NOT NULL,
  serial     TEXT NOT NULL REFERENCES customers(serial) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (device_id, serial)
);
`);

// Migraciones simples: columnas agregadas después de la primera versión.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("promotions", "segment", "TEXT NOT NULL DEFAULT 'all'");
addColumn("promotions", "recipients", "INTEGER NOT NULL DEFAULT 0");
addColumn("promotions", "active", "INTEGER NOT NULL DEFAULT 1");

export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const now = () => new Date().toISOString();
