// Descarga de pases y web service de Apple Wallet
// (https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes).
import express from "express";
import { config } from "../config.js";
import { getSettings } from "../settings.js";
import { getCustomerBySerial } from "../services/cards.js";
import { wallet } from "../wallet/index.js";

export const router = express.Router();
const { apple, google } = wallet;

function slug(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function notConfigured(res, which) {
  res.status(404).type("text").send(`${which} no está configurado en este servidor. Ver README → Wallets.`);
}

router.get("/wallet/apple/:serial.pkpass", (req, res) => {
  if (!apple.status().enabled) return notConfigured(res, "Apple Wallet");
  const c = getCustomerBySerial(req.params.serial);
  if (!c) return res.status(404).send("Tarjeta no encontrada.");
  const buffer = apple.buildPass(c);
  res.setHeader("Content-Type", "application/vnd.apple.pkpass");
  res.setHeader("Content-Disposition", `attachment; filename="${slug(getSettings().programName) || "tarjeta"}.pkpass"`);
  res.setHeader("Last-Modified", new Date(c.updated_at).toUTCString());
  res.send(buffer);
});

router.get("/wallet/google/:serial", (req, res) => {
  if (!google.status().enabled) return notConfigured(res, "Google Wallet");
  const c = getCustomerBySerial(req.params.serial);
  if (!c) return res.status(404).send("Tarjeta no encontrada.");
  res.redirect(google.saveUrl(c));
});

// ---- Web service de Apple (lo llama el iPhone, no el navegador) ----
const ws = express.Router();
router.use("/wallet/apple/v1", ws);

function passTypeOk(req, res) {
  if (req.params.passTypeId !== config.apple.passTypeId) {
    res.sendStatus(404);
    return false;
  }
  return true;
}

function authorizedCustomer(req, res) {
  const c = getCustomerBySerial(req.params.serial);
  const token = String(req.headers.authorization || "").replace(/^ApplePass\s+/i, "");
  if (!c || !token || token !== c.auth_token) {
    res.sendStatus(401);
    return null;
  }
  return c;
}

ws.post("/devices/:deviceId/registrations/:passTypeId/:serial", (req, res) => {
  if (!passTypeOk(req, res)) return;
  const c = authorizedCustomer(req, res);
  if (!c) return;
  const pushToken = req.body?.pushToken;
  if (!pushToken) return res.sendStatus(400);
  const created = apple.registerDevice(req.params.deviceId, c.serial, pushToken);
  res.sendStatus(created ? 201 : 200);
});

ws.delete("/devices/:deviceId/registrations/:passTypeId/:serial", (req, res) => {
  if (!passTypeOk(req, res)) return;
  const c = authorizedCustomer(req, res);
  if (!c) return;
  apple.unregisterDevice(req.params.deviceId, c.serial);
  res.sendStatus(200);
});

ws.get("/devices/:deviceId/registrations/:passTypeId", (req, res) => {
  if (!passTypeOk(req, res)) return;
  const rows = apple.serialsForDevice(req.params.deviceId, req.query.passesUpdatedSince);
  if (!rows.length) return res.sendStatus(204);
  const lastUpdated = Math.max(...rows.map((r) => r.updated_at));
  res.json({ serialNumbers: rows.map((r) => r.serial), lastUpdated: String(lastUpdated) });
});

ws.get("/passes/:passTypeId/:serial", (req, res) => {
  if (!passTypeOk(req, res)) return;
  const c = authorizedCustomer(req, res);
  if (!c) return;
  const since = Date.parse(req.headers["if-modified-since"] || "");
  if (Number.isFinite(since) && Math.floor(c.updated_at / 1000) * 1000 <= since) return res.sendStatus(304);
  res.setHeader("Content-Type", "application/vnd.apple.pkpass");
  res.setHeader("Last-Modified", new Date(c.updated_at).toUTCString());
  res.send(apple.buildPass(c));
});

ws.post("/log", (req, res) => {
  for (const line of req.body?.logs || []) console.warn("[apple wallet log]", line);
  res.sendStatus(200);
});
