// Lectura de clientes/tarjetas y el "estado de tarjeta" que comparten
// la tarjeta web, Apple Wallet y Google Wallet.
import { config, lanAddresses } from "../config.js";
import { db } from "../db.js";
import { getSettings, formatMoney, ruleText } from "../settings.js";

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

export function describeTransaction(t, settings = getSettings()) {
  switch (t.type) {
    case "welcome":
      return "Bono de bienvenida";
    case "earn":
      return `Compra de ${formatMoney(t.amount, settings)}`;
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

export function programInfo() {
  const s = getSettings();
  return {
    businessName: s.businessName,
    programName: s.programName,
    tagline: s.tagline,
    primaryColor: s.primaryColor,
    accentColor: s.accentColor,
    textColor: s.textColor,
    logoUrl: logoPath(),
    locale: s.locale,
    currency: s.currency,
    phonePrefix: s.phonePrefix,
    rule: ruleText(s),
    welcomeBonus: s.welcomeBonus,
    contact: s.contact,
    termsText: s.termsText,
    promo: s.promo,
    rewards: activeRewards().map((r) => ({ id: r.id, name: r.name, description: r.description, cost: r.points_cost })),
  };
}

// Estado completo de la tarjeta para mostrar al cliente.
export function cardState(customer) {
  const rewards = activeRewards();
  return {
    serial: customer.serial,
    code: customer.code,
    name: customer.full_name,
    firstName: firstName(customer.full_name),
    points: customer.points,
    lifetimePoints: customer.lifetime_points,
    visits: customer.visits,
    memberSince: customer.created_at,
    next: nextReward(customer.points, rewards),
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      cost: r.points_cost,
      unlocked: customer.points >= r.points_cost,
      missing: Math.max(0, r.points_cost - customer.points),
    })),
    history: customerHistory(customer.id),
    updatedAt: customer.updated_at,
  };
}
