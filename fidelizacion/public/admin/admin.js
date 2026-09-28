// Panel de administración (SPA sin build: HTML + JS nativo).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const view = $("#view");
const bus = new EventTarget();
let me = null;
let cleanup = null;
let stream = null;

// ---------------- API ----------------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") {
    showLogin();
    throw new Error(data.error || "Sesión expirada.");
  }
  if (!res.ok) throw new Error(data.error || "No se pudo completar la acción.");
  return data;
}

// ---------------- Formato ----------------
let moneyFmt, compactFmt;
function setupFormat() {
  const b = me.business;
  const d = b.currency.decimals;
  moneyFmt = new Intl.NumberFormat(b.locale, { style: "currency", currency: b.currency.code, minimumFractionDigits: d, maximumFractionDigits: d });
  compactFmt = new Intl.NumberFormat(b.locale, { style: "currency", currency: b.currency.code, notation: "compact", maximumFractionDigits: 1 });
}
const minorFactor = () => 10 ** me.business.currency.decimals;
const money = (minor) => moneyFmt.format(minor / minorFactor());
const moneyCompact = (minor) => compactFmt.format(minor / minorFactor());
const intFmt = (n) => new Intl.NumberFormat(me.business.locale).format(n);
const pct = (x) => `${Math.round(x * 100)}%`;
const date = (iso, o = { day: "numeric", month: "short", year: "numeric" }) =>
  iso ? new Intl.DateTimeFormat(me.business.locale, { timeZone: me.business.timezone, ...o }).format(new Date(iso)) : "—";
// +50688887777 → +506 8888 7777 (otros países se muestran tal cual).
const phoneFmt = (p) => String(p).replace(/^\+506(\d{4})(\d{4})$/, "+506 $1 $2");
const dateTime = (iso) => date(iso, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return dateTime(iso);
}
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
const isOwner = () => me?.user.role === "owner";

// Misma regla que el servidor, para mostrar la vista previa al digitar.
function previewPoints(amount) {
  const r = me.business.pointsRule;
  if (r.mode === "visit") return r.perVisit;
  const v = Number(amount) || 0;
  return r.spend > 0 ? Math.floor((Math.round(v * minorFactor()) / minorFactor()) / r.spend) * r.points : 0;
}

// ---------------- UI helpers ----------------
function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = "toast"), 3200);
}

function modal(html) {
  const d = $("#modal");
  d.innerHTML = html;
  d.showModal();
  return d;
}

function confirmBox(title, text, okLabel = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    const d = modal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="actions"><button class="btn" value="no">Cancelar</button><button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(okLabel)}</button></div>`);
    d.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        d.close();
        resolve(b.value === "ok");
      })
    );
    d.addEventListener("cancel", () => resolve(false), { once: true });
  });
}

function applyBrand() {
  const b = me.business;
  const root = document.documentElement.style;
  root.setProperty("--brand", b.primaryColor);
  root.setProperty("--brand-ink", b.textColor);
  root.setProperty("--accent", b.accentColor);
  $$("[data-biz]").forEach((e) => (e.textContent = b.businessName));
  $$("[data-prog]").forEach((e) => (e.textContent = b.programName));
  $$("[data-me]").forEach((e) => (e.textContent = me.user.name));
  $$("[data-role]").forEach((e) => (e.textContent = me.user.role === "owner" ? "Dueño" : "Cajero"));
  $$("img[data-logo]").forEach((i) => (i.src = `/media/logo.png?v=${Date.now()}`));
  $$("[data-owner]").forEach((e) => (e.hidden = !isOwner()));
  document.title = `Panel · ${b.programName}`;
}

// ---------------- Sesión ----------------
function showLogin() {
  stream?.close();
  stream = null;
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-form [name=email]").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  $("#login-error").hidden = true;
  try {
    await api("/login", { method: "POST", body: { email: f.email.value, password: f.password.value } });
    f.reset();
    await start();
  } catch (err) {
    $("#login-error").textContent = err.message;
    $("#login-error").hidden = false;
  }
});

$$("[data-logout]").forEach((b) =>
  b.addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
    showLogin();
  })
);

async function refreshMe() {
  me = await api("/me");
  setupFormat();
  applyBrand();
}

async function start() {
  await refreshMe();
  $("#login").hidden = true;
  $("#app").hidden = false;
  connectStream();
  route();
}

function connectStream() {
  stream?.close();
  stream = new EventSource("/api/admin/stream");
  stream.addEventListener("activity", (e) => {
    const a = JSON.parse(e.data);
    bus.dispatchEvent(new CustomEvent("activity", { detail: a }));
    if (a.type === "signup") toast(`🆕 ${a.customerName} se unió al programa`);
  });
  stream.addEventListener("settings", () => refreshMe().catch(() => {}));
}

// ---------------- Router ----------------
const views = { panel: viewPanel, caja: viewCaja, clientes: viewClientes, premios: viewPremios, promos: viewPromos, qr: viewQr, config: viewConfig };

async function route() {
  if (!me) return;
  cleanup?.();
  cleanup = null;
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  let key = views[name] ? name : isOwner() ? "panel" : "caja";
  if (key === "config" && !isOwner()) key = "caja";
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === key));
  view.innerHTML = '<div class="loading">Cargando…</div>';
  try {
    cleanup = (await views[key](view, arg)) || null;
  } catch (err) {
    view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
addEventListener("hashchange", route);

function onActivity(fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener("activity", h);
  return () => bus.removeEventListener("activity", h);
}

const activityIcon = { signup: "🆕", earn: "🛒", redeem: "🎁", adjust: "✏️", void: "↩️", welcome: "👋" };
function feedItem(a, fresh = false) {
  const pts = a.points ? `<span class="pts ${a.points > 0 ? "plus" : "minus"}">${a.points > 0 ? "+" : ""}${a.points}</span>` : "";
  return `<li class="${fresh ? "fresh" : ""}"><span class="dot" aria-hidden="true">${activityIcon[a.type] || "•"}</span>
    <span class="main"><b><a href="#/clientes/${a.customerId}">${esc(a.customerName)}</a></b><small class="${a.voided ? "voided" : ""}">${esc(a.text)} · ${ago(a.createdAt)}</small></span>${pts}</li>`;
}

// =====================================================================
// PANEL
// =====================================================================
async function viewPanel(el) {
  const render = async () => {
    const s = await api("/stats?days=14");
    const k = s.kpis;
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Panel</h1><p class="sub">Últimos ${s.days} días · se actualiza en vivo</p></div>
        <div class="actions"><a class="btn" href="#/qr">QR de registro</a><a class="btn primary" href="#/caja">Abrir caja</a></div>
      </div>
      <section class="kpis">
        ${tile("Clientes registrados", intFmt(k.customers), `<b>+${intFmt(k.newThisWeek)}</b> esta semana`)}
        ${tile("Ventas con tarjeta", money(k.salesTotal), `${intFmt(k.salesCount)} compras en ${s.days} días`)}
        ${tile("Ticket promedio", k.avgTicketText, "por compra registrada")}
        ${tile("Clientes que regresan", pct(k.repeatRate), "con 2 visitas o más")}
        ${tile("Puntos entregados", intFmt(k.pointsIssued), `${intFmt(k.pointsRedeemed)} canjeados · ${intFmt(k.outstandingPoints)} en circulación`)}
        ${tile("Premios canjeados", intFmt(k.redemptions), `en ${s.days} días`)}
      </section>
      <section class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Ventas por día</h2><span class="sub">compras registradas con tarjeta</span></div>
          <div class="chart" id="chart"></div>
          <details class="table-view"><summary>Ver como tabla</summary>
            <div class="table-wrap"><table class="t"><thead><tr><th>Día</th><th class="r">Ventas</th><th class="r">Compras</th><th class="r">Nuevos</th><th class="r">Canjes</th></tr></thead>
            <tbody>${s.series
              .map((d) => `<tr><td>${dayLabel(d.date, true)}</td><td class="r">${money(d.sales)}</td><td class="r">${d.visits}</td><td class="r">${d.signups}</td><td class="r">${d.redeems}</td></tr>`)
              .join("")}</tbody></table></div>
          </details>
        </div>
        <div class="card"><div class="card-head"><h2>Actividad en vivo</h2><span class="pill ok">● en vivo</span></div>
          <ul class="feed" id="feed">${s.activity.map((a) => feedItem(a)).join("") || '<li class="muted">Todavía no hay movimientos.</li>'}</ul>
        </div>
      </section>
      <section class="grid-2 even">
        <div class="card"><h2>Mejores clientes</h2>
          <div class="table-wrap"><table class="t"><thead><tr><th>Cliente</th><th class="r">Visitas</th><th class="r">Puntos</th></tr></thead><tbody>
          ${s.top.map((c) => `<tr class="link" data-href="#/clientes/${c.id}"><td>${esc(c.name)}</td><td class="r">${c.visits}</td><td class="r">${c.points}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">Sin datos aún.</td></tr>'}
          </tbody></table></div>
        </div>
        <div class="card"><h2>Premios más canjeados</h2>
          <div class="table-wrap"><table class="t"><thead><tr><th>Premio</th><th class="r">Canjes</th></tr></thead><tbody>
          ${s.popular.map((p) => `<tr><td>${esc(p.name)}</td><td class="r">${p.n}</td></tr>`).join("") || '<tr><td colspan="2" class="muted">Todavía no hay canjes.</td></tr>'}
          </tbody></table></div>
        </div>
      </section>`;
    $$("tr[data-href]", el).forEach((tr) => tr.addEventListener("click", () => (location.hash = tr.dataset.href)));
    drawColumns($("#chart", el), s.series);
  };
  await render();

  let t;
  const off = onActivity((a) => {
    const feed = $("#feed", el);
    if (feed) feed.insertAdjacentHTML("afterbegin", feedItem(a, true));
    clearTimeout(t);
    t = setTimeout(() => render().catch(() => {}), 1500);
  });
  const onResize = () => {
    const c = $("#chart", el);
    if (c?._series) drawColumns(c, c._series);
  };
  addEventListener("resize", onResize);
  return () => {
    off();
    clearTimeout(t);
    removeEventListener("resize", onResize);
  };
}

function tile(label, value, delta = "") {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${delta ? `<div class="delta">${delta}</div>` : ""}</div>`;
}

