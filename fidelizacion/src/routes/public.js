// Rutas públicas: lo que usa el cliente desde su celular.
import fs from "node:fs";
import path from "node:path";
import express from "express";
import QRCode from "qrcode";
import { ROOT } from "../config.js";
import { rateLimit } from "../lib/auth.js";
import { subscribe } from "../lib/events.js";
import { getSettings } from "../settings.js";
import { registerCustomer } from "../services/loyalty.js";
import { cardState, getCustomerBySerial, programInfo } from "../services/cards.js";
import { wallet } from "../wallet/index.js";
import { logoFile } from "../wallet/images.js";

const PUBLIC = path.join(ROOT, "public");
export const router = express.Router();

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: "Demasiados registros desde esta conexión. Intentá de nuevo en unos minutos.",
});

function page(file, replacements = {}) {
  let html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
  for (const [k, v] of Object.entries(replacements)) html = html.replaceAll(`{{${k}}}`, v);
  return html;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function head() {
  const s = getSettings();
  return { TITLE: escapeHtml(s.programName), BUSINESS: escapeHtml(s.businessName), COLOR: escapeHtml(s.primaryColor) };
}

router.get("/", (req, res) => res.redirect("/registro"));

router.get("/registro", (req, res) => {
  res.type("html").send(page("registro.html", { ...head(), MANIFEST: "/manifest.webmanifest" }));
});

router.get("/tarjeta/:serial", (req, res) => {
  if (!getCustomerBySerial(req.params.serial)) return res.status(404).type("html").send(page("404.html", head()));
  const manifest = `/manifest.webmanifest?tarjeta=${encodeURIComponent(req.params.serial)}`;
  res.type("html").send(page("tarjeta.html", { ...head(), MANIFEST: manifest }));
});

// Manifest dinámico: al "instalar" la tarjeta en el celular abre directo en ella.
router.get("/manifest.webmanifest", (req, res) => {
  const s = getSettings();
  const serial = String(req.query.tarjeta || "");
  const start = serial && getCustomerBySerial(serial) ? `/tarjeta/${serial}` : "/registro";
  res.type("application/manifest+json").json({
    name: `${s.programName} · ${s.businessName}`,
    short_name: s.programName,
    start_url: start,
    scope: "/",
    display: "standalone",
    background_color: s.primaryColor,
    theme_color: s.primaryColor,
    icons: [{ src: "/media/logo.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  });
});

router.get("/media/logo.png", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(logoFile());
});

router.get("/api/public/program", (req, res) => res.json(programInfo()));

router.post("/api/public/register", registerLimiter, (req, res) => {
  const { customer, existing } = registerCustomer(req.body || {}, { source: "qr" });
  res.status(existing ? 200 : 201).json({ serial: customer.serial, existing, cardUrl: `/tarjeta/${customer.serial}` });
});

function cardOr404(req, res) {
  const c = getCustomerBySerial(req.params.serial);
  if (!c) res.status(404).json({ error: "Tarjeta no encontrada." });
  return c;
}

router.get("/api/public/cards/:serial", (req, res) => {
  const c = cardOr404(req, res);
  if (!c) return;
  res.json({ ...cardState(c), wallet: wallet.links(c), program: programInfo() });
});

router.get("/api/public/cards/:serial/stream", (req, res) => {
  const c = cardOr404(req, res);
  if (!c) return;
  subscribe(`card:${c.serial}`, req, res);
});

router.get("/api/public/cards/:serial/qr.svg", async (req, res) => {
  const c = cardOr404(req, res);
  if (!c) return;
  const svg = await QRCode.toString(c.code, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  res.type("image/svg+xml").setHeader("Cache-Control", "private, max-age=86400").send(svg);
});
