// API del panel de administración (dueño y cajeros).
import fs from "node:fs";
import express from "express";
import QRCode from "qrcode";
import { db } from "../db.js";
import { clearSession, hashPassword, rateLimit, requireAuth, requireOwner, sessionUser, setSession, verifyPassword } from "../lib/auth.js";
import { normalizeCardCode } from "../lib/codes.js";
import { publish, publishAll, subscribe } from "../lib/events.js";
import { formatMoney, getSettings, minorFactor, ruleText, saveSettings } from "../settings.js";
import { adjust, deleteCustomer, earn, LoyaltyError, redeem, registerCustomer, voidTransaction } from "../services/loyalty.js";
import {
  activeRewards,
  baseUrl,
  customerHistory,
  describeTransaction,
  getCustomerByCode,
  getCustomerById,
  getCustomerBySerial,
  nextReward,
  programInfo,
} from "../services/cards.js";
import { wallet } from "../wallet/index.js";
import { UPLOADED_LOGO } from "../wallet/images.js";

export const router = express.Router();

// ---------- Sesión ----------

const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 8, message: "Demasiados intentos. Esperá un minuto." });

router.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim());
  if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Correo o contraseña incorrectos." });
  }
  setSession(req, res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.post("/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// Permite al panel saber si hay sesión sin provocar un 401.
router.get("/session", (req, res) => res.json({ authenticated: Boolean(sessionUser(req)) }));

router.use(requireAuth);

router.get("/me", (req, res) => {
  const s = getSettings();
  res.json({
    user: req.user,
    business: {
      businessName: s.businessName,
      programName: s.programName,
      primaryColor: s.primaryColor,
      accentColor: s.accentColor,
      textColor: s.textColor,
      locale: s.locale,
      timezone: s.timezone,
      currency: s.currency,
      pointsRule: s.pointsRule,
      rule: ruleText(s),
    },
  });
});

router.get("/stream", (req, res) => subscribe("admin", req, res));

// ---------- Vistas de cliente ----------

function adminCustomer(c, rewards = activeRewards()) {
  const s = getSettings();
  return {
    id: c.id,
    fullName: c.full_name,
    email: c.email,
    phone: c.phone,
    code: c.code,
    serial: c.serial,
    points: c.points,
    lifetimePoints: c.lifetime_points,
    visits: c.visits,
    totalSpent: c.total_spent,
    totalSpentText: formatMoney(c.total_spent, s),
    lastVisitAt: c.last_visit_at,
    createdAt: c.created_at,
    source: c.source,
    marketingOptIn: Boolean(c.marketing_opt_in),
    appleInstalled: Boolean(c.apple_installed),
    googleClicked: Boolean(c.google_clicked),
    next: nextReward(c.points, rewards),
    available: rewards.filter((r) => r.points_cost <= c.points).map((r) => ({ id: r.id, name: r.name, cost: r.points_cost })),
    cardUrl: `/tarjeta/${c.serial}`,
  };
}

function customerDetail(c) {
  const rewards = activeRewards();
  return {
    customer: adminCustomer(c, rewards),
    history: customerHistory(c.id, 100),
    rewards: rewards.map((r) => ({ id: r.id, name: r.name, cost: r.points_cost })),
  };
}

function mustCustomer(req) {
  const c = getCustomerById(Number(req.params.id));
  if (!c) throw new LoyaltyError("Cliente no encontrado.", 404);
  return c;
}

// Busca por lo que venga del escáner o del teclado: código, URL de tarjeta, teléfono, correo o nombre.
router.get("/lookup", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Escaneá o escribí un código." });

  const serial = q.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  const code = normalizeCardCode(q);
  let c = (serial && getCustomerBySerial(serial.toLowerCase())) || (code && getCustomerByCode(code));
  if (!c && q.includes("@")) c = db.prepare("SELECT * FROM customers WHERE email = ?").get(q.toLowerCase());
  if (c) return res.json(customerDetail(c));

  const digits = q.replace(/\D/g, "");
  let matches = [];
  if (digits.length >= 4 && digits.length === q.replace(/[\s()+-]/g, "").length) {
    matches = db.prepare("SELECT * FROM customers WHERE phone LIKE ? ORDER BY full_name LIMIT 10").all(`%${digits}`);
  } else if (q.length >= 2) {
    matches = db.prepare("SELECT * FROM customers WHERE full_name LIKE ? ORDER BY full_name LIMIT 10").all(`%${q}%`);
  }
  if (matches.length === 1) return res.json(customerDetail(matches[0]));
  if (!matches.length) return res.status(404).json({ error: `No encontramos ningún cliente con "${q}".` });
  res.json({ matches: matches.map((m) => adminCustomer(m)) });
});

router.get("/customers", (req, res) => {
  const search = String(req.query.search || "").trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const sorts = {
    recent: "created_at DESC",
    points: "points DESC",
    visits: "visits DESC",
    lastVisit: "last_visit_at IS NULL, last_visit_at DESC",
    name: "full_name COLLATE NOCASE",
  };
  const order = sorts[req.query.sort] || sorts.recent;
  const where = search ? "WHERE full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR code LIKE ?" : "";
  const params = search ? Array(4).fill(`%${search}%`) : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM customers ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const rewards = activeRewards();
  res.json({ total, customers: rows.map((c) => adminCustomer(c, rewards)) });
});

router.post("/customers", (req, res) => {
  const { customer, existing } = registerCustomer(req.body || {}, { source: "admin", userId: req.user.id });
  res.status(existing ? 200 : 201).json({ existing, ...customerDetail(customer) });
});

router.get("/customers/:id", (req, res) => res.json(customerDetail(mustCustomer(req))));

router.post("/customers/:id/earn", (req, res) => {
  const c = mustCustomer(req);
  const result = earn(c.id, req.body || {}, req.user.id);
  res.json({ points: result.points, ...customerDetail(result.customer) });
});

router.post("/customers/:id/redeem", (req, res) => {
  const c = mustCustomer(req);
  const result = redeem(c.id, Number(req.body?.rewardId), req.user.id);
  res.json({ reward: result.transaction.reward_name, ...customerDetail(result.customer) });
});

router.post("/customers/:id/adjust", requireOwner, (req, res) => {
  const c = mustCustomer(req);
  const result = adjust(c.id, req.body || {}, req.user.id);
  res.json(customerDetail(result.customer));
});

router.delete("/customers/:id", requireOwner, async (req, res) => {
  const c = mustCustomer(req);
  res.json(await deleteCustomer(c.id));
});

router.post("/transactions/:id/void", requireOwner, (req, res) => {
  const result = voidTransaction(Number(req.params.id), req.user.id);
  res.json(customerDetail(result.customer));
});

// ---------- Estadísticas ----------

function localDay(iso, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

router.get("/stats", (req, res) => {
  const s = getSettings();
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
  const since = new Date(Date.now() - (days + 1) * 86400e3).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const customers = one("SELECT COUNT(*) AS n, COALESCE(SUM(points), 0) AS outstanding FROM customers");
  const newWeek = one("SELECT COUNT(*) AS n FROM customers WHERE created_at >= ?", weekAgo).n;
  const wallets = one("SELECT SUM(apple_installed) AS apple, SUM(google_clicked) AS google FROM customers");
  const sales = one(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'earn' AND voided_by IS NULL AND created_at >= ?",
    since
  );
  const salesAll = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'earn' AND voided_by IS NULL");
  const issued = one(
    "SELECT COALESCE(SUM(points), 0) AS n FROM transactions WHERE points > 0 AND type != 'void' AND voided_by IS NULL AND created_at >= ?",
    since
  ).n;
  const redeems = one(
    "SELECT COUNT(*) AS n, COALESCE(-SUM(points), 0) AS points FROM transactions WHERE type = 'redeem' AND voided_by IS NULL AND created_at >= ?",
    since
  );
  const returning = one("SELECT SUM(visits >= 2) AS repeaters, SUM(visits >= 1) AS buyers FROM customers");

  // Serie diaria en la zona horaria del negocio.
  const series = new Map();
  for (let i = days - 1; i >= 0; i--) {
    series.set(localDay(new Date(Date.now() - i * 86400e3).toISOString(), s.timezone), { sales: 0, visits: 0, signups: 0, redeems: 0 });
  }
  for (const t of db.prepare("SELECT type, amount, created_at FROM transactions WHERE created_at >= ? AND voided_by IS NULL AND type IN ('earn','redeem')").all(since)) {
    const d = series.get(localDay(t.created_at, s.timezone));
    if (!d) continue;
    if (t.type === "earn") {
      d.sales += t.amount;
      d.visits += 1;
    } else d.redeems += 1;
  }
  for (const c of db.prepare("SELECT created_at FROM customers WHERE created_at >= ?").all(since)) {
    const d = series.get(localDay(c.created_at, s.timezone));
    if (d) d.signups += 1;
  }

  const activity = db
    .prepare(
      `SELECT t.*, c.full_name, c.points AS balance FROM transactions t JOIN customers c ON c.id = t.customer_id
       WHERE t.type != 'welcome' ORDER BY t.id DESC LIMIT 12`
    )
    .all()
    .map((t) => ({
      id: t.id,
      type: t.type,
      points: t.points,
      amount: t.amount,
      text: describeTransaction(t, s),
      customerId: t.customer_id,
      customerName: t.full_name,
      voided: Boolean(t.voided_by),
      createdAt: t.created_at,
    }));
  const signups = db
    .prepare("SELECT id, full_name, source, created_at, points FROM customers ORDER BY id DESC LIMIT 12")
    .all()
    .map((c) => ({
      id: `c${c.id}`,
      type: "signup",
      points: 0,
      amount: 0,
      text: `Nuevo cliente (${c.source === "admin" ? "registrado en caja" : c.source === "qr" ? "registro por QR" : "importado"})`,
      customerId: c.id,
      customerName: c.full_name,
      createdAt: c.created_at,
    }));
  const feed = [...activity, ...signups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);

  const top = db
    .prepare("SELECT * FROM customers ORDER BY lifetime_points DESC, visits DESC LIMIT 5")
    .all()
    .map((c) => ({ id: c.id, name: c.full_name, points: c.points, lifetimePoints: c.lifetime_points, visits: c.visits }));
  const popular = db
    .prepare(
      `SELECT reward_name AS name, COUNT(*) AS n FROM transactions WHERE type = 'redeem' AND voided_by IS NULL
       GROUP BY reward_name ORDER BY n DESC LIMIT 5`
    )
    .all();

  res.json({
    days,
    kpis: {
      customers: customers.n,
      newThisWeek: newWeek,
      outstandingPoints: customers.outstanding,
      salesCount: sales.n,
      salesTotal: sales.total,
      salesTotalText: formatMoney(sales.total, s),
      avgTicketText: formatMoney(sales.n ? Math.round(sales.total / sales.n) : 0, s),
      salesAllTotalText: formatMoney(salesAll.total, s),
      pointsIssued: issued,
      redemptions: redeems.n,
      pointsRedeemed: redeems.points,
      repeatRate: returning.buyers ? returning.repeaters / returning.buyers : 0,
      appleWallets: wallets.apple || 0,
      googleWallets: wallets.google || 0,
    },
    series: [...series].map(([date, v]) => ({ date, ...v })),
    activity: feed,
    top,
    popular,
  });
});

// ---------- Premios ----------

function rewardInput(body) {
  const name = String(body.name || "").trim();
  const cost = Math.trunc(Number(body.pointsCost));
  if (!name || name.length > 60) throw new LoyaltyError("El premio necesita un nombre (máx. 60 caracteres).");
  if (!(cost > 0) || cost > 1_000_000) throw new LoyaltyError("Los puntos deben ser un número mayor a 0.");
  return { name, description: String(body.description || "").trim().slice(0, 160), cost, active: body.active === false ? 0 : 1 };
}

function rewardsChanged() {
  publishAll("card:", "program", programInfo());
  wallet.programChanged();
}

const rewardView = (r) => ({ id: r.id, name: r.name, description: r.description, pointsCost: r.points_cost, active: Boolean(r.active) });

router.get("/rewards", (req, res) => {
  const rows = db.prepare("SELECT * FROM rewards ORDER BY active DESC, points_cost, id").all();
  const counts = Object.fromEntries(
    db.prepare("SELECT reward_id, COUNT(*) AS n FROM transactions WHERE type='redeem' AND voided_by IS NULL GROUP BY reward_id").all().map((r) => [r.reward_id, r.n])
  );
  res.json({ rewards: rows.map((r) => ({ ...rewardView(r), redeemed: counts[r.id] || 0 })) });
});

router.post("/rewards", requireOwner, (req, res) => {
  const r = rewardInput(req.body || {});
  const id = db.prepare("INSERT INTO rewards (name, description, points_cost, active) VALUES (?, ?, ?, ?)").run(r.name, r.description, r.cost, r.active).lastInsertRowid;
  rewardsChanged();
  res.status(201).json(rewardView(db.prepare("SELECT * FROM rewards WHERE id = ?").get(id)));
});

router.put("/rewards/:id", requireOwner, (req, res) => {
  const r = rewardInput(req.body || {});
  const info = db.prepare("UPDATE rewards SET name = ?, description = ?, points_cost = ?, active = ? WHERE id = ?").run(r.name, r.description, r.cost, r.active, Number(req.params.id));
  if (!info.changes) throw new LoyaltyError("Premio no encontrado.", 404);
  rewardsChanged();
  res.json(rewardView(db.prepare("SELECT * FROM rewards WHERE id = ?").get(Number(req.params.id))));
});

router.delete("/rewards/:id", requireOwner, (req, res) => {
  db.prepare("DELETE FROM rewards WHERE id = ?").run(Number(req.params.id));
  rewardsChanged();
  res.json({ ok: true });
});

// ---------- Promociones ----------

router.get("/promotions", (req, res) => {
  const rows = db.prepare("SELECT p.*, u.name AS user_name FROM promotions p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 30").all();
  const optIn = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE marketing_opt_in = 1").get().n;
  res.json({ current: getSettings().promo, history: rows, audience: { optIn, ...wallet.status() } });
});

router.post("/promotions", requireOwner, (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 40);
  const message = String(req.body?.message || "").trim().slice(0, 240);
  if (!title || !message) throw new LoyaltyError("La promoción necesita título y mensaje.");
  const id = Number(db.prepare("INSERT INTO promotions (title, message, user_id) VALUES (?, ?, ?)").run(title, message, req.user.id).lastInsertRowid);
  const promo = { id, title, message, createdAt: new Date().toISOString() };
  saveSettings({ promo });
  publishAll("card:", "promo", promo);
  wallet.promoSent(promo);
  res.status(201).json({ promo });
});

router.delete("/promotions/current", requireOwner, (req, res) => {
  saveSettings({ promo: null });
  publishAll("card:", "promo", null);
  wallet.programChanged();
  res.json({ ok: true });
});

// ---------- Configuración ----------

router.get("/settings", (req, res) => {
  res.json({ settings: getSettings(), baseUrl: baseUrl(), wallet: wallet.status(), customLogo: fs.existsSync(UPLOADED_LOGO) });
});

const HEX = /^#[0-9a-f]{6}$/i;
function text(v, max, label) {
  const s = String(v ?? "").trim();
  if (s.length > max) throw new LoyaltyError(`${label}: máximo ${max} caracteres.`);
  return s;
}
function num(v, { min = 0, max = 1e9, int = false, label }) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new LoyaltyError(`${label}: valor inválido.`);
  return n;
}

