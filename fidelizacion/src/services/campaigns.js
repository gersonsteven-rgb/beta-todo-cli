// Campañas: promociones que llegan a la tarjeta web al instante y a las wallets
// como notificación. Solo a clientes que aceptaron recibir promociones.
import { db, tx } from "../db.js";
import { publish } from "../lib/events.js";
import { features, getSettings } from "../settings.js";
import { wallet } from "../wallet/index.js";
import { currentPromoFor } from "./cards.js";
import { audience, SEGMENT_KEYS } from "./segments.js";
import { LoyaltyError } from "./loyalty.js";

export function sendCampaign({ title, message, segment = "all" }, userId) {
  const t = String(title || "").trim().slice(0, 40);
  const m = String(message || "").trim().slice(0, 240);
  if (!t || !m) throw new LoyaltyError("La campaña necesita título y mensaje.");
  if (segment !== "all" && !SEGMENT_KEYS.includes(segment)) throw new LoyaltyError("Segmento inválido.");
  if (segment !== "all" && !features(getSettings()).targetedCampaigns) {
    throw new LoyaltyError("Las campañas por segmento son parte del plan Plata.", 403);
  }
  const recipients = audience(segment);
  if (!recipients.length) throw new LoyaltyError("No hay clientes en ese segmento que hayan aceptado recibir promociones.");

  const promo = tx(() => {
    const id = Number(
      db.prepare("INSERT INTO promotions (title, message, segment, recipients, user_id) VALUES (?, ?, ?, ?, ?)").run(t, m, segment, recipients.length, userId)
        .lastInsertRowid
    );
    const ins = db.prepare("INSERT INTO promotion_recipients (promotion_id, customer_id) VALUES (?, ?)");
    for (const c of recipients) ins.run(id, c.id);
    const now = Date.now();
    const touch = db.prepare("UPDATE customers SET updated_at = ? WHERE id = ?");
    for (const c of recipients) touch.run(now, c.id);
    return { id, title: t, message: m, segment, createdAt: new Date().toISOString() };
  });

  for (const c of recipients) publish(`card:${c.serial}`, "promo", promo);
  wallet.campaignSent(promo, recipients);
  return { promo, recipients: recipients.length };
}

// Retira una campaña: cada destinatario vuelve a ver su campaña anterior vigente (o ninguna).
export function endCampaign(id) {
  const promo = db.prepare("SELECT * FROM promotions WHERE id = ?").get(id);
  if (!promo) throw new LoyaltyError("Campaña no encontrada.", 404);
  const recipients = db
    .prepare("SELECT c.* FROM customers c JOIN promotion_recipients r ON r.customer_id = c.id WHERE r.promotion_id = ?")
    .all(id);
  tx(() => {
    db.prepare("UPDATE promotions SET active = 0 WHERE id = ?").run(id);
    const now = Date.now();
    const touch = db.prepare("UPDATE customers SET updated_at = ? WHERE id = ?");
    for (const c of recipients) touch.run(now, c.id);
  });
  for (const c of recipients) publish(`card:${c.serial}`, "promo", currentPromoFor(c.id));
  wallet.customersChanged(recipients);
  return { ok: true };
}