function dayLabel(iso, long = false) {
  const d = new Date(`${iso}T12:00:00`);
  return new Intl.DateTimeFormat(me.business.locale, long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric" }).format(d);
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Columnas de una sola serie (ventas por día) con tooltip por columna.
function drawColumns(container, series) {
  container._series = series;
  const W = Math.max(280, container.clientWidth);
  const H = 240;
  const m = { top: 20, right: 8, bottom: 28, left: 58 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...series.map((d) => d.sales)));
  const band = iw / series.length;
  const bw = Math.min(24, band * 0.62);
  const y = (v) => m.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => k * max);
  const every = Math.ceil(series.length / Math.max(1, Math.floor(iw / 46)));
  const peak = series.reduce((a, d, i) => (d.sales > series[a].sales ? i : a), 0);

  const bars = series
    .map((d, i) => {
      if (!d.sales) return "";
      const x = m.left + band * i + (band - bw) / 2;
      const top = y(d.sales);
      const h = m.top + ih - top;
      const r = Math.min(4, h, bw / 2);
      return `<path class="bar" data-i="${i}" d="M${x},${m.top + ih}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${m.top + ih}Z"/>`;
    })
    .join("");
  const peakLabel = series[peak].sales
    ? `<text class="label" x="${m.left + band * peak + band / 2}" y="${y(series[peak].sales) - 6}" text-anchor="middle">${moneyCompact(series[peak].sales)}</text>`
    : "";

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Ventas por día, últimos ${series.length} días">
    <g class="grid">${ticks.map((t) => `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
    <g class="axis">${ticks.map((t) => `<text x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${moneyCompact(t)}</text>`).join("")}
      ${series.map((d, i) => (i % every === (series.length - 1) % every ? `<text x="${m.left + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${dayLabel(d.date)}</text>` : "")).join("")}</g>
    ${bars}${peakLabel}
    ${series.map((d, i) => `<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ih}"/>`).join("")}
  </svg><div class="tooltip" hidden></div>`;

  const tip = $(".tooltip", container);
  $$(".hit", container).forEach((hit) => {
    hit.addEventListener("pointerenter", () => {
      const i = Number(hit.dataset.i);
      const d = series[i];
      container.classList.add("hovering");
      $$(".bar", container).forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
      tip.innerHTML = `<b>${dayLabel(d.date, true)}</b><div><span>Ventas</span><span>${money(d.sales)}</span></div><div><span>Compras</span><span>${d.visits}</span></div><div><span>Clientes nuevos</span><span>${d.signups}</span></div><div><span>Canjes</span><span>${d.redeems}</span></div>`;
      const scale = container.clientWidth / W;
      const cx = (m.left + band * i + band / 2) * scale;
      tip.style.left = `${Math.min(Math.max(cx, 90), container.clientWidth - 90)}px`;
      tip.style.top = `${(d.sales ? y(d.sales) : m.top + ih) * scale}px`;
      tip.hidden = false;
    });
    hit.addEventListener("pointerleave", () => {
      container.classList.remove("hovering");
      tip.hidden = true;
    });
  });
}

// =====================================================================
// CAJA: escanear, sumar puntos y canjear
// =====================================================================
async function viewCaja(el) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Caja</h1><p class="sub">Escaneá la tarjeta del cliente para sumar puntos o canjear premios.</p></div>
      <div class="actions"><button class="btn" id="new-customer">+ Cliente nuevo</button></div>
    </div>
    <div class="caja">
      <section class="card scanner">
        <div class="video-wrap" id="video-wrap" hidden><video playsinline muted></video><div class="frame"></div></div>
        <div class="scan-idle" id="scan-idle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><rect x="8" y="8" width="3" height="3"/><rect x="13" y="13" width="3" height="3"/><path d="M13 8h3M8 13v3"/></svg>
          <p>Apuntá la cámara al QR de la wallet o de la tarjeta web del cliente.</p>
          <button class="btn primary big" id="cam-on">Activar cámara</button>
        </div>
        <button class="btn" id="cam-off" hidden style="width:100%;margin-top:10px">Detener cámara</button>
        <form class="manual" id="manual">
          <input class="input" id="q" placeholder="Código, teléfono o nombre" autocomplete="off" autocapitalize="characters" enterkeyhint="search">
          <button class="btn">Buscar</button>
        </form>
        <p class="hint" id="cam-hint">También funciona con lector de códigos USB: hacé clic en el campo y escaneá.</p>
        <ul class="matches" id="matches"></ul>
      </section>
      <section id="slot"><div class="empty-state"><b>Ningún cliente seleccionado</b>Escaneá un código o buscá por teléfono o nombre.</div></section>
    </div>`;

  const scanner = createScanner($("#video-wrap", el), (text) => {
    stopCam();
    lookup(text);
  });
  const stopCam = () => {
    scanner.stop();
    $("#video-wrap", el).hidden = true;
    $("#scan-idle", el).hidden = false;
    $("#cam-off", el).hidden = true;
  };
  const startCam = async () => {
    try {
      $("#video-wrap", el).hidden = false;
      $("#scan-idle", el).hidden = true;
      $("#cam-off", el).hidden = false;
      await scanner.start();
    } catch (err) {
      stopCam();
      $("#cam-hint", el).textContent = err.message;
      $("#cam-hint", el).className = "info-box";
    }
  };
  $("#cam-on", el).addEventListener("click", startCam);
  $("#cam-off", el).addEventListener("click", stopCam);
  if (!window.isSecureContext) {
    $("#cam-hint", el).innerHTML =
      "La cámara del navegador solo funciona en <b>localhost</b> o con <b>https</b>. Desde otra computadora o celular usá el túnel https (ver README) o digitá el código.";
  }

  const slot = $("#slot", el);
  async function lookup(q) {
    $("#matches", el).innerHTML = "";
    try {
      const r = await api(`/lookup?q=${encodeURIComponent(q)}`);
      if (r.matches) {
        $("#matches", el).innerHTML = r.matches
          .map((c) => `<li data-id="${c.id}"><span><b>${esc(c.fullName)}</b><br><small class="muted">${esc(phoneFmt(c.phone))} · ${esc(c.code)}</small></span><span class="pts">${c.points} pts</span></li>`)
          .join("");
        $$("#matches li", el).forEach((li) =>
          li.addEventListener("click", async () => {
            $("#matches", el).innerHTML = "";
            showCustomer(await api(`/customers/${li.dataset.id}`));
          })
        );
        return;
      }
      showCustomer(r);
      navigator.vibrate?.(60);
    } catch (err) {
      toast(err.message, "error");
    }
  }
  function showCustomer(detail) {
    customerPanel(slot, detail, { compact: true });
    $("#q", el).value = "";
    if (innerWidth < 1080) slot.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#manual", el).addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#q", el).value.trim();
    if (q) lookup(q);
  });
  $("#new-customer", el).addEventListener("click", () => newCustomerDialog(showCustomer));
  if (matchMedia("(pointer: fine)").matches) $("#q", el).focus();
  return () => scanner.stop();
}

// Escáner QR: BarcodeDetector nativo si existe; si no, jsQR.
function createScanner(wrap, onResult) {
  const video = $("video", wrap);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let streamRef = null;
  let raf = null;
  let detector = null;
  let busy = false;

  async function tick() {
    if (!streamRef) return;
    if (video.readyState >= 2 && !busy) {
      busy = true;
      try {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0]?.rawValue || null;
        } else if (window.jsQR) {
          const w = (canvas.width = Math.min(640, video.videoWidth));
          const h = (canvas.height = Math.round((video.videoHeight / video.videoWidth) * w));
          ctx.drawImage(video, 0, 0, w, h);
          text = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
        }
        if (text) return onResult(text);
      } catch {}
      busy = false;
    }
    raf = requestAnimationFrame(tick);
  }

  return {
    async start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Este navegador no permite usar la cámara aquí (requiere https o localhost). Digitá el código o usá un lector USB.");
      }
      if ("BarcodeDetector" in window) {
        try {
          const formats = await BarcodeDetector.getSupportedFormats();
          if (formats.includes("qr_code")) detector = new BarcodeDetector({ formats: ["qr_code"] });
        } catch {}
      }
      try {
        streamRef = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      } catch {
        throw new Error("No se pudo abrir la cámara. Revisá el permiso del navegador o digitá el código.");
      }
      video.srcObject = streamRef;
      await video.play();
      busy = false;
      tick();
    },
    stop() {
      cancelAnimationFrame(raf);
      streamRef?.getTracks().forEach((t) => t.stop());
      streamRef = null;
      video.srcObject = null;
    },
  };
}

