// Configuración de la instancia. Una instancia = un negocio (piloto).
// Todo lo sensible viene de variables de entorno / archivo .env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(import.meta.dirname, "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const dataDir = path.resolve(ROOT, env.DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });

// Si no se define SESSION_SECRET, se genera uno y se guarda en data/ para que
// las sesiones sobrevivan reinicios.
function sessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, "session.secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"));
  return fs.readFileSync(file, "utf8").trim();
}

function resolvePath(p) {
  return p ? path.resolve(ROOT, p) : "";
}

export const config = {
  port: Number(env.PORT || 3000),
  dataDir,
  uploadsDir: path.join(dataDir, "uploads"),
  dbFile: path.join(dataDir, "fidelizacion.db"),
  sessionSecret: sessionSecret(),
  // URL pública (ej. túnel https). Se puede sobrescribir desde el panel.
  publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
  admin: {
    name: env.ADMIN_NAME || "Administrador",
    email: env.ADMIN_EMAIL || "admin@demo.com",
    password: env.ADMIN_PASSWORD || "demo1234",
  },
  apple: {
    passTypeId: env.APPLE_PASS_TYPE_ID || "",
    teamId: env.APPLE_TEAM_ID || "",
    signerCert: resolvePath(env.APPLE_SIGNER_CERT || "certs/apple/signerCert.pem"),
    signerKey: resolvePath(env.APPLE_SIGNER_KEY || "certs/apple/signerKey.pem"),
    signerKeyPassphrase: env.APPLE_SIGNER_KEY_PASSPHRASE || "",
    wwdr: resolvePath(env.APPLE_WWDR_CERT || "certs/apple/wwdr.pem"),
    apnsHost: env.APPLE_APNS_HOST || "https://api.push.apple.com",
  },
  // Marca del proveedor que se muestra discretamente en el panel y la tarjeta (vacío = oculto).
  vendor: {
    name: env.VENDOR_NAME ?? "HoraCeroIA",
    url: env.VENDOR_URL ?? "https://horaceroia.com",
  },
  google: {
    issuerId: env.GOOGLE_WALLET_ISSUER_ID || "",
    keyFile: resolvePath(env.GOOGLE_WALLET_KEY_FILE || "certs/google/service-account.json"),
    classSuffix: env.GOOGLE_WALLET_CLASS_SUFFIX || "loyalty",
    logoUrl: env.GOOGLE_WALLET_LOGO_URL || "",
  },
};

fs.mkdirSync(config.uploadsDir, { recursive: true });

// IPs de la red local, para que los celulares en el mismo Wi-Fi lleguen al demo.
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}
