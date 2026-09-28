// Configuración del negocio (marca, plan, reglas de puntos o sellos, niveles...).
// Los valores por defecto son el preset del piloto: Fusion Truck (Alajuela, CR).
import { db } from "./db.js";

// Planes comerciales (ver horaceroia.com/servicios/fidelizacion).
// Base: tarjeta en wallet, puntos/sellos, premios, panel, cajeros, exportación.
// Plata: + niveles, segmentación, campañas por segmento y panel avanzado.
export const PLANS = {
  base: { id: "base", name: "Base", tiers: false, segments: false, targetedCampaigns: false, advancedStats: false },
  plata: { id: "plata", name: "Plata", tiers: true, segments: true, targetedCampaigns: true, advancedStats: true },
};

export const DEFAULT_SETTINGS = {
  plan: "plata",
  businessName: "Fusion Truck",
  programName: "Club Fusion",
  tagline: "Las papas más cargadas de Alajuela, ahora con premios.",
  // Colores de la tarjeta (web, Apple Wallet y Google Wallet)
  primaryColor: "#D9481F",
  accentColor: "#FFC23D",
  textColor: "#FFFFFF",
  locale: "es-CR",
  timezone: "America/Costa_Rica",
  currency: { code: "CRC", decimals: 0 },
  countryCode: "CR",
  phonePrefix: "+506",
  // "points": tarjeta de puntos · "stamps": tarjeta de sellos (1 sello por compra)
  cardType: "points",
  // Puntos — mode "amount": `points` por cada `spend` gastado · mode "visit": `perVisit` por compra.
  pointsRule: { mode: "amount", spend: 1000, points: 1, perVisit: 1 },
  // Sellos — compra mínima para ganar un sello (0 = cualquier compra).
  stampRule: { minSpend: 0 },
  welcomeBonus: 5,
  // Niveles por puntos/sellos acumulados en la historia del cliente (plan Plata).
  // `bonus`: % extra de puntos en cada compra para ese nivel.
  tiers: [
    { name: "Clásico", min: 0, bonus: 0 },
    { name: "Oro", min: 50, bonus: 10 },
    { name: "VIP", min: 110, bonus: 20 },
  ],
  // Reglas de segmentación (plan Plata).
  segments: { newDays: 30, frequentVisits: 3, frequentDays: 30, inactiveDays: 30 },
  contact: {
    address: "50 m norte de la Iglesia La Agonía, Alajuela",
    hours: "Todos los días, 6:00 p. m. – 10:00 p. m.",
    whatsapp: "",
    instagram: "@fusion_truck_cr",
  },
  // Si se define, Apple Wallet muestra la tarjeta en la pantalla bloqueada al estar cerca.
  location: { latitude: null, longitude: null, relevantText: "¡Estás cerca! Mostrá tu tarjeta y sumá puntos." },
  termsText:
    "Programa de lealtad sin costo. Acumulás puntos por tus compras y los canjeás por premios del catálogo vigente. " +
    "Los puntos no son canjeables por dinero ni transferibles. Tus datos (nombre, correo y teléfono) se usan solo para " +
    "administrar el programa y, si lo autorizás, para enviarte promociones, conforme a la Ley 8968 de Protección de la " +
    "Persona frente al Tratamiento de sus Datos Personales. Podés solicitar la eliminación de tus datos en cualquier momento.",
  // Sobrescribe PUBLIC_URL (útil para pegar la URL de un túnel https durante el demo).
  publicUrl: "",
};

const KEY = "business";
let cache = null;

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function getSettings() {
  if (cache) return cache;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY);
  cache = deepMerge(DEFAULT_SETTINGS, row ? JSON.parse(row.value) : {});
  return cache;
}

export function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(KEY, JSON.stringify(next));
  cache = next;
  return next;
}

export function features(settings = getSettings()) {
  return PLANS[settings.plan] || PLANS.plata;
}

// ---- Unidades: puntos o sellos ----

export function units(settings = getSettings()) {
  return settings.cardType === "stamps"
    ? { one: "sello", many: "sellos", short: "sellos", label: "Sellos" }
    : { one: "punto", many: "puntos", short: "pts", label: "Puntos" };
}

export function qty(n, settings = getSettings()) {
  const u = units(settings);
  return `${n} ${Math.abs(n) === 1 ? u.one : u.many}`;
}

// Forma corta: "12 pts" o "1 sello" / "3 sellos".
export function shortQty(n, settings = getSettings()) {
  return settings.cardType === "stamps" ? qty(n, settings) : `${n} ${units(settings).short}`;
}

// ---- Dinero ----

export function minorFactor(settings = getSettings()) {
  return 10 ** (settings.currency.decimals || 0);
}

export function formatMoney(minor, settings = getSettings()) {
  const { code, decimals } = settings.currency;
  return new Intl.NumberFormat(settings.locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(minor / minorFactor(settings));
}

// ---- Niveles ----

export function tierFor(lifetime, settings = getSettings()) {
  if (!features(settings).tiers || !settings.tiers?.length) return null;
  const sorted = [...settings.tiers].sort((a, b) => a.min - b.min);
  let index = 0;
  sorted.forEach((t, i) => {
    if (lifetime >= t.min) index = i;
  });
  const current = sorted[index];
  const next = sorted[index + 1] || null;
  return {
    name: current.name,
    bonus: current.bonus || 0,
    index,
    isTop: !next && sorted.length > 1,
    next: next ? { name: next.name, min: next.min, missing: next.min - lifetime } : null,
  };
}

// ---- Cálculo de puntos/sellos por compra ----

export function purchasePoints(amountMinor, settings = getSettings(), tier = null) {
  if (settings.cardType === "stamps") {
    const min = (settings.stampRule?.minSpend || 0) * minorFactor(settings);
    return { base: amountMinor >= min ? 1 : 0, bonus: 0, total: amountMinor >= min ? 1 : 0 };
  }
  const rule = settings.pointsRule;
  let base = 0;
  if (rule.mode === "visit") base = Math.max(0, Math.floor(rule.perVisit));
  else {
    const spendMinor = rule.spend * minorFactor(settings);
    base = spendMinor > 0 ? Math.floor(amountMinor / spendMinor) * rule.points : 0;
  }
  const bonus = tier?.bonus ? Math.floor((base * tier.bonus) / 100) : 0;
  return { base, bonus, total: base + bonus };
}

export function pointsForPurchase(amountMinor, settings = getSettings(), tier = null) {
  return purchasePoints(amountMinor, settings, tier).total;
}

export function ruleText(settings = getSettings()) {
  if (settings.cardType === "stamps") {
    const min = settings.stampRule?.minSpend || 0;
    return min > 0 ? `1 sello por cada compra desde ${formatMoney(min * minorFactor(settings), settings)}` : "1 sello por cada compra";
  }
  const rule = settings.pointsRule;
  if (rule.mode === "visit") {
    return rule.perVisit === 1 ? "1 punto por cada compra" : `${rule.perVisit} puntos por cada compra`;
  }
  const pts = rule.points === 1 ? "1 punto" : `${rule.points} puntos`;
  return `${pts} por cada ${formatMoney(rule.spend * minorFactor(settings), settings)} de compra`;
}
