// Reglas del programa: registro, acumulación, canje, ajustes y anulaciones.
// Cada operación queda en `transactions` y dispara la actualización de la
// tarjeta web (SSE) y de las wallets (Apple/Google).
import { db, tx, now } from "../db.js";
import { getSettings, minorFactor, purchasePoints, formatMoney, qty, tierFor } from "../settings.js";
import { newCardCode, newSerial, newAuthToken, normalizeEmail, normalizePhone } from "../lib/codes.js";
import { publish } from "../lib/events.js";
import { cardState, getCustomerById, describeTransaction, firstName } from "./cards.js";
import { wallet } from "../wallet/index.js";

export class LoyaltyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function insertTx({ customerId, type, amount = 0, points, rewardId = null, rewardName = null, note = null, userId = null }) {
  const r = db
    .prepare(
      `INSERT INTO transactions (customer_id, type, amount, points, reward_id, reward_name, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(customerId, type, amount, points, rewardId, rewardName, note, userId);
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(r.lastInsertRowid);
}

function touch(customerId) {
  db.prepare("UPDATE customers SET updated_at = ? WHERE id = ?").run(Date.now(), customerId);
}

// Aviso en vivo a la tarjeta del cliente, al panel y a las wallets.
function afterChange(customerId, { transaction, message }) {
  const customer = getCustomerById(customerId);
  if (!customer) return;
  const settings = getSettings();
  const state = cardState(customer);
  publish(`card:${customer.serial}`, "update", {
    state,
    event: transaction ? { type: transaction.type, points: transaction.points, message } : null,
  });
  if (transaction) {
    publish("admin", "activity", {
      id: transaction.id,
      type: transaction.type,
      points: transaction.points,
      amount: transaction.amount,
      text: describeTransaction(transaction, settings),
      customerId: customer.id,
      customerName: customer.full_name,
      balance: customer.points,
      createdAt: transaction.created_at,
    });
  }
  wallet.cardChanged(customer).catch((err) => console.error("[wallet] Error actualizando pase:", err.message));
}

function mustGetCustomer(id) {
  const c = getCustomerById(id);
  if (!c) throw new LoyaltyError("Cliente no encontrado.", 404);
  return c;
}

export function validateRegistration(input) {
  const settings = getSettings();
  const fullName = String(input.fullName || "").trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 80 || !fullName.includes(" ")) {
    throw new LoyaltyError("Escribí tu nombre completo (nombre y apellido).");
  }
  const email = normalizeEmail(input.email);
  if (!email) throw new LoyaltyError("El correo no parece válido.");
  const phone = normalizePhone(input.phone, settings.phonePrefix);
  if (!phone) throw new LoyaltyError("El número de teléfono no parece válido.");
  return { fullName, email, phone, marketingOptIn: input.marketingOptIn ? 1 : 0 };
}

// Registra un cliente nuevo. Si ya existe con el mismo correo Y teléfono,
// devuelve su tarjeta (así puede recuperarla desde otro celular).
export function registerCustomer(input, { source = "qr", userId = null, requireConsent = true } = {}) {
  if (requireConsent && !input.acceptTerms) {
    throw new LoyaltyError("Para unirte tenés que aceptar los términos del programa.");
  }
  const data = validateRegistration(input);
  const settings = getSettings();

  const result = tx(() => {
    const existing = db.prepare("SELECT * FROM customers WHERE email = ? OR phone = ?").all(data.email, data.phone);
    if (existing.length) {
      const same = existing.find((c) => c.email === data.email && c.phone === data.phone);
      if (same) return { customer: same, existing: true };
      throw new LoyaltyError(
        "Ese correo o teléfono ya está registrado con otros datos. Pedí ayuda en caja para recuperar tu tarjeta.",
        409
      );
    }
    let code;
    do code = newCardCode();
    while (db.prepare("SELECT 1 FROM customers WHERE code = ?").get(code));

    const r = db
      .prepare(
        `INSERT INTO customers (full_name, email, phone, serial, code, auth_token, marketing_opt_in, consent_at, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(data.fullName, data.email, data.phone, newSerial(), code, newAuthToken(), data.marketingOptIn, now(), source, Date.now());
    const id = Number(r.lastInsertRowid);
    let transaction = null;
    const bonus = Math.max(0, Math.floor(settings.welcomeBonus || 0));
    if (bonus > 0) {
      transaction = insertTx({ customerId: id, type: "welcome", points: bonus, userId });
      db.prepare("UPDATE customers SET points = points + ?, lifetime_points = lifetime_points + ? WHERE id = ?").run(bonus, bonus, id);
    }
    return { customer: getCustomerById(id), existing: false, transaction };
  });

  if (!result.existing) {
    const c = result.customer;
    publish("admin", "activity", {
      id: result.transaction?.id ?? null,
      type: "signup",
      points: result.transaction?.points ?? 0,
      amount: 0,
      text: `Nuevo cliente (${source === "qr" ? "registro por QR" : "registrado en caja"})`,
      customerId: c.id,
      customerName: c.full_name,
      balance: c.points,
      createdAt: c.created_at,
    });
  }
  return result;
}