router.put("/settings", requireOwner, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ("businessName" in b) patch.businessName = text(b.businessName, 40, "Nombre del negocio") || "Mi negocio";
  if ("programName" in b) patch.programName = text(b.programName, 30, "Nombre del programa") || "Club";
  if ("tagline" in b) patch.tagline = text(b.tagline, 120, "Eslogan");
  for (const k of ["primaryColor", "accentColor", "textColor"]) {
    if (k in b) {
      if (!HEX.test(b[k])) throw new LoyaltyError("Los colores deben tener formato #RRGGBB.");
      patch[k] = b[k].toUpperCase();
    }
  }
  if ("locale" in b) patch.locale = text(b.locale, 10, "Idioma") || "es-CR";
  if ("timezone" in b) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: b.timezone });
    } catch {
      throw new LoyaltyError("Zona horaria inválida (ej. America/Costa_Rica).");
    }
    patch.timezone = b.timezone;
  }
  if ("currency" in b) {
    const code = String(b.currency?.code || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new LoyaltyError("Moneda inválida (código ISO de 3 letras, ej. CRC, USD).");
    patch.currency = { code, decimals: num(b.currency?.decimals ?? 0, { min: 0, max: 3, int: true, label: "Decimales" }) };
  }
  if ("countryCode" in b) patch.countryCode = text(b.countryCode, 2, "País").toUpperCase() || "CR";
  if ("phonePrefix" in b) {
    if (!/^\+\d{1,4}$/.test(b.phonePrefix)) throw new LoyaltyError("Prefijo telefónico inválido (ej. +506).");
    patch.phonePrefix = b.phonePrefix;
  }
  if ("pointsRule" in b) {
    const r = b.pointsRule || {};
    patch.pointsRule = {
      mode: r.mode === "visit" ? "visit" : "amount",
      spend: num(r.spend, { min: 0.01, label: "Monto por punto" }),
      points: num(r.points, { min: 1, max: 10000, int: true, label: "Puntos por monto" }),
      perVisit: num(r.perVisit, { min: 1, max: 10000, int: true, label: "Puntos por visita" }),
    };
  }
  if ("welcomeBonus" in b) patch.welcomeBonus = num(b.welcomeBonus, { min: 0, max: 100000, int: true, label: "Bono de bienvenida" });
  if ("contact" in b) {
    patch.contact = {
      address: text(b.contact?.address, 120, "Dirección"),
      hours: text(b.contact?.hours, 80, "Horario"),
      whatsapp: text(b.contact?.whatsapp, 20, "WhatsApp"),
      instagram: text(b.contact?.instagram, 40, "Instagram"),
    };
  }
  if ("location" in b) {
    const lat = b.location?.latitude, lng = b.location?.longitude;
    const has = lat !== "" && lat != null && lng !== "" && lng != null;
    patch.location = {
      latitude: has ? num(lat, { min: -90, max: 90, label: "Latitud" }) : null,
      longitude: has ? num(lng, { min: -180, max: 180, label: "Longitud" }) : null,
      relevantText: text(b.location?.relevantText, 80, "Texto de cercanía"),
    };
  }
  if ("termsText" in b) patch.termsText = text(b.termsText, 2000, "Términos");
  if ("publicUrl" in b) {
    const u = text(b.publicUrl, 200, "URL pública").replace(/\/+$/, "");
    if (u && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(u)) throw new LoyaltyError("La URL pública debe verse como https://mi-dominio.com (sin rutas).");
    patch.publicUrl = u;
  }
  const settings = saveSettings(patch);
  publishAll("card:", "program", programInfo());
  publish("admin", "settings", {});
  wallet.programChanged();
  res.json({ settings, baseUrl: baseUrl(), wallet: wallet.status() });
});

