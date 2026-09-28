// Imágenes de marca: el logo subido desde el panel o el logo por defecto.
import fs from "node:fs";
import path from "node:path";
import { ROOT, config } from "../config.js";

const DEFAULT_LOGO = path.join(ROOT, "assets", "brand", "logo.png");
export const UPLOADED_LOGO = path.join(config.uploadsDir, "logo.png");
// Foto de portada (ya recortada a 1125×369 por el panel): franja del pase de Apple,
// imagen principal en Google Wallet y encabezado de la tarjeta web.
export const COVER = path.join(config.uploadsDir, "cover.png");

export function coverVersion() {
  return fs.existsSync(COVER) ? Math.round(fs.statSync(COVER).mtimeMs) : null;
}

export function logoFile() {
  return fs.existsSync(UPLOADED_LOGO) ? UPLOADED_LOGO : DEFAULT_LOGO;
}

export function passImages() {
  const dir = path.join(ROOT, "assets", "pass");
  const logo = fs.readFileSync(logoFile());
  const strip = coverVersion() ? fs.readFileSync(COVER) : null;
  return {
    ...(strip ? { "strip.png": strip, "strip@2x.png": strip, "strip@3x.png": strip } : {}),
    "icon.png": fs.readFileSync(path.join(dir, "icon.png")),
    "icon@2x.png": fs.readFileSync(path.join(dir, "icon@2x.png")),
    "icon@3x.png": fs.readFileSync(path.join(dir, "icon@3x.png")),
    "logo.png": logo,
    "logo@2x.png": logo,
  };
}
