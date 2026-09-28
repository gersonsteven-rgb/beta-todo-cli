import path from "node:path";
import express from "express";
import QRCode from "qrcode";
import { ROOT, config, lanAddresses } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { getSettings } from "./settings.js";
import { baseUrl } from "./services/cards.js";
import { wallet } from "./wallet/index.js";
import { router as publicRoutes } from "./routes/public.js";
import { router as walletRoutes } from "./routes/wallet.js";
import { router as adminRoutes } from "./routes/admin.js";

bootstrap();

const app = express();
// Detrás de un túnel (cloudflared/ngrok) en la misma máquina: respeta X-Forwarded-Proto.
app.set("trust proxy", "loopback");
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self)");
  next();
});
app.use(express.json({ limit: "2mb" }));

app.use(publicRoutes);
app.use(walletRoutes);
app.use("/api/admin", adminRoutes);

app.get("/vendor/jsqr.js", (req, res) => res.sendFile(path.join(ROOT, "node_modules", "jsqr", "dist", "jsQR.js")));
app.get(["/admin", "/admin/"], (req, res) => res.sendFile(path.join(ROOT, "public", "admin", "index.html")));
app.use(express.static(path.join(ROOT, "public"), { index: false }));

app.use("/api", (req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "public", "404.html")));

// Errores de negocio (LoyaltyError) → mensaje al usuario; el resto → 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Ocurrió un error inesperado." : err.message });
});

app.listen(config.port, async () => {
  const s = getSettings();
  const registro = `${baseUrl()}/registro`;
  const ws = wallet.status();
  const lan = lanAddresses();
  console.log(`\n  ${s.programName} · ${s.businessName} — demo de fidelización\n`);
  console.log(`  Panel admin:     http://localhost:${config.port}/admin   (${config.admin.email})`);
  for (const ip of lan) console.log(`  En la red local: http://${ip}:${config.port}/admin`);
  console.log(`  Registro:        ${registro}`);
  console.log(`  Apple Wallet:    ${ws.apple.enabled ? "activo" : "no configurado (se usa la tarjeta web)"}`);
  console.log(`  Google Wallet:   ${ws.google.enabled ? "activo" : "no configurado (se usa la tarjeta web)"}\n`);
  console.log("  Escaneá este QR con el celular para registrarte:\n");
  console.log(await QRCode.toString(registro, { type: "terminal", small: true }));
});
