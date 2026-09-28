// Datos mínimos para arrancar: usuario dueño y catálogo de premios inicial.
import { config } from "./config.js";
import { db } from "./db.js";
import { hashPassword } from "./lib/auth.js";

// Catálogo del piloto Fusion Truck (ajustable desde el panel → Premios).
export const DEFAULT_REWARDS = [
  { name: "Refresco gratis", description: "Cualquier bebida natural o gaseosa.", points_cost: 15 },
  { name: "Papas clásicas gratis", description: "Porción de papas fritas clásicas.", points_cost: 30 },
  { name: "Hamburguesa clásica gratis", description: "Hamburguesa de la casa.", points_cost: 45 },
  { name: "Papas Fusion gratis", description: "Papas cargadas con queso, guacamole, maduro y proteína a elección.", points_cost: 60 },
];

export function bootstrap() {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (!users) {
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')").run(
      config.admin.name,
      config.admin.email,
      hashPassword(config.admin.password)
    );
    console.log(`Usuario dueño creado: ${config.admin.email}`);
  }
  const rewards = db.prepare("SELECT COUNT(*) AS n FROM rewards").get().n;
  if (!rewards) {
    const insert = db.prepare("INSERT INTO rewards (name, description, points_cost) VALUES (?, ?, ?)");
    for (const r of DEFAULT_REWARDS) insert.run(r.name, r.description, r.points_cost);
  }
}
