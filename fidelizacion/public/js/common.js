// Utilidades compartidas por las páginas del cliente.
export async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "No se pudo completar la acción."), { status: res.status });
  return data;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Aplica los colores del negocio a la página.
export function applyBrand(p) {
  const root = document.documentElement.style;
  root.setProperty("--brand", p.primaryColor);
  root.setProperty("--brand-ink", p.textColor);
  root.setProperty("--accent", p.accentColor);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.primaryColor);
  for (const el of document.querySelectorAll("[data-bind]")) {
    const v = p[el.dataset.bind];
    if (v != null) el.textContent = v;
  }
  for (const img of document.querySelectorAll("img[data-logo]")) img.src = `${p.logoUrl}?v=${Date.now()}`;
}

export function fmtDate(iso, locale = "es-CR", opts = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat(locale, opts).format(new Date(iso));
}

export function plural(n, one, many) {
  return `${n} ${Math.abs(n) === 1 ? one : many}`;
}

export const STORAGE_KEY = "fidelizacion.tarjeta";

export function remember(serial) {
  try {
    localStorage.setItem(STORAGE_KEY, serial);
  } catch {}
}

export function remembered() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function toast(el, html, ms = 3600) {
  el.innerHTML = html;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}