function newCustomerDialog(onCreated) {
  const d = modal(`<h3>Registrar cliente en caja</h3>
    <form id="nc">
      <label class="field"><span>Nombre completo</span><input class="input" name="fullName" required autocomplete="off"></label>
      <label class="field"><span>Correo</span><input class="input" name="email" type="email" required autocomplete="off"></label>
      <label class="field"><span>Teléfono</span><input class="input" name="phone" type="tel" required autocomplete="off" placeholder="8888 8888"></label>
      <label class="check"><input type="checkbox" name="acceptTerms" required> El cliente acepta los términos del programa y el uso de sus datos</label>
      <label class="check"><input type="checkbox" name="marketingOptIn"> Acepta recibir promociones</label>
      <p class="error-box" id="nc-err" hidden></p>
      <div class="actions"><button type="button" class="btn" id="nc-cancel">Cancelar</button><button class="btn primary">Registrar</button></div>
    </form>`);
  $("#nc-cancel", d).addEventListener("click", () => d.close());
  $("#nc", d).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const r = await api("/customers", {
        method: "POST",
        body: { fullName: f.fullName.value, email: f.email.value, phone: f.phone.value, acceptTerms: f.acceptTerms.checked, marketingOptIn: f.marketingOptIn.checked },
      });
      d.close();
      toast(r.existing ? "Ese cliente ya existía: se abrió su tarjeta." : "Cliente registrado. Enviale el enlace de su tarjeta.");
      onCreated(r);
    } catch (err) {
      $("#nc-err", d).textContent = err.message;
      $("#nc-err", d).hidden = false;
    }
  });
}

