// Autenticación del panel: contraseñas con scrypt y sesión en cookie firmada (HMAC).
import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

const COOKIE = "fid_session";
const SESSION_HOURS = 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function sign(value) {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSession(req, res, userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}

export function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function sessionUser(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!data.exp || data.exp < Date.now()) return null;
  return db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(data.uid) || null;
}

export function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: "Sesión expirada. Iniciá sesión de nuevo." });
  req.user = user;
  next();
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Solo el dueño puede hacer esto." });
  next();
}

// Límite simple en memoria (suficiente para una instancia por negocio).
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const nowMs = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < nowMs) {
      hits.set(key, { count: 1, reset: nowMs + windowMs });
      return next();
    }
    if (++entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}