router.post("/settings/logo", requireOwner, (req, res) => {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(req.body?.dataUrl || ""));
  if (!m) throw new LoyaltyError("Subí el logo en formato PNG.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 1024 * 1024) throw new LoyaltyError("El logo debe pesar menos de 1 MB.");
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new LoyaltyError("El archivo no es un PNG válido.");
  }
  fs.writeFileSync(UPLOADED_LOGO, buf);
  publishAll("card:", "program", programInfo());
  wallet.programChanged();
  res.json({ ok: true });
});

router.delete("/settings/logo", requireOwner, (req, res) => {
  fs.rmSync(UPLOADED_LOGO, { force: true });
  publishAll("card:", "program", programInfo());
  wallet.programChanged();
  res.json({ ok: true });
});

// QR de registro (para imprimir y poner en caja).
router.get("/registration-qr", async (req, res) => {
  const url = `${baseUrl()}/registro`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  res.json({ url, svg, program: programInfo() });
});

// ---------- Usuarios del panel ----------

router.get("/users", requireOwner, (req, res) => {
  res.json({ users: db.prepare("SELECT id, name, email, role, created_at FROM users ORDER BY id").all() });
});

router.post("/users", requireOwner, (req, res) => {
  const name = text(req.body?.name, 60, "Nombre");
  const email = text(req.body?.email, 120, "Correo").toLowerCase();
  const password = String(req.body?.password || "");
  const role = req.body?.role === "owner" ? "owner" : "staff";
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new LoyaltyError("Nombre y correo válidos son obligatorios.");
  if (password.length < 6) throw new LoyaltyError("La contraseña debe tener al menos 6 caracteres.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new LoyaltyError("Ya existe un usuario con ese correo.", 409);
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)").run(name, email, hashPassword(password), role);
  res.status(201).json({ ok: true });
});

router.delete("/users/:id", requireOwner, (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new LoyaltyError("No podés eliminar tu propio usuario.");
  db.prepare("DELETE FROM users WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Exportación ----------

router.get("/export/customers.csv", requireOwner, (req, res) => {
  const s = getSettings();
  const cell = (v) => {
    const str = String(v ?? "");
    // Evita inyección de fórmulas al abrir en Excel.
    const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = ["Nombre", "Correo", "Teléfono", "Código", "Puntos", "Puntos históricos", "Visitas", "Total comprado", "Última visita", "Registro", "Acepta promociones"];
  const lines = [header.map(cell).join(",")];
  for (const c of db.prepare("SELECT * FROM customers ORDER BY created_at").all()) {
    lines.push(
      [c.full_name, c.email, c.phone, c.code, c.points, c.lifetime_points, c.visits, c.total_spent / minorFactor(s), c.last_visit_at || "", c.created_at, c.marketing_opt_in ? "Sí" : "No"]
        .map(cell)
        .join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="clientes.csv"');
  res.send("﻿" + lines.join("\r\n"));
});