// Ficha del cliente con las operaciones de caja (se usa en Caja y en Clientes).
function customerPanel(slot, detail, { compact = false } = {}) {
  let state = detail;
  let lastResult = null;

  const render = (bump = false) => {
    const c = state.customer;
    const rule = me.business.pointsRule;
    const visitMode = rule.mode === "visit";
    slot.innerHTML = `
      <div class="card">
        <div class="cust-head">
          <div class="avatar">${esc(initials(c.fullName))}</div>
          <div class="who">
            <h2>${esc(c.fullName)}</h2>
            <p>${esc(c.code)} · ${esc(phoneFmt(c.phone))} · ${esc(c.email)}</p>
            <div class="badges">
              ${c.appleInstalled ? '<span class="pill ok">Apple Wallet</span>' : ""}
              ${c.googleClicked ? '<span class="pill ok">Google Wallet</span>' : ""}
              <span class="pill">${c.visits} ${c.visits === 1 ? "visita" : "visitas"}</span>
              <span class="pill">Cliente desde ${date(c.createdAt)}</span>
            </div>
          </div>
          <div class="balance"><span class="lbl">Puntos</span><b class="${bump ? "bump" : ""}">${intFmt(c.points)}</b></div>
        </div>
        <div class="meter">
          <div class="track"><div class="fill" style="width:${c.next ? Math.round(c.next.progress * 100) : 100}%"></div></div>
          <p>${c.next ? `Le faltan <b>${c.next.missing}</b> pts para <b>${esc(c.next.name)}</b>` : "Tiene todos los premios desbloqueados"}</p>
        </div>
        ${
          lastResult
            ? `<div class="result"><div class="big">${esc(lastResult.big)}</div><p>${lastResult.html}</p></div>`
            : ""
        }
        <div class="ops">
          <form class="op" id="earn">
            <h3>Registrar compra</h3>
            <div class="money"><span>${esc(currencySymbol())}</span><input name="amount" inputmode="decimal" autocomplete="off" placeholder="0" ${visitMode ? "" : "required"} aria-label="Monto de la compra"></div>
            <p class="preview" id="pv">${visitMode ? `Suma <b>${rule.perVisit}</b> ${rule.perVisit === 1 ? "punto" : "puntos"} por visita` : "= <b>0</b> puntos"}</p>
            <button class="btn primary big">${visitMode ? "Registrar visita" : "Sumar puntos"}</button>
          </form>
          <div class="op">
            <h3>Canjear premio</h3>
            <ul class="reward-list">${
              (state.rewards || [])
                .map((r) => {
                  const ok = c.points >= r.cost;
                  return `<li><span class="main"><b>${esc(r.name)}</b><small>${r.cost} pts${ok ? "" : ` · faltan ${r.cost - c.points}`}</small></span>
                    <button class="btn sm ${ok ? "primary" : ""}" data-redeem="${r.id}" data-name="${esc(r.name)}" data-cost="${r.cost}" ${ok ? "" : "disabled"}>Canjear</button></li>`;
                })
                .join("") || '<li class="muted">No hay premios activos.</li>'
            }</ul>
          </div>
        </div>
        <details class="more" ${compact ? "" : "open"}>
          <summary>Historial</summary>
          <ul class="hist">${state.history
            .map(
              (h) => `<li><span class="main ${h.voided ? "voided" : ""}">${esc(h.text)}<small>${dateTime(h.createdAt)}</small></span>
                <span class="pts ${h.points >= 0 ? "plus" : "minus"} ${h.voided ? "voided" : ""}">${h.points > 0 ? "+" : ""}${h.points}</span>
                ${isOwner() && ["earn", "redeem"].includes(h.type) && !h.voided ? `<button class="btn sm ghost" data-void="${h.id}" title="Anular">Anular</button>` : ""}</li>`
            )
            .join("") || '<li class="muted">Sin movimientos.</li>'}</ul>
        </details>
        <details class="more">
          <summary>Más opciones</summary>
          <div class="owner-tools">
            <div><p class="muted" style="margin:6px 0">Enlace de la tarjeta del cliente (para enviarlo por WhatsApp o correo):</p>
              <div style="display:flex;gap:8px"><input class="input" readonly value="${esc(location.origin + c.cardUrl)}" id="card-link"><button class="btn" id="copy">Copiar</button></div>
              <p style="margin:8px 0 0"><a href="${esc(c.cardUrl)}" target="_blank" rel="noopener">Abrir tarjeta ↗</a> · <a href="#/clientes/${c.id}">Ver ficha completa</a></p></div>
            ${
              isOwner()
                ? `<form id="adjust"><p class="muted" style="margin:6px 0">Ajuste manual de puntos</p>
                    <div style="display:flex;gap:8px"><input class="input" name="points" type="number" step="1" placeholder="+10 o -5" required style="max-width:110px"><input class="input" name="note" placeholder="Motivo" required></div>
                    <button class="btn" style="margin-top:8px">Aplicar ajuste</button></form>
                  <div><p class="muted" style="margin:6px 0">Eliminar al cliente y todo su historial (derecho de supresión).</p><button class="btn danger" id="del">Eliminar cliente</button></div>`
                : ""
            }
          </div>
        </details>
      </div>`;
    bind();
  };

  const bind = () => {
    const earnForm = $("#earn", slot);
    const amount = earnForm.amount;
    if (me.business.pointsRule.mode !== "visit") {
      amount.addEventListener("input", () => {
        amount.value = amount.value.replace(/[^\d.,]/g, "");
        const p = previewPoints(amount.value.replace(",", "."));
        $("#pv", slot).innerHTML = `= <b>${p}</b> ${p === 1 ? "punto" : "puntos"}`;
      });
    }
    earnForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = earnForm.querySelector("button");
      btn.disabled = true;
      try {
        const value = amount.value.replace(",", ".") || 0;
        const r = await api(`/customers/${state.customer.id}/earn`, { method: "POST", body: { amount: Number(value) } });
        const unlockedBefore = new Set(state.customer.available.map((a) => a.id));
        const newly = r.customer.available.filter((a) => !unlockedBefore.has(a.id));
        lastResult = {
          big: `+${r.points} pts`,
          html: `Compra de ${money(Math.round(Number(value) * minorFactor()))} registrada. Nuevo saldo: <b>${r.customer.points}</b> pts.${
            newly.length ? ` 🎁 ¡Ya puede canjear <b>${esc(newly.map((n) => n.name).join(", "))}</b>!` : ""
          }`,
        };
        state = { ...state, ...r };
        render(true);
        toast(`+${r.points} puntos para ${r.customer.fullName.split(" ")[0]}`);
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    });
    if (matchMedia("(pointer: fine)").matches) amount.focus({ preventScroll: true });

    $$("[data-redeem]", slot).forEach((b) =>
      b.addEventListener("click", async () => {
        const ok = await confirmBox("Canjear premio", `¿Canjear "${b.dataset.name}" por ${b.dataset.cost} puntos?`, "Canjear");
        if (!ok) return;
        try {
          const r = await api(`/customers/${state.customer.id}/redeem`, { method: "POST", body: { rewardId: Number(b.dataset.redeem) } });
          lastResult = { big: `🎁 ${r.reward}`, html: `Canje registrado. Entregá el premio. Nuevo saldo: <b>${r.customer.points}</b> pts.` };
          state = { ...state, ...r };
          render(true);
          toast("Premio canjeado");
        } catch (err) {
          toast(err.message, "error");
        }
      })
    );
    $$("[data-void]", slot).forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmBox("Anular movimiento", "Se revierte el movimiento y sus puntos. Queda registro de la anulación.", "Anular", true))) return;
        try {
          state = { ...state, ...(await api(`/transactions/${b.dataset.void}/void`, { method: "POST" })) };
          lastResult = null;
          render(true);
          toast("Movimiento anulado");
        } catch (err) {
          toast(err.message, "error");
        }
      })
    );
    $("#copy", slot)?.addEventListener("click", async () => {
      const input = $("#card-link", slot);
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand("copy");
      }
      toast("Enlace copiado");
    });
    $("#adjust", slot)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      try {
        state = { ...state, ...(await api(`/customers/${state.customer.id}/adjust`, { method: "POST", body: { points: Number(f.points.value), note: f.note.value } })) };
        lastResult = null;
        render(true);
        toast("Ajuste aplicado");
      } catch (err) {
        toast(err.message, "error");
      }
    });
    $("#del", slot)?.addEventListener("click", async () => {
      if (!(await confirmBox("Eliminar cliente", `Se borrarán los datos y el historial de ${state.customer.fullName}. No se puede deshacer.`, "Eliminar", true))) return;
      try {
        await api(`/customers/${state.customer.id}`, { method: "DELETE" });
        toast("Cliente eliminado");
        slot.innerHTML = '<div class="empty-state"><b>Cliente eliminado</b></div>';
      } catch (err) {
        toast(err.message, "error");
      }
    });
  };

  render();
}

