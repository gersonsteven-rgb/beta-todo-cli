// Google Wallet: enlace "Guardar en Google Wallet" (JWT firmado) y
// actualización de puntos/promociones vía Wallet API REST.
// Requiere cuenta de emisor en Google Pay & Wallet Console + cuenta de servicio (ver README).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT, config } from "../config.js";
import { db } from "../db.js";
import { getSettings, ruleText, shortQty } from "../settings.js";
import { cardState, baseUrl, logoPath, coverPath } from "../services/cards.js";

const cfg = config.google;
const API = "https://walletobjects.googleapis.com/walletobjects/v1";

let keyCache = null;
function serviceAccount() {
  if (!keyCache) keyCache = JSON.parse(fs.readFileSync(cfg.keyFile, "utf8"));
  return keyCache;
}

export function status() {
  const missing = [];
  if (!cfg.issuerId) missing.push("GOOGLE_WALLET_ISSUER_ID");
  if (!fs.existsSync(cfg.keyFile)) missing.push(`GOOGLE_WALLET_KEY_FILE → ${path.relative(ROOT, cfg.keyFile)}`);
  const warnings = [];
  if (!cfg.logoUrl && !baseUrl().startsWith("https://")) {
    warnings.push("Google descarga el logo desde internet: definí una URL pública https (túnel) o GOOGLE_WALLET_LOGO_URL.");
  }
  return { enabled: missing.length === 0, missing, warnings };
}

const classId = () => `${cfg.issuerId}.${cfg.classSuffix}`;
// Los ids de objeto solo admiten letras, números, '.', '_' y '-'.
const objectId = (customer) => `${cfg.issuerId}.${customer.serial.replace(/[^\w.-]/g, "_")}`;

function signJwt(payload) {
  const key = serviceAccount();
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc(header)}.${enc(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key).toString("base64url");
  return `${unsigned}.${signature}`;
}

export function loyaltyClass() {
  const s = getSettings();
  const logoUri = cfg.logoUrl || `${baseUrl()}${logoPath()}`;
  const cls = {
    id: classId(),
    issuerName: s.businessName,
    programName: s.programName,
    programLogo: { sourceUri: { uri: logoUri }, contentDescription: { defaultValue: { language: "es", value: s.businessName } } },
    hexBackgroundColor: s.primaryColor,
    countryCode: s.countryCode,
    reviewStatus: "UNDER_REVIEW",
    multipleDevicesAndHoldersAllowedStatus: "ONE_USER_ALL_DEVICES",
    textModulesData: [{ id: "how", header: "¿Cómo funciona?", body: `${ruleText(s)}. Mostrá tu código en caja en cada compra.` }],
  };
  const cover = coverPath();
  if (cover) cls.heroImage = { sourceUri: { uri: `${baseUrl()}${cover}` } };
  const { latitude, longitude } = s.location || {};
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) cls.locations = [{ latitude, longitude }];
  return JSON.parse(JSON.stringify(cls));
}

export function loyaltyObject(customer) {
  const s = getSettings();
  const state = cardState(customer);
  const available = state.rewards.filter((r) => r.unlocked);
  const textModulesData = [
    {
      id: "next",
      header: "Próximo premio",
      body: state.next ? `${state.next.name} — te faltan ${shortQty(state.next.missing, s)}` : "¡Tenés todos los premios desbloqueados!",
    },
    {
      id: "available",
      header: "Premios disponibles",
      body: available.length ? available.map((r) => r.name).join(", ") : "Todavía ninguno. ¡Seguí sumando!",
    },
    { id: "catalog", header: "Catálogo", body: state.rewards.map((r) => `${shortQty(r.cost, s)} — ${r.name}`).join("\n") || "Próximamente" },
  ];
  if (state.promo) textModulesData.unshift({ id: "promo", header: state.promo.title, body: state.promo.message });
  return {
    id: objectId(customer),
    classId: classId(),
    state: "ACTIVE",
    accountId: customer.code,
    accountName: customer.full_name,
    loyaltyPoints:
      s.cardType === "stamps"
        ? { label: "Sellos", balance: { string: `${state.stamps.filled} de ${state.stamps.goal}` } }
        : { label: "Puntos", balance: { int: state.points } },
    secondaryLoyaltyPoints: state.tier
      ? { label: "Nivel", balance: { string: state.tier.name } }
      : { label: "Visitas", balance: { int: state.visits } },
    barcode: { type: "QR_CODE", value: customer.code, alternateText: customer.code },
    textModulesData,
    linksModuleData: { uris: [{ id: "web", uri: `${baseUrl()}/tarjeta/${customer.serial}`, description: "Ver mi tarjeta web" }] },
  };
}

export function saveUrl(customer) {
  const key = serviceAccount();
  const jwt = signJwt({
    iss: key.client_email,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [],
    payload: { loyaltyClasses: [loyaltyClass()], loyaltyObjects: [loyaltyObject(customer)] },
  });
  db.prepare("UPDATE customers SET google_clicked = 1 WHERE id = ?").run(customer.id);
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

// ---- API REST ----

let token = { value: null, exp: 0 };
async function accessToken() {
  if (token.value && token.exp > Date.now() + 60_000) return token.value;
  const key = serviceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/wallet_object.issuer",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  token = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function api(method, pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google Wallet ${method} ${pathname} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function upsertClass() {
  if (!status().enabled) return;
  const cls = loyaltyClass();
  const existing = await api("GET", `/loyaltyClass/${cls.id}`);
  if (existing) await api("PUT", `/loyaltyClass/${cls.id}`, cls);
  else await api("POST", "/loyaltyClass", cls);
}

// Solo existe en Google si el cliente ya la guardó; si no, la API responde 404 y se ignora.
export async function updateObject(customer) {
  if (!status().enabled || !customer.google_clicked) return;
  await api("PUT", `/loyaltyObject/${objectId(customer)}`, loyaltyObject(customer));
}

export async function updateAllObjects() {
  if (!status().enabled) return;
  const customers = db.prepare("SELECT * FROM customers WHERE google_clicked = 1").all();
  for (const c of customers) {
    try {
      await updateObject(c);
    } catch (err) {
      console.error("[google]", err.message);
    }
  }
}

export async function expireObject(customer) {
  if (!status().enabled || !customer.google_clicked) return;
  await api("PATCH", `/loyaltyObject/${objectId(customer)}`, { state: "INACTIVE" });
}

// Campaña: mensaje con notificación a cada destinatario que guardó la tarjeta.
// (Google limita a ~3 notificaciones por pase cada 24 h.)
export async function sendMessage(customers, promo) {
  if (!status().enabled) return;
  for (const c of customers.filter((x) => x.google_clicked)) {
    try {
      await updateObject(c);
      await api("POST", `/loyaltyObject/${objectId(c)}/addMessage`, {
        message: { id: `promo-${promo.id}`, header: promo.title, body: promo.message, messageType: "TEXT_AND_NOTIFY" },
      });
    } catch (err) {
      console.error("[google]", err.message);
    }
  }
}

export async function updateObjects(customers) {
  for (const c of customers) {
    try {
      await updateObject(c);
    } catch (err) {
      console.error("[google]", err.message);
    }
  }
}
