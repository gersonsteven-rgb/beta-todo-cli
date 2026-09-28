// Datos de ejemplo para el demo: clientes, compras y canjes de las últimas semanas.
//   npm run seed    → agrega datos si la base está vacía
//   npm run reset   → borra la base y la vuelve a crear con datos de ejemplo
import fs from "node:fs";

const { config } = await import("../src/config.js");
const reset = process.argv.includes("--reset");
if (reset) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(config.dbFile + suffix, { force: true });
  console.log("Base de datos borrada.");
}

const { db, tx } = await import("../src/db.js");
const { bootstrap } = await import("../src/bootstrap.js");
const { getSettings, pointsForPurchase } = await import("../src/settings.js");
const { newCardCode, newSerial, newAuthToken } = await import("../src/lib/codes.js");

bootstrap();

if (db.prepare("SELECT COUNT(*) AS n FROM customers").get().n > 0) {
  console.log("Ya hay clientes en la base. Usá `npm run reset` para empezar de cero con datos de ejemplo.");
  process.exit(0);
}

// PRNG determinístico para que el demo siempre se vea igual.
let seed = 20260927;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

const FIRST = ["María", "José", "Ana", "Luis", "Carlos", "Sofía", "Valeria", "Daniel", "Andrés", "Fernanda", "Gabriela", "Diego", "Camila", "Esteban", "Mariana", "Pablo", "Natalia", "Kevin", "Jimena", "Sebastián", "Laura", "Adrián", "Paula", "Fabián", "Tatiana", "Mauricio", "Priscilla", "Randall", "Melissa", "Josué"];
const LAST = ["Rodríguez", "Vargas", "Jiménez", "Mora", "Rojas", "Solís", "Alvarado", "Chaves", "Araya", "Castro", "Quesada", "Salazar", "Villalobos", "Brenes", "Campos", "Ramírez", "Hernández", "Sánchez", "Calderón", "Madrigal"];
// Tickets típicos de un food truck: una orden, orden + bebida, compras para compartir.
const TICKETS = [2800, 3500, 4200, 4800, 5500, 6300, 7200, 8400, 9800, 11500, 13900];

const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Hora local del food truck (6 p. m. – 10 p. m., Costa Rica = UTC-6).
function eveningAt(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(18 + 6 + int(0, 3), int(0, 59), int(0, 59), 0);
  return d > new Date() ? new Date(Date.now() - int(5, 90) * 60000) : d;
}

const settings = getSettings();
const rewards = db.prepare("SELECT * FROM rewards WHERE active = 1 ORDER BY points_cost").all();
const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
const N = 42;

const insertCustomer = db.prepare(
  `INSERT INTO customers (full_name, email, phone, serial, code, auth_token, marketing_opt_in, consent_at, source, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertTx = db.prepare(
  `INSERT INTO transactions (customer_id, type, amount, points, reward_id, reward_name, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

tx(() => {
  const usedEmails = new Set();
  for (let i = 0; i < N; i++) {
    const first = pick(FIRST);
    const last1 = pick(LAST);
    let last2 = pick(LAST);
    if (last2 === last1) last2 = pick(LAST);
    const name = `${first} ${last1} ${last2}`;
    let email = `${slug(first)}.${slug(last1)}@example.com`;
    if (usedEmails.has(email)) email = `${slug(first)}.${slug(last1)}${i}@example.com`;
    usedEmails.add(email);
    const phone = `+506${pick(["8", "7", "6"])}${String(int(0, 9999999)).padStart(7, "0")}`;

    // Más registros recientes (efecto del QR en caja).
    const createdDaysAgo = Math.floor(rand() ** 1.6 * 40);
    const created = eveningAt(createdDaysAgo);
    const r = insertCustomer.run(name, email, phone, newSerial(), newCardCode(), newAuthToken(), rand() < 0.7 ? 1 : 0, created.toISOString(), rand() < 0.85 ? "qr" : "admin", created.toISOString(), Date.now());
    const id = Number(r.lastInsertRowid);

    let points = settings.welcomeBonus;
    let lifetime = points;
    let visits = 0;
    let spent = 0;
    let lastVisit = null;
    if (points > 0) insertTx.run(id, "welcome", 0, points, null, null, null, created.toISOString());

    // La primera compra suele ser el mismo día del registro.
    const loyal = rand() < 0.35;
    const nVisits = createdDaysAgo === 0 ? int(0, 1) : loyal ? int(3, 9) : int(1, 3);
    const days = [createdDaysAgo, ...Array.from({ length: nVisits - 1 }, () => int(0, createdDaysAgo))].sort((a, b) => b - a);
    for (const daysAgo of days.slice(0, nVisits)) {
      let at = eveningAt(daysAgo);
      if (at < created) at = new Date(created.getTime() + int(2, 25) * 60000);
      if (at > new Date()) continue;
      const amount = pick(TICKETS) * (rand() < 0.15 ? 2 : 1);
      const pts = pointsForPurchase(amount, settings);
      insertTx.run(id, "earn", amount, pts, null, null, owner.id, at.toISOString());
      points += pts;
      lifetime += pts;
      visits += 1;
      spent += amount;
      lastVisit = at.toISOString();
      // Canje cuando alcanza un premio (no siempre: algunos ahorran para uno mayor).
      const affordable = rewards.filter((rw) => rw.points_cost <= points);
      if (affordable.length && rand() < 0.45) {
        const rw = rand() < 0.6 ? affordable[0] : affordable[affordable.length - 1];
        insertTx.run(id, "redeem", 0, -rw.points_cost, rw.id, rw.name, owner.id, new Date(at.getTime() + 60000).toISOString());
        points -= rw.points_cost;
      }
    }
    db.prepare("UPDATE customers SET points = ?, lifetime_points = ?, visits = ?, total_spent = ?, last_visit_at = ? WHERE id = ?").run(
      points,
      lifetime,
      visits,
      spent,
      lastVisit,
      id
    );
  }
});

const totals = db.prepare("SELECT COUNT(*) AS c, SUM(visits) AS v, SUM(points) AS p FROM customers").get();
console.log(`Listo: ${totals.c} clientes, ${totals.v} compras, ${totals.p} puntos en circulación.`);
console.log(`Panel: http://localhost:${config.port}/admin  (${config.admin.email} / ${config.admin.password})`);