function currencySymbol() {
  return moneyFmt.formatToParts(0).find((p) => p.type === "currency")?.value || "$";
}

// =====================================================================
// CLIENTES
// =====================================================================
async function viewClientes(el, id) {
  if (id) {
    const detail = await api(`/customers/${id}`);
    el.innerHTML = `<a class="back" href="#/clientes">← Clientes</a><div id="slot"></div>`;
    customerPanel($("#slot", el), detail);
    return;
  }
  let search = "";
  let sort = "recent";
  let offset = 0;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Clientes</h1><p class="sub" id="count"></p></div>
      <div class="actions">
        ${isOwner() ? '<a class="btn" href="/api/admin/export/customers.csv">Exportar CSV</a>' : ""}
        <button class="btn primary" id="add">+ Cliente nuevo</button>
      </div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:14px">
        <input class="input" id="search" placeholder="Buscar por nombre, correo, teléfono o código" type="search">
        <select class="input" id="sort">
          <option value="recent">Más recientes</option><option value="points">Más puntos</option>
          <option value="visits">Más visitas</option><option value="lastVisit">Última visita</option><option value="name">Nombre</option>
        </select>
      </div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>Cliente</th><th>Código</th><th class="r">Puntos</th><th class="r">Visitas</th><th class="r">Total</th><th>Última visita</th><th>Wallet</th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <div style="text-align:center;margin-top:14px"><button class="btn" id="more" hidden>Cargar más</button></div>
    </div>`;

  const load = async (append = false) => {
    const r = await api(`/customers?search=${encodeURIComponent(search)}&sort=${sort}&limit=50&offset=${offset}`);
    const html = r.customers
      .map(
        (c) => `<tr class="link" data-id="${c.id}">
          <td><b>${esc(c.fullName)}</b><br><small class="muted">${esc(phoneFmt(c.phone))}</small></td>
          <td class="num">${esc(c.code)}</td><td class="r">${c.points}</td><td class="r">${c.visits}</td><td class="r">${esc(c.totalSpentText)}</td>
          <td>${c.lastVisitAt ? ago(c.lastVisitAt) : '<span class="muted">—</span>'}</td>
          <td>${c.appleInstalled ? '<span class="pill ok">Apple</span> ' : ""}${c.googleClicked ? '<span class="pill ok">Google</span>' : ""}${!c.appleInstalled && !c.googleClicked ? '<span class="pill">Web</span>' : ""}</td>
        </tr>`
      )
      .join("");
    const rows = $("#rows", el);
    if (append) rows.insertAdjacentHTML("beforeend", html);
    else rows.innerHTML = html || '<tr><td colspan="7" class="muted">No hay clientes que coincidan.</td></tr>';
    $$("tr[data-id]", rows).forEach((tr) => (tr.onclick = () => (location.hash = `#/clientes/${tr.dataset.id}`)));
    $("#count", el).textContent = `${intFmt(r.total)} ${r.total === 1 ? "cliente" : "clientes"}`;
    $("#more", el).hidden = offset + r.customers.length >= r.total;
  };
  let t;
  $("#search", el).addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      search = e.target.value.trim();
      offset = 0;
      load();
    }, 250);
  });
  $("#sort", el).addEventListener("change", (e) => {
    sort = e.target.value;
    offset = 0;
    load();
  });
  $("#more", el).addEventListener("click", () => {
    offset += 50;
    load(true);
  });
  $("#add", el).addEventListener("click", () => newCustomerDialog((r) => (location.hash = `#/clientes/${r.customer.id}`)));
  await load();
  const off = onActivity((a) => a.type === "signup" && !search && sort === "recent" && ((offset = 0), load()));
  return off;
}

