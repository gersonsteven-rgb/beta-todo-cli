// Configuración del negocio (marca, reglas de puntos, contacto...).
// Los valores por defecto son el preset del piloto: Fusion Truck (Alajuela, CR).
import { db } from "./db.js";

export const DEFAULT_SETTINGS = {
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
  // mode "amount": `points` puntos por cada `spend` gastado.
  // mode "visit": `perVisit` puntos por compra (tipo tarjeta de sellos).
  pointsRule: { mode: "amount", spend: 1000, points: 1, perVisit: 1 },
  welcomeBonus: 5,
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
  // Promoción vigente (se muestra en la tarjeta y se envía a las wallets).
  promo: null,
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

export function resetSettingsCache() {
  cache = null;
}

// ---- Helpers de dinero y puntos ----

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

export function pointsForPurchase(amountMinor, settings = getSettings()) {
  const rule = settings.pointsRule;
  if (rule.mode === "visit") return Math.max(0, Math.floor(rule.perVisit));
  const spendMinor = rule.spend * minorFactor(settings);
  if (!(spendMinor > 0)) return 0;
  return Math.floor(amountMinor / spendMinor) * rule.points;
}

export function ruleText(settings = getSettings()) {
  const rule = settings.pointsRule;
  if (rule.mode === "visit") {
    return rule.perVisit === 1 ? "1 punto por cada compra" : `${rule.perVisit} puntos por cada compra`;
  }
  const pts = rule.points === 1 ? "1 punto" : `${rule.points} puntos`;
  return `${pts} por cada ${formatMoney(rule.spend * minorFactor(settings), settings)} de compra`;
}
