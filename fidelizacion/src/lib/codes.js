import crypto from "node:crypto";

// Sin 0/O, 1/I/L para que se pueda dictar y digitar sin errores.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newCardCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// Acepta "abcd efgh", "ABCD-EFGH", "ABCDEFGH" y lo deja como "ABCD-EFGH".
export function normalizeCardCode(input) {
  const s = String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function newSerial() {
  return crypto.randomUUID();
}

export function newAuthToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function normalizePhone(input, prefix = "") {
  const raw = String(input || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  const prefixDigits = prefix.replace(/\D/g, "");
  if (prefixDigits && !(digits.startsWith(prefixDigits) && digits.length > 8)) return `+${prefixDigits}${digits}`;
  return `+${digits}`;
}

export function normalizeEmail(input) {
  const s = String(input || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120 ? s : null;
}
