// Apple Wallet: generación del pase (.pkpass firmado) y avisos de actualización.
// Requiere cuenta Apple Developer: Pass Type ID + certificado (ver README).
import fs from "node:fs";
import path from "node:path";
import { PKPass } from "passkit-generator";
import { ROOT, config } from "../config.js";
import { db } from "../db.js";
import { getSettings, ruleText } from "../settings.js";
import { cardState, baseUrl } from "../services/cards.js";
import { passImages } from "./images.js";
import { pushPassUpdates } from "./apns.js";

const cfg = config.apple;

export function status() {
  const missing = [];
  if (!cfg.passTypeId) missing.push("APPLE_PASS_TYPE_ID");
  if (!cfg.teamId) missing.push("APPLE_TEAM_ID");
  for (const [name, file] of [
    ["APPLE_SIGNER_CERT", cfg.signerCert],
    ["APPLE_SIGNER_KEY", cfg.signerKey],
    ["APPLE_WWDR_CERT", cfg.wwdr],
  ]) {
    if (!fs.existsSync(file)) missing.push(`${name} → ${path.relative(ROOT, file)}`);
  }
  const warnings = [];
  if (!baseUrl().startsWith("https://")) {
    warnings.push("Sin URL pública https los pases se instalan pero no se actualizan solos (puntos, promociones).");
  }
  return { enabled: missing.length === 0, missing, warnings };
}

let certCache = null;
function certificates() {
  if (!certCache) {
    certCache = {
      wwdr: fs.readFileSync(cfg.wwdr),
      signerCert: fs.readFileSync(cfg.signerCert),
      signerKey: fs.readFileSync(cfg.signerKey),
      signerKeyPassphrase: cfg.signerKeyPassphrase || undefined,
    };
  }
  return certCache;
}

function rgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "rgb(0, 0, 0)";
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

export function passJson(customer) {
  const s = getSettings();
  const state = cardState(customer);
  const url = baseUrl();
  const available = state.rewards.filter((r) => r.unlocked);

  const backFields = [];
  if (s.promo) {
    backFields.push({ key: "promo", label: s.promo.title.toUpperCase(), value: s.promo.message, changeMessage: "%@" });
  }
  backFields.push(
    {
      key: "available",
      label: "PREMIOS DISPONIBLES",
      value: available.length ? available.map((r) => `• ${r.name}`).join("\n") : "Todavía ninguno. ¡Seguí sumando!",
    },
    {
      key: "catalog",
      label: "CATÁLOGO DE PREMIOS",
      value: state.rewards.map((r) => `${r.cost} pts — ${r.name}`).join("\n") || "Próximamente",
    },
    { key: "how", label: "¿CÓMO FUNCIONA?", value: `${ruleText(s)}. Mostrá este código en caja en cada compra.` },
    { key: "web", label: "TU TARJETA WEB", value: `${url}/tarjeta/${customer.serial}` },
    { key: "code", label: "CÓDIGO DE CLIENTE", value: customer.code }
  );
  if (s.contact.address || s.contact.hours) {
    backFields.push({ key: "contact", label: s.businessName.toUpperCase(), value: [s.contact.address, s.contact.hours].filter(Boolean).join("\n") });
  }
  backFields.push({ key: "terms", label: "TÉRMINOS", value: s.termsText });

  const json = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    serialNumber: customer.serial,
    organizationName: s.businessName,
    description: `Tarjeta de lealtad ${s.programName}`,
    logoText: s.programName,
    backgroundColor: rgb(s.primaryColor),
    foregroundColor: rgb(s.textColor),
    labelColor: rgb(s.accentColor),
    sharingProhibited: true,
    barcodes: [{ format: "PKBarcodeFormatQR", message: customer.code, messageEncoding: "iso-8859-1", altText: customer.code }],
    storeCard: {
      // El header es lo que se ve con las tarjetas apiladas en Wallet.
      headerFields: [{ key: "points", label: "PUNTOS", value: state.points, changeMessage: "Puntos disponibles: %@" }],
      primaryFields: [{ key: "member", label: "MIEMBRO", value: state.name }],
      secondaryFields: [
        { key: "next", label: "PRÓXIMO PREMIO", value: state.next ? state.next.name : "¡Todos desbloqueados!" },
        {
          key: "missing",
          label: state.next ? "TE FALTAN" : "DISPONIBLES",
          value: state.next ? `${state.next.missing} pts` : String(available.length),
          textAlignment: "PKTextAlignmentRight",
        },
      ],
      backFields,
    },
  };
  // Las actualizaciones automáticas solo funcionan con https.
  if (url.startsWith("https://")) {
    json.webServiceURL = `${url}/wallet/apple`;
    json.authenticationToken = customer.auth_token;
  }
  const { latitude, longitude, relevantText } = s.location || {};
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    json.locations = [{ latitude, longitude, relevantText: relevantText || undefined }];
  }
  return json;
}