// =====================================================================
// PREMIOS
// =====================================================================
async function viewPremios(el) {
  const render = async () => {
    const { rewards } = await api("/rewards");
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Premios</h1><p class="sub">Regla actual: ${esc(me.business.rule)}. Cambios se reflejan al instante en las tarjetas.</p></div>
        ${isOwner() ? '<div class="actions"><button class="btn primary" id="add">+ Nuevo premio</button></div>' : ""}
      </div>
      <div class="rewards-grid">${
        rewards
          .map(
            (r) => `<div class="reward-card ${r.active ? "" : "off"}">
              <div class="cost">${r.pointsCost} <small>puntos</small></div>
              <b>${esc(r.name)}</b>
              <p>${esc(r.description) || "&nbsp;"}</p>
              <div class="foot"><span class="pill ${r.active ? "ok" : ""}">${r.active ? "Activo" : "Pausado"} · ${r.redeemed} canjes</span>
              ${isOwner() ? `<button class="btn sm" data-edit="${r.id}">Editar</button>` : ""}</div>
            </div>`
          )
          .join("") || '<div class="empty-state"><b>Sin premios</b>Creá el primero para que tus clientes tengan una meta.</div>'
      }</div>`;
    $("#add", el)?.addEventListener("click", () => rewardDialog(null, render));
    $$("[data-edit]", el).forEach((b) => b.addEventListener("click", () => rewardDialog(rewards.find((r) => r.id === Number(b.dataset.edit)), render)));
  };
  await render();
}

function rewardDialog(r, done) {
  const d = modal(`<h3>${r ? "Editar premio" : "Nuevo premio"}</h3>
    <form id="rf">
      <label class="field"><span>Nombre</span><input class="input" name="name" required maxlength="60" value="${esc(r?.name)}" placeholder="Ej. Papas clásicas gratis"></label>
      <label class="field"><span>Descripción (opcional)</span><input class="input" name="description" maxlength="160" value="${esc(r?.description)}"></label>
      <label class="field"><span>Puntos necesarios</span><input class="input" name="pointsCost" type="number" min="1" step="1" required value="${r?.pointsCost ?? ""}"><small id="equiv"></small></label>
      <label class="check"><input type="checkbox" name="active" ${!r || r.active ? "checked" : ""}> Activo (visible para los clientes)</label>
      <p class="error-box" id="rf-err" hidden></p>
      <div class="actions">${r ? '<button type="button" class="btn danger" id="rf-del" style="margin-right:auto">Eliminar</button>' : ""}
        <button type="button" class="btn" id="rf-cancel">Cancelar</button><button class="btn primary">Guardar</button></div>
    </form>`);
  const f = $("#rf", d);
  const equiv = () => {
    const rule = me.business.pointsRule;
    const pts = Number(f.pointsCost.value) || 0;
    $("#equiv", d).textContent =
      pts && rule.mode === "amount" ? `≈ ${money(Math.ceil(pts / rule.points) * rule.spend * minorFactor())} en compras` : pts && rule.mode === "visit" ? `≈ ${Math.ceil(pts / rule.perVisit)} visitas` : "";
  };
  f.pointsCost.addEventListener("input", equiv);
  equiv();
  $("#rf-cancel", d).addEventListener("click", () => d.close());
  $("#rf-del", d)?.addEventListener("click", async () => {
    d.close();
    if (!(await confirmBox("Eliminar premio", `¿Eliminar "${r.name}"? Los canjes anteriores quedan en el historial.`, "Eliminar", true))) return;
    await api(`/rewards/${r.id}`, { method: "DELETE" });
    toast("Premio eliminado");
    done();
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: f.name.value, description: f.description.value, pointsCost: Number(f.pointsCost.value), active: f.active.checked };
    try {
      await api(r ? `/rewards/${r.id}` : "/rewards", { method: r ? "PUT" : "POST", body });
      d.close();
      toast("Premio guardado");
      done();
    } catch (err) {
      $("#rf-err", d).textContent = err.message;
      $("#rf-err", d).hidden = false;
    }
  });
}

// =====================================================================
// PROMOCIONES
// =====================================================================
async function viewPromos(el) {
  const render = async () => {
    const p = await api("/promotions");
    const w = p.audience;
    el.innerHTML = `
      <div class="page-head"><div><h1>Promociones</h1><p class="sub">Llegan como notificación a las wallets y aparecen en la tarjeta web al instante.</p></div></div>
      <div class="grid-2">
        <div class="stack">
          ${
            p.current
              ? `<div class="card"><div class="card-head"><h2>Promoción activa</h2>${isOwner() ? '<button class="btn sm danger" id="clear">Quitar</button>' : ""}</div>
                  <b>${esc(p.current.title)}</b><p class="muted" style="margin:4px 0 0">${esc(p.current.message)}</p></div>`
              : ""
          }
          ${
            isOwner()
              ? `<form class="card" id="pf">
                  <h2>Nueva promoción</h2>
                  <label class="field"><span>Título</span><input class="input" name="title" maxlength="40" required placeholder="Ej. ¡Doble puntos este viernes!"></label>
                  <label class="field"><span>Mensaje</span><textarea class="input" name="message" maxlength="240" required placeholder="Ej. Este viernes de 6 a 10 p. m. todas las compras suman el doble. ¡Te esperamos!"></textarea></label>
                  <button class="btn primary big">Enviar a todos los clientes</button>
                  <p class="hint">Apple Wallet: ${w.apple.enabled ? "activo — notificación en pantalla bloqueada" : "no configurado"} · Google Wallet: ${
                    w.google.enabled ? "activo — hasta 3 notificaciones por día" : "no configurado"
                  } · Tarjeta web: siempre.</p>
                </form>`
              : '<div class="info-box">Solo el dueño puede enviar promociones.</div>'
          }
          <div class="card"><h2>Historial</h2>
            <ul class="feed">${
              p.history.map((h) => `<li><span class="dot">📣</span><span class="main"><b>${esc(h.title)}</b><small>${esc(h.message)} · ${dateTime(h.created_at)}</small></span></li>`).join("") ||
              '<li class="muted">Todavía no se han enviado promociones.</li>'
            }</ul>
          </div>
        </div>
        <div>
          <div class="lock" aria-label="Vista previa de la notificación">
            <div class="time">${new Intl.DateTimeFormat(me.business.locale, { hour: "numeric", minute: "2-digit", hour12: false }).format(new Date())}</div>
            <div class="notif"><img src="/media/logo.png" alt=""><div><b id="pv-t">${esc(p.current?.title || "Título de la promoción")}</b><p id="pv-m">${esc(p.current?.message || "Así verá tu cliente el mensaje en su celular.")}</p><small>${esc(me.business.programName)} · ahora</small></div></div>
          </div>
          <p class="hint">${w.optIn} clientes aceptaron recibir promociones. Las wallets muestran el mensaje a quien tenga la tarjeta instalada.</p>
        </div>
      </div>`;
    const f = $("#pf", el);
    if (f) {
      f.title.addEventListener("input", () => ($("#pv-t", el).textContent = f.title.value || "Título de la promoción"));
      f.message.addEventListener("input", () => ($("#pv-m", el).textContent = f.message.value || "…"));
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!(await confirmBox("Enviar promoción", "Se enviará a todas las tarjetas activas. ¿Continuar?", "Enviar"))) return;
        try {
          await api("/promotions", { method: "POST", body: { title: f.title.value, message: f.message.value } });
          toast("Promoción enviada 📣");
          render();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }
    $("#clear", el)?.addEventListener("click", async () => {
      await api("/promotions/current", { method: "DELETE" });
      toast("Promoción retirada");
      render();
    });
  };
  await render();
}

// =====================================================================
// QR DE REGISTRO (póster imprimible)
// =====================================================================
async function viewQr(el) {
  const r = await api("/registration-qr");
  const p = r.program;
  const isLan = r.url.startsWith("http://");
  const suggest = location.protocol === "https:" && !r.url.startsWith(location.origin) && isOwner();
  el.innerHTML = `
    <div class="page-head">
      <div><h1>QR de registro</h1><p class="sub">Imprimilo y ponelo en caja, en la mesa o en el camión.</p></div>
      <div class="actions"><button class="btn primary" id="print">Imprimir póster</button></div>
    </div>
    ${isLan ? `<div class="info-box" style="margin-bottom:16px">Este QR apunta a <b>${esc(r.url)}</b> (sin https): funciona con celulares conectados al mismo Wi-Fi que esta computadora. Para que funcione con datos móviles usá un túnel https o un dominio (Ajustes → URL pública).</div>` : ""}
    ${suggest ? `<div class="ok-box" style="margin-bottom:16px">Estás usando <b>${esc(location.origin)}</b>. <button class="btn sm" id="use-origin">Usar esta URL para el QR</button></div>` : ""}
    <div class="poster">
      <div class="top"><img src="${esc(p.logoUrl)}" alt=""><div><h2>${esc(p.programName)}</h2><p>${esc(p.businessName)}</p></div></div>
      <div class="body">
        <h3>Sumá puntos en cada compra</h3>
        <div class="muted">${esc(p.rule)}</div>
        ${p.welcomeBonus > 0 ? `<div class="perk">🎁 ${p.welcomeBonus} puntos de regalo al registrarte</div>` : ""}
        <div class="qr-big">${r.svg}</div>
        <div class="steps"><div><b>1</b>Escaneá con la cámara</div><div><b>2</b>Llená tus datos</div><div><b>3</b>Guardá tu tarjeta</div></div>
        <div class="url">${esc(r.url)}</div>
      </div>
    </div>`;
  $("#print", el).addEventListener("click", () => print());
  $("#use-origin", el)?.addEventListener("click", async () => {
    await api("/settings", { method: "PUT", body: { publicUrl: location.origin } });
    toast("URL pública actualizada");
    route();
  });
}

// =====================================================================
// AJUSTES
// =====================================================================
async function viewConfig(el) {
  const data = await api("/settings");
  const s = data.settings;
  const w = data.wallet;
  const statusItem = (name, st) => `<li><b>${name}</b> <span class="pill ${st.enabled ? "ok" : "warn"}">${st.enabled ? "Activo" : "Falta configurar"}</span>
    ${st.missing.length ? `<ul>${st.missing.map((m) => `<li><code>${esc(m)}</code></li>`).join("")}</ul>` : ""}
    ${st.warnings.length ? `<ul>${st.warnings.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}</li>`;

  el.innerHTML = `
    <div class="page-head"><div><h1>Ajustes</h1><p class="sub">Todo lo que ve el cliente se puede personalizar por negocio.</p></div></div>
    <form id="cf" class="config-grid">
      <div class="stack">
        <section class="card"><h2>Marca</h2>
          <div class="row">
            <label class="field"><span>Nombre del negocio</span><input class="input" name="businessName" value="${esc(s.businessName)}" maxlength="40"></label>
            <label class="field"><span>Nombre del programa</span><input class="input" name="programName" value="${esc(s.programName)}" maxlength="30"></label>
          </div>
          <label class="field"><span>Eslogan</span><input class="input" name="tagline" value="${esc(s.tagline)}" maxlength="120"></label>
          <div class="row">
            ${["primaryColor:Color de la tarjeta", "accentColor:Color de acento", "textColor:Color del texto"]
              .map((x) => {
                const [k, label] = x.split(":");
                return `<label class="field"><span>${label}</span><div class="color-row"><input type="color" name="${k}" value="${esc(s[k])}"><code>${esc(s[k])}</code></div></label>`;
              })
              .join("")}
          </div>
          <div class="field"><span>Logo (PNG cuadrado, idealmente 660×660)</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="file" accept="image/png" id="logo-file" hidden><button type="button" class="btn" id="logo-btn">Subir logo</button>
            ${data.customLogo ? '<button type="button" class="btn ghost" id="logo-reset">Usar logo por defecto</button>' : ""}</div></div>
        </section>

        <section class="card"><h2>Reglas de puntos</h2>
          <label class="check"><input type="radio" name="mode" value="amount" ${s.pointsRule.mode === "amount" ? "checked" : ""}> Por monto de compra</label>
          <label class="check"><input type="radio" name="mode" value="visit" ${s.pointsRule.mode === "visit" ? "checked" : ""}> Por visita (tipo tarjeta de sellos)</label>
          <div class="row" style="margin-top:10px">
            <label class="field" data-mode="amount"><span>Puntos</span><input class="input" type="number" name="points" min="1" step="1" value="${s.pointsRule.points}"></label>
            <label class="field" data-mode="amount"><span>por cada (monto)</span><input class="input" type="number" name="spend" min="0.01" step="any" value="${s.pointsRule.spend}"></label>
            <label class="field" data-mode="visit"><span>Puntos por visita</span><input class="input" type="number" name="perVisit" min="1" step="1" value="${s.pointsRule.perVisit}"></label>
            <label class="field"><span>Bono de bienvenida</span><input class="input" type="number" name="welcomeBonus" min="0" step="1" value="${s.welcomeBonus}"></label>
          </div>
          <p class="hint" id="rule-example"></p>
        </section>

        <section class="card"><h2>Región</h2>
          <div class="row">
            <label class="field"><span>Moneda (ISO)</span><input class="input" name="currencyCode" value="${esc(s.currency.code)}" maxlength="3"></label>
            <label class="field"><span>Decimales</span><input class="input" type="number" name="currencyDecimals" min="0" max="3" value="${s.currency.decimals}"></label>
            <label class="field"><span>Prefijo telefónico</span><input class="input" name="phonePrefix" value="${esc(s.phonePrefix)}"></label>
            <label class="field"><span>País (ISO)</span><input class="input" name="countryCode" value="${esc(s.countryCode)}" maxlength="2"></label>
            <label class="field"><span>Idioma/formato</span><input class="input" name="locale" value="${esc(s.locale)}"></label>
            <label class="field"><span>Zona horaria</span><input class="input" name="timezone" value="${esc(s.timezone)}"></label>
          </div>
        </section>

        <section class="card"><h2>Contacto</h2>
          <div class="row">
            <label class="field"><span>Dirección</span><input class="input" name="address" value="${esc(s.contact.address)}"></label>
            <label class="field"><span>Horario</span><input class="input" name="hours" value="${esc(s.contact.hours)}"></label>
            <label class="field"><span>WhatsApp</span><input class="input" name="whatsapp" value="${esc(s.contact.whatsapp)}"></label>
            <label class="field"><span>Instagram</span><input class="input" name="instagram" value="${esc(s.contact.instagram)}"></label>
          </div>
        </section>

        <section class="card"><h2>Ubicación (Apple Wallet)</h2>
          <p class="hint" style="margin-top:0">Con coordenadas, el iPhone muestra la tarjeta en la pantalla bloqueada cuando el cliente está cerca del local.</p>
          <div class="row">
            <label class="field"><span>Latitud</span><input class="input" name="latitude" value="${s.location.latitude ?? ""}" placeholder="10.0163"></label>
            <label class="field"><span>Longitud</span><input class="input" name="longitude" value="${s.location.longitude ?? ""}" placeholder="-84.2116"></label>
          </div>
          <label class="field"><span>Mensaje al estar cerca</span><input class="input" name="relevantText" value="${esc(s.location.relevantText)}" maxlength="80"></label>
        </section>

        <section class="card"><h2>URL pública</h2>
          <label class="field"><span>URL base (vacía = IP de la red local)</span><input class="input" name="publicUrl" value="${esc(s.publicUrl)}" placeholder="https://mi-negocio.trycloudflare.com">
          <small>Actual: ${esc(data.baseUrl)}. Necesaria en https para Google Wallet y para que Apple Wallet se actualice solo.</small></label>
        </section>

        <section class="card"><h2>Términos y privacidad</h2>
          <textarea class="input" name="termsText" rows="6">${esc(s.termsText)}</textarea>
        </section>
        <div class="savebar"><span class="muted" id="dirty"></span><button class="btn primary big">Guardar cambios</button></div>
      </div>

      <aside class="stack sticky">
        <div class="card"><h2>Vista previa</h2>
          <div class="mini-pass" id="mini"><div class="top"><img data-logo src="/media/logo.png" alt=""><div><b id="mp-biz">${esc(s.businessName)}</b><div style="font-size:12px;opacity:.85" id="mp-prog">${esc(s.programName)}</div></div>
          <div class="pts"><span class="lbl">PUNTOS</span><span class="big">42</span></div></div><div class="name"><span class="lbl">MIEMBRO</span>María Rodríguez</div></div>
        </div>
        <div class="card"><h2>Wallets</h2><ul class="status-list">${statusItem("Apple Wallet", w.apple)}${statusItem("Google Wallet", w.google)}</ul>
          <p class="hint">Sin wallets configuradas, el cliente usa la tarjeta web (con QR, puntos en vivo y opción de instalarla). Ver README → Wallets.</p></div>
        <div class="card" id="users-card"><h2>Usuarios del panel</h2><div id="users"></div></div>
        <div class="card"><h2>Datos</h2><a class="btn" href="/api/admin/export/customers.csv">Exportar clientes (CSV)</a></div>
      </aside>
    </form>`;

  const f = $("#cf", el);
  const syncMode = () => $$("[data-mode]", f).forEach((x) => (x.hidden = x.dataset.mode !== f.mode.value));
  const example = () => {
    const mode = f.mode.value;
    const cur = f.currencyCode.value.toUpperCase() || "CRC";
    let fmt;
    try {
      fmt = new Intl.NumberFormat(f.locale.value || "es-CR", { style: "currency", currency: cur, maximumFractionDigits: Number(f.currencyDecimals.value) || 0 });
    } catch {
      fmt = moneyFmt;
    }
    const spend = Number(f.spend.value) || 1;
    const sample = spend * 5.5;
    $("#rule-example", el).textContent =
      mode === "visit"
        ? `Ejemplo: cada compra suma ${f.perVisit.value} punto(s), sin importar el monto.`
        : `Ejemplo: una compra de ${fmt.format(sample)} suma ${Math.floor(sample / spend) * (Number(f.points.value) || 0)} puntos.`;
  };
  const preview = () => {
    const mini = $("#mini", el);
    mini.style.setProperty("--brand", f.primaryColor.value);
    mini.style.setProperty("--brand-ink", f.textColor.value);
    mini.style.setProperty("--accent", f.accentColor.value);
    $("#mp-biz", el).textContent = f.businessName.value;
    $("#mp-prog", el).textContent = f.programName.value;
    $$(".color-row", f).forEach((r) => ($("code", r).textContent = $("input", r).value.toUpperCase()));
  };
  f.addEventListener("input", () => {
    syncMode();
    example();
    preview();
    $("#dirty", el).textContent = "Cambios sin guardar";
  });
  syncMode();
  example();
  preview();

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      businessName: f.businessName.value,
      programName: f.programName.value,
      tagline: f.tagline.value,
      primaryColor: f.primaryColor.value,
      accentColor: f.accentColor.value,
      textColor: f.textColor.value,
      pointsRule: { mode: f.mode.value, points: Number(f.points.value), spend: Number(f.spend.value), perVisit: Number(f.perVisit.value) },
      welcomeBonus: Number(f.welcomeBonus.value),
      currency: { code: f.currencyCode.value, decimals: Number(f.currencyDecimals.value) },
      phonePrefix: f.phonePrefix.value.trim(),
      countryCode: f.countryCode.value,
      locale: f.locale.value.trim(),
      timezone: f.timezone.value.trim(),
      contact: { address: f.address.value, hours: f.hours.value, whatsapp: f.whatsapp.value, instagram: f.instagram.value },
      location: { latitude: f.latitude.value.trim(), longitude: f.longitude.value.trim(), relevantText: f.relevantText.value },
      publicUrl: f.publicUrl.value.trim(),
      termsText: f.termsText.value,
    };
    try {
      await api("/settings", { method: "PUT", body });
      await refreshMe();
      toast("Ajustes guardados");
      $("#dirty", el).textContent = "";
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#logo-btn", el).addEventListener("click", () => $("#logo-file", el).click());
  $("#logo-file", el).addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api("/settings/logo", { method: "POST", body: { dataUrl: reader.result } });
        toast("Logo actualizado");
        applyBrand();
        route();
      } catch (err) {
        toast(err.message, "error");
      }
    };
    reader.readAsDataURL(file);
  });
  $("#logo-reset", el)?.addEventListener("click", async () => {
    await api("/settings/logo", { method: "DELETE" });
    applyBrand();
    route();
  });

  const loadUsers = async () => {
    const { users } = await api("/users");
    $("#users", el).innerHTML = `<ul class="feed">${users
      .map(
        (u) => `<li><span class="dot">${u.role === "owner" ? "★" : "👤"}</span><span class="main"><b>${esc(u.name)}</b><small>${esc(u.email)} · ${u.role === "owner" ? "Dueño" : "Cajero"}</small></span>
        ${u.id !== me.user.id ? `<button type="button" class="btn sm ghost" data-del-user="${u.id}">Quitar</button>` : ""}</li>`
      )
      .join("")}</ul>
      <details class="more"><summary>+ Agregar usuario</summary>
        <div id="uf" style="margin-top:10px">
          <label class="field"><span>Nombre</span><input class="input" data-u="name"></label>
          <label class="field"><span>Correo</span><input class="input" data-u="email" type="email"></label>
          <label class="field"><span>Contraseña</span><input class="input" data-u="password" type="text" autocomplete="off"></label>
          <label class="field"><span>Rol</span><select class="input" data-u="role"><option value="staff">Cajero (solo caja y clientes)</option><option value="owner">Dueño (acceso total)</option></select></label>
          <button type="button" class="btn primary" id="u-add">Crear usuario</button>
        </div>
      </details>`;
    $$("[data-del-user]", el).forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmBox("Quitar usuario", "El usuario ya no podrá ingresar al panel.", "Quitar", true))) return;
        await api(`/users/${b.dataset.delUser}`, { method: "DELETE" });
        loadUsers();
      })
    );
    $("#u-add", el).addEventListener("click", async () => {
      const v = Object.fromEntries($$("[data-u]", el).map((i) => [i.dataset.u, i.value]));
      try {
        await api("/users", { method: "POST", body: v });
        toast("Usuario creado");
        loadUsers();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  };
  loadUsers();
}

// ---------------- Arranque ----------------
fetch("/api/admin/session")
  .then((r) => r.json())
  .then((s) => (s.authenticated ? start() : showLogin()))
  .catch(() => showLogin());
