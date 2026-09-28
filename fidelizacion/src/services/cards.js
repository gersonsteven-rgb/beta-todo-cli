// Lectura de clientes/tarjetas y el "estado de tarjeta" que comparten
// la tarjeta web, Apple Wallet y Google Wallet.
import { config, lanAddresses } from "../config.js";
import { db } from "../db.js";
import { getSettings, formatMoney, ruleText, units, tierFor, features } from "../settings.js";
import { coverVersion } from "../wallet/images.js";

export function baseUrl() {
  const s = getSettings();
  if (s.publicUrl) return s.publicUrl.replace(/\/+$/, "");
  if (config.publicUrl) return config.publicUrl;
  const ip = lanAddresses()[0] || "localhost";
  return `http://${ip}:${config.port}`;
}

export function logoPath() {
  return "/media/logo.png";
}

export function coverPath() {
  const v = coverVersion();
  return v ? `/media/cover.png?v=${v}` : null;
}

export const getCustomerById = (id) => db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
export const getCustomerBySerial = (serial) => db.prepare("SELECT * FROM customers WHERE serial = ?").get(serial);
export const getCustomerByCode = (code) => db.prepare("SELECT * FROM customers WHERE code = ?").get(code);

export function activeRewards() {
  return db.prepare("SELECT * FROM rewards WHERE active = 1 ORDER BY points_cost, id").all();
}

export function firstName(fullName) {
  return String(fullName).trim().split(/\s+/)[0];
}

// Próximo premio que el cliente todavía no alcanza (o null si ya alcanza todos).
export function nextReward(points, rewards = activeRewards()) {
  const next = rewards.find((r) => r.points_cost > points);
  if (!next) return null;
  const prev = [...rewards].reverse().find((r) => r.points_cost <= points);
  const from = prev ? prev.points_cost : 0;
  return {
    id: next.id,
    name: next.name,
    cost: next.points_cost,
    missing: next.points_cost - points,
    progress: Math.min(1, Math.max(0, (points - from) / (next.points_cost - from))),
  };
}

// Tarjeta de sellos: cuántas casillas dibujar y dónde caen los premios.
export function stampCard(points, rewards = activeRewards()) {
  const costs = rewards.map((r) => r.points_cost);
  const max = costs.length ? Math.max(...costs) : 10;
  const goal = max <= 20 ? max : nextReward(points, rewards)?.cost || max;
  return { goal, filled: Math.min(points, goal), extra: Math.max(0, points - goal), marks: costs.filter((c) => c <= goal) };
}

// Texto compacto de sellos para las wallets: ●●●●○○○○○○
export function stampText(points, rewards = activeRewards()) {
  const { goal, filled } = stampCard(points, rewards);
  return goal <= 12 ? "●".repeat(filled) + "○".repeat(goal - filled) : `${filled} de ${goal}`;
}

export function describeTransaction(t, settings = getSettings()) {
  switch (t.type) {
    case "welcome":
      return "Bono de bienvenida";
    case "earn":
      return t.amount ? `Compra de ${formatMoney(t.amount, settings)}` : "Compra registrada";
    case "redeem":
      return `Canje: ${t.reward_name || "premio"}`;
    case "void":
      return `Anulación${t.note ? `: ${t.note}` : ""}`;
    default:
      return `Ajuste${t.note ? `: ${t.note}` : ""}`;
  }
}

export function customerHistory(customerId, limit = 10) {
  const settings = getSettings();
  return db
    .prepare("SELECT * FROM transactions WHERE customer_id = ? ORDER BY id DESC LIMIT ?")
    .all(customerId, limit)
    .map((t) => ({
      id: t.id,
      type: t.type,
      points: t.points,
      amount: t.amount,
      text: describeTransaction(t, settings),
      voided: Boolean(t.voided_by),
      createdAt: t.created_at,
    }));
}

// Promoción vigente para este cliente (la última campaña activa que le llegó).
export function currentPromoFor(customerId) {
  const p = db
    .prepare(
      `SELECT p.id, p.title, p.message, p.created_at FROM promotions p
       JOIN promotion_recipients r ON r.promotion_id = p.id
       WHERE r.customer_id = ? AND p.active = 1 ORDER BY p.id DESC LIMIT 1`
    )
    .get(customerId);
  return p ? { id: p.id, title: p.title, message: p.message, createdAt: p.created_at } : null;
}

export function vendorInfo() {
  return config.vendor.name ? { name: config.vendor.name, url: config.vendor.url } : null;
}

export function programInfo() {
  const s = getSettings();
  const f = features(s);
  return {
    businessName: s.businessName,
    programName: s.programName,
    tagline: s.tagline,
    primaryColor: s.primaryColor,
    accentColor: s.accentColor,
    textColor: s.textColor,
    logoUrl: logoPath(),
    coverUrl: coverPath(),
    locale: s.locale,
    currency: s.currency,
    phonePrefix: s.phonePrefix,
    cardType: s.cardType,
    units: units(s),
    rule: ruleText(s),
    welcomeBonus: s.welcomeBonus,
    tiers: f.tiers ? [...s.tiers].sort((a, b) => a.min - b.min) : [],
    contact: s.contact,
    termsText: s.termsText,
    vendor: vendorInfo(),
    rewards: activeRewards().map((r) => ({ id: r.id, name: r.name, description: r.description, cost: r.points_cost })),
  };
}

// Estado completo de la tarjeta para mostrar al cliente.
export function cardState(customer) {
  const s = getSettings();
  const rewards = activeRewards();
  return {
    serial: customer.serial,
    code: customer.code,
    name: customer.full_name,
    firstName: firstName(customer.full_name),
    cardType: s.cardType,
    units: units(s),
    points: customer.points,
    lifetimePoints: customer.lifetime_points,
    visits: customer.visits,
    memberSince: customer.created_at,
    tier: tierFor(customer.lifetime_points, s),
    next: nextReward(customer.points, rewards),
    stamps: s.cardType === "stamps" ? stampCard(customer.points, rewards) : null,
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      cost: r.points_cost,
      unlocked: customer.points >= r.points_cost,
      missing: Math.max(0, r.points_cost - customer.points),
    })),
    promo: currentPromoFor(customer.id),
    history: customerHistory(customer.id),
    updatedAt: customer.updated_at,
  };
}
