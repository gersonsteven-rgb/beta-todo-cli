// Datos de ejemplo para el demo: clientes, compras y canjes de los últimos meses.
//   npm run seed                → agrega datos si la base está vacía
//   npm run reset               → borra la base y la recrea con datos de ejemplo (tarjeta de puntos)
//   npm run reset -- --sellos   → igual, pero con tarjeta de sellos
import fs from "node:fs";

const { config } = await import("../src/config.js");
const reset = process.argv.includes("--reset");
const stampsPreset = process.argv.includes("--sellos");
if (reset) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(config.dbFile + suffix, { force: true });
  console.log("Base de datos borrada.");
}

const { db, tx } = await import("../src/db.js");
const { bootstrap } = await import("../src/bootstrap.js");
const { getSettings, saveSettings, purchasePoints, tierFor } = await import("../src/settings.js");
const { newCardCode, newSerial, newAuthToken } = await import("../src/lib/codes.js");

bootstrap();

if (db.prepare("SELECT COUNT(*) AS n FROM customers").get().n > 0) {
  console.log("Ya hay clientes en la base. Usá `npm run reset` para empezar de cero con datos de ejemplo.");
  process.exit(0);
}

if (stampsPreset) {
  // Tarjeta de sellos: 1 sello por compra desde ₡2 500; 5 sellos = refresco, 10 = papas Fusion.
  saveSettings({
    cardType: "stamps",
    stampRule: { minSpend: 2500 },
    welcomeBonus: 1,
    tiers: [
      { name: "Clásico", min: 0, bonus: 0 },
      { name: "Oro", min: 10, bonus: 0 },
      { name: "VIP", min: 20, bonus: 0 },
    ],
    location: { relevantText: "¡Estás cerca! Mostrá tu tarjeta y sumá tu sello." },
  });
  db.exec("DELETE FROM rewards");
  const ins = db.prepare("INSERT INTO rewards (name, description, points_cost) VALUES (?, ?, ?)");
  ins.run("Refresco gratis", "Cualquier bebida natural o gaseosa.", 5);
  ins.run("Papas Fusion gratis", "Papas cargadas con queso, guacamole, maduro y proteína a elección.", 10);
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

// Perfiles para que la segmentación tenga de todo: fans (VIP), frecuentes, ocasionales y perdidos.
const PROFILES = [
  { name: "fan", weight: 0.12, age: [60, 120], visits: [18, 28], window: "all" },
  { name: "regular", weight: 0.3, age: [20, 110], visits: [4, 10], window: "all" },
  { name: "reciente", weight: 0.25, age: [0, 25], visits: [0, 3], window: "all" },
  { name: "ocasional", weight: 0.15, age: [30, 110], visits: [1, 3], window: "all" },
  { name: "perdido", weight: 0.18, age: [55, 120], visits: [1, 4], window: "early" },
];
function pickProfile() {
  let r = rand();
  for (const p of PROFILES) if ((r -= p.weight) <= 0) return p;
  return PROFILES[0];
}

const settings = getSettings();
const rewards = db.prepare("SELECT * FROM rewards WHERE active = 1 ORDER BY points_cost").all();
const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
const N = 64;

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

    const profile = pickProfile();
    const createdDaysAgo = int(...profile.age);
    const created = eveningAt(createdDaysAgo);
    const r = insertCustomer.run(name, email, phone, newSerial(), newCardCode(), newAuthToken(), rand() < 0.75 ? 1 : 0, created.toISOString(), rand() < 0.85 ? "qr" : "admin", created.toISOString(), Date.now());
    const id = Number(r.lastInsertRowid);

    let points = settings.welcomeBonus;
    let lifetime = points;
    let visits = 0;
    let spent = 0;
    let lastVisit = null;
    if (points > 0) insertTx.run(id, "welcome", 0, points, null, null, null, created.toISOString());

    // Primera compra el día del registro; el resto repartidas (los "perdidos" dejan de venir pronto).
    const nVisits = int(...profile.visits);
    const latest = profile.window === "early" ? Math.max(createdDaysAgo - 20, 40) : 0;
    const days = [createdDaysAgo, ...Array.from({ length: Math.max(0, nVisits - 1) }, () => int(latest, createdDaysAgo))]
      .slice(0, nVisits)
      .sort((a, b) => b - a);
    for (const daysAgo of days) {
      let at = eveningAt(daysAgo);
      if (at < created) at = new Date(created.getTime() + int(2, 25) * 60000);
      if (at > new Date()) continue;
      const amount = pick(TICKETS) * (rand() < 0.15 ? 2 : 1);
      const pts = purchasePoints(amount, settings, tierFor(lifetime, settings)).total;
      insertTx.run(id, "earn", amount, pts, null, null, owner.id, at.toISOString());
      points += pts;
      lifetime += pts;
      visits += 1;
      spent += amount;
      lastVisit = at.toISOString();
      // Canje cuando alcanza un premio (no siempre: algunos ahorran para uno mayor).
      const affordable = rewards.filter((rw) => rw.points_cost <= points);
      if (affordable.length && rand() < 0.5) {
        const rw = rand() < 0.55 ? affordable[0] : affordable[affordable.length - 1];
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
console.log(
  `Listo (${stampsPreset ? "tarjeta de sellos" : "tarjeta de puntos"}): ${totals.c} clientes, ${totals.v} compras, ${totals.p} ${stampsPreset ? "sellos" : "puntos"} en circulación.`
);
console.log(`Panel: http://localhost:${config.port}/admin  (${config.admin.email} / ${config.admin.password})`);