export function buildPass(customer) {
  const pass = new PKPass(
    { "pass.json": Buffer.from(JSON.stringify(passJson(customer))), ...passImages() },
    certificates()
  );
  return pass.getAsBuffer();
}

// ---- Registro de dispositivos (web service) ----

export function registerDevice(deviceId, serial, pushToken) {
  const existing = db.prepare("SELECT 1 FROM apple_registrations WHERE device_id = ? AND serial = ?").get(deviceId, serial);
  db.prepare(
    `INSERT INTO apple_registrations (device_id, serial, push_token) VALUES (?, ?, ?)
     ON CONFLICT(device_id, serial) DO UPDATE SET push_token = excluded.push_token`
  ).run(deviceId, serial, pushToken);
  db.prepare("UPDATE customers SET apple_installed = 1 WHERE serial = ?").run(serial);
  return !existing;
}

export function unregisterDevice(deviceId, serial) {
  db.prepare("DELETE FROM apple_registrations WHERE device_id = ? AND serial = ?").run(deviceId, serial);
  const left = db.prepare("SELECT 1 FROM apple_registrations WHERE serial = ?").get(serial);
  if (!left) db.prepare("UPDATE customers SET apple_installed = 0 WHERE serial = ?").run(serial);
}

export function serialsForDevice(deviceId, updatedSince) {
  const since = Number(updatedSince) || 0;
  return db
    .prepare(
      `SELECT c.serial, c.updated_at FROM apple_registrations r JOIN customers c ON c.serial = r.serial
       WHERE r.device_id = ? AND c.updated_at > ?`
    )
    .all(deviceId, since);
}

async function push(tokens) {
  if (!status().enabled || !tokens.length) return;
  const certs = certificates();
  const results = await pushPassUpdates([...new Set(tokens)], {
    host: cfg.apnsHost,
    cert: certs.signerCert,
    key: certs.signerKey,
    passphrase: certs.signerKeyPassphrase,
    topic: cfg.passTypeId,
  });
  for (const r of results) {
    // 410: el dispositivo ya no tiene el pase → lo olvidamos.
    if (r.status === 410) db.prepare("DELETE FROM apple_registrations WHERE push_token = ?").run(r.token);
    else if (r.status !== 200) console.warn(`[apple] APNs ${r.status || "error"} ${r.error || r.body || ""}`.trim());
  }
}

export async function notifyChanged(customer) {
  const tokens = db.prepare("SELECT push_token FROM apple_registrations WHERE serial = ?").all(customer.serial);
  await push(tokens.map((t) => t.push_token));
}

// Cambió algo que afecta a todos los pases (marca, premios, promoción).
export async function notifyAll() {
  db.prepare("UPDATE customers SET updated_at = ? WHERE serial IN (SELECT serial FROM apple_registrations)").run(Date.now());
  const tokens = db.prepare("SELECT push_token FROM apple_registrations").all();
  await push(tokens.map((t) => t.push_token));
}