// Registra una compra. `amount` viene en unidades mayores (ej. colones).
export function earn(customerId, { amount, note }, userId) {
  const settings = getSettings();
  const value = Number(amount || 0);
  const needsAmount =
    (settings.cardType === "points" && settings.pointsRule.mode === "amount") ||
    (settings.cardType === "stamps" && settings.stampRule.minSpend > 0);
  if (needsAmount && !(value > 0)) throw new LoyaltyError("Ingresá el monto de la compra.");
  if (!(value >= 0) || value > 100_000_000) throw new LoyaltyError("Monto inválido.");
  const amountMinor = Math.round(value * minorFactor(settings));

  let calc, tierBefore;
  const transaction = tx(() => {
    const customer = mustGetCustomer(customerId);
    tierBefore = tierFor(customer.lifetime_points, settings);
    calc = purchasePoints(amountMinor, settings, tierBefore);
    const t = insertTx({ customerId, type: "earn", amount: amountMinor, points: calc.total, note: note || null, userId });
    db.prepare(
      `UPDATE customers SET points = points + ?, lifetime_points = lifetime_points + ?, visits = visits + 1,
       total_spent = total_spent + ?, last_visit_at = ? WHERE id = ?`
    ).run(calc.total, calc.total, amountMinor, t.created_at, customerId);
    touch(customerId);
    return t;
  });
  const customer = getCustomerById(customerId);
  const tierAfter = tierFor(customer.lifetime_points, settings);
  const tierUp = tierAfter && tierBefore && tierAfter.index > tierBefore.index ? tierAfter.name : null;
  let message =
    calc.total > 0
      ? `¡Sumaste ${qty(calc.total, settings)}!`
      : settings.cardType === "stamps"
        ? `Compra registrada (el sello es desde ${formatMoney(settings.stampRule.minSpend * minorFactor(settings), settings)})`
        : `Compra de ${formatMoney(amountMinor, settings)} registrada`;
  if (tierUp) message += ` Subiste a nivel ${tierUp}.`;
  afterChange(customerId, { transaction, message });
  return { transaction, points: calc.total, bonus: calc.bonus, tierUp, customer };
}

export function redeem(customerId, rewardId, userId) {
  const transaction = tx(() => {
    const customer = mustGetCustomer(customerId);
    const reward = db.prepare("SELECT * FROM rewards WHERE id = ? AND active = 1").get(rewardId);
    if (!reward) throw new LoyaltyError("Ese premio no existe o no está activo.", 404);
    if (customer.points < reward.points_cost) {
      throw new LoyaltyError(`Le faltan ${qty(reward.points_cost - customer.points)} para "${reward.name}".`);
    }
    const t = insertTx({ customerId, type: "redeem", points: -reward.points_cost, rewardId: reward.id, rewardName: reward.name, userId });
    db.prepare("UPDATE customers SET points = points - ? WHERE id = ?").run(reward.points_cost, customerId);
    touch(customerId);
    return t;
  });
  afterChange(customerId, { transaction, message: `¡Canjeaste ${transaction.reward_name}! Buen provecho.` });
  return { transaction, customer: getCustomerById(customerId) };
}

export function adjust(customerId, { points, note }, userId) {
  const delta = Math.trunc(Number(points));
  if (!delta) throw new LoyaltyError("Indicá cuánto sumar o restar.");
  if (!String(note || "").trim()) throw new LoyaltyError("Indicá el motivo del ajuste.");
  const transaction = tx(() => {
    const customer = mustGetCustomer(customerId);
    if (customer.points + delta < 0) throw new LoyaltyError("El saldo no puede quedar negativo.");
    const t = insertTx({ customerId, type: "adjust", points: delta, note: String(note).trim().slice(0, 140), userId });
    db.prepare("UPDATE customers SET points = points + ?, lifetime_points = lifetime_points + ? WHERE id = ?").run(
      delta,
      Math.max(0, delta),
      customerId
    );
    touch(customerId);
    return t;
  });
  const message = delta > 0 ? `¡Te regalamos ${qty(delta)}!` : `Se ajustaron ${qty(Math.abs(delta))}`;
  afterChange(customerId, { transaction, message });
  return { transaction, customer: getCustomerById(customerId) };
}

// Anula una compra o canje registrado por error (crea el movimiento inverso).
export function voidTransaction(transactionId, userId) {
  const { transaction, customerId } = tx(() => {
    const original = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId);
    if (!original) throw new LoyaltyError("Movimiento no encontrado.", 404);
    if (!["earn", "redeem"].includes(original.type)) throw new LoyaltyError("Solo se pueden anular compras y canjes.");
    if (original.voided_by) throw new LoyaltyError("Ese movimiento ya fue anulado.");
    const customer = mustGetCustomer(original.customer_id);
    const delta = -original.points;
    if (customer.points + delta < 0) {
      throw new LoyaltyError("No se puede anular: el cliente ya usó ese saldo.");
    }
    const label = original.type === "earn" ? "compra" : `canje de ${original.reward_name}`;
    const t = insertTx({
      customerId: customer.id,
      type: "void",
      amount: -original.amount,
      points: delta,
      note: `${label} #${original.id}`,
      userId,
    });
    db.prepare("UPDATE transactions SET voided_by = ? WHERE id = ?").run(t.id, original.id);
    if (original.type === "earn") {
      db.prepare(
        `UPDATE customers SET points = points + ?, lifetime_points = lifetime_points + ?, visits = MAX(0, visits - 1),
         total_spent = total_spent - ? WHERE id = ?`
      ).run(delta, delta, original.amount, customer.id);
    } else {
      db.prepare("UPDATE customers SET points = points + ? WHERE id = ?").run(delta, customer.id);
    }
    touch(customer.id);
    return { transaction: t, customerId: customer.id };
  });
  afterChange(customerId, { transaction, message: "Se corrigió un movimiento de tu tarjeta" });
  return { transaction, customer: getCustomerById(customerId) };
}

// Derecho de supresión (Ley 8968): borra al cliente y su historial.
export async function deleteCustomer(customerId) {
  const customer = mustGetCustomer(customerId);
  await wallet.cardDeleted(customer).catch((err) => console.error("[wallet]", err.message));
  db.prepare("DELETE FROM customers WHERE id = ?").run(customerId);
  publish(`card:${customer.serial}`, "deleted", {});
  return { deleted: true, name: firstName(customer.full_name) };
}
