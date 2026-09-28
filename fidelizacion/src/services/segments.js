// Segmentación de clientes (plan Plata): nuevos, frecuentes, inactivos y VIP.
// Se calcula al vuelo desde el historial; las reglas se ajustan en Ajustes.
import { db } from "../db.js";
import { getSettings, tierFor } from "../settings.js";

export const SEGMENT_KEYS = ["new", "frequent", "inactive", "vip"];

export function segmentDefinitions(settings = getSettings()) {
  const g = settings.segments;
  const top = [...(settings.tiers || [])].sort((a, b) => b.min - a.min)[0];
  return {
    new: { label: "Nuevos", hint: `Se registraron en los últimos ${g.newDays} días` },
    frequent: { label: "Frecuentes", hint: `${g.frequentVisits} o más compras en los últimos ${g.frequentDays} días` },
    inactive: { label: "Inactivos", hint: `Sin compras hace más de ${g.inactiveDays} días` },
    vip: { label: "VIP", hint: top ? `Nivel ${top.name} (${top.min}+ acumulados)` : "Nivel más alto" },
  };
}

const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();

// Devuelve Map(customerId → [segmentos]) para todos los clientes (o solo los indicados).
export function segmentMap(customers = null, settings = getSettings()) {
  const g = settings.segments;
  const list = customers || db.prepare("SELECT id, created_at, last_visit_at, lifetime_points FROM customers").all();
  const recent = new Map(
    db
      .prepare(
        `SELECT customer_id, COUNT(*) AS n FROM transactions
         WHERE type = 'earn' AND voided_by IS NULL AND created_at >= ? GROUP BY customer_id`
      )
      .all(daysAgo(g.frequentDays))
      .map((r) => [r.customer_id, r.n])
  );
  const newSince = daysAgo(g.newDays);
  const inactiveBefore = daysAgo(g.inactiveDays);
  const out = new Map();
  for (const c of list) {
    const keys = [];
    if (c.created_at >= newSince) keys.push("new");
    if ((recent.get(c.id) || 0) >= g.frequentVisits) keys.push("frequent");
    if ((c.last_visit_at || c.created_at) < inactiveBefore) keys.push("inactive");
    if (tierFor(c.lifetime_points, settings)?.isTop) keys.push("vip");
    out.set(c.id, keys);
  }
  return out;
}

export function segmentsOf(customer, settings = getSettings()) {
  return segmentMap([customer], settings).get(customer.id) || [];
}

export function segmentCounts(settings = getSettings()) {
  const counts = Object.fromEntries(SEGMENT_KEYS.map((k) => [k, 0]));
  for (const keys of segmentMap(null, settings).values()) for (const k of keys) counts[k]++;
  return counts;
}

// Clientes que recibirán una campaña: el segmento elegido ∩ aceptaron promociones.
export function audience(segment, settings = getSettings()) {
  const optedIn = db.prepare("SELECT * FROM customers WHERE marketing_opt_in = 1").all();
  if (segment === "all") return optedIn;
  const map = segmentMap(optedIn, settings);
  return optedIn.filter((c) => map.get(c.id)?.includes(segment));
}
