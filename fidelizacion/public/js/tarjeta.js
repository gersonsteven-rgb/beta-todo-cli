import { api, applyBrand, esc, fmtDate, plural, remember, toast } from "./common.js";

const $ = (s) => document.querySelector(s);
const serial = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop());
const params = new URLSearchParams(location.search);
const toastEl = $("#toast");

let card;
try {
  card = await api(`/api/public/cards/${serial}`);
} catch {
  document.querySelector("main").innerHTML =
    '<div class="center-msg"><h1>Tarjeta no disponible</h1><p>Puede que haya sido eliminada.</p><p><a class="btn primary" href="/registro">Crear una nueva</a></p></div>';
  throw new Error("card not found");
}
remember(serial);
applyBrand(card.program);
document.title = `Mi tarjeta · ${card.program.programName}`;
$("#qr").src = `/api/public/cards/${serial}/qr.svg`;

if (params.has("nueva") || params.has("recuperada")) {
  $("#welcome").hidden = false;
  $("#welcome-title").textContent = params.has("nueva") ? `¡Bienvenido/a, ${card.firstName}!` : `¡Hola de nuevo, ${card.firstName}!`;
  $("#welcome-text").textContent =
    params.has("nueva") && card.program.welcomeBonus > 0
      ? `Te regalamos ${plural(card.program.welcomeBonus, "punto", "puntos")}. Guardá tu tarjeta en el celular:`
      : "Esta es tu tarjeta. Guardala en el celular:";
  history.replaceState(null, "", location.pathname);
}

function animateNumber(el, from, to) {
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 700);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

function render(prevPoints = card.points) {
  const locale = card.program.locale;
  animateNumber($("#points"), prevPoints, card.points);
  $("#name").textContent = card.name;
  $("#visits").textContent = card.visits;
  $("#code").textContent = card.code;
  if (card.next) {
    $("#bar").style.width = `${Math.round(card.next.progress * 100)}%`;
    $("#next").innerHTML = `Te faltan <b>${plural(card.next.missing, "punto", "puntos")}</b> para: ${esc(card.next.name)}`;
  } else {
    $("#bar").style.width = "100%";
    $("#next").textContent = card.rewards.length ? "¡Tenés todos los premios desbloqueados!" : "Pronto habrá premios disponibles.";
  }

  $("#rewards").innerHTML =
    card.rewards
      .map(
        (r) => `<li class="reward ${r.unlocked ? "unlocked" : ""}">
          <span class="reward-badge" aria-hidden="true">${r.unlocked ? "★" : "☆"}</span>
          <span class="main"><b>${esc(r.name)}</b><small>${r.cost} pts${r.description ? ` · ${esc(r.description)}` : ""}</small></span>
          ${r.unlocked ? '<span class="tag ok">Disponible</span>' : `<span class="tag lock">Faltan ${r.missing}</span>`}
        </li>`
      )
      .join("") || '<li><p class="empty">Todavía no hay premios configurados.</p></li>';

  $("#history").innerHTML =
    card.history
      .map(
        (h) => `<li>
          <span class="main ${h.voided ? "voided" : ""}"><b>${esc(h.text)}</b><small>${fmtDate(h.createdAt, locale, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</small></span>
          <span class="pts ${h.points >= 0 ? "plus" : "minus"} ${h.voided ? "voided" : ""}">${h.points > 0 ? "+" : ""}${h.points}</span>
        </li>`
      )
      .join("") || '<li><p class="empty">Aún no hay movimientos.</p></li>';

  renderPromo();
  const c = card.program.contact || {};
  $("#foot").innerHTML = [c.address, c.hours, c.instagram, "Esta tarjeta es personal."].filter(Boolean).map(esc).join("<br>");
}

function renderPromo() {
  const p = card.program.promo;
  $("#promo").hidden = !p;
  if (p) {
    $("#promo-title").textContent = p.title;
    $("#promo-msg").textContent = p.message;
  }
}

// ---- Botones de wallet / instalación ----
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;

function setupWallets() {
  const { apple, google } = card.wallet;
  $("#apple").hidden = !apple || isAndroid;
  $("#google").hidden = !google || isIOS;
  if (apple) $("#apple").href = apple;
  if (google) $("#google").href = google;
  const hasWallet = (apple && !isAndroid) || (google && !isIOS);
  if (!hasWallet && !standalone) {
    $("#wallet-hint").textContent = isIOS
      ? "Tip: agregá esta tarjeta a tu pantalla de inicio para tenerla siempre a mano."
      : "Tip: instalá esta tarjeta en tu celular para tenerla siempre a mano.";
    if (isIOS) $("#install").hidden = false;
  } else {
    $("#wallet-hint").textContent = "";
  }
}

let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#install").hidden = false;
});
$("#install").addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("#install").hidden = true;
  } else if (isIOS) {
    $("#ios-help").showModal();
  }
});
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});

render(card.points);
setupWallets();

// ---- En vivo: cuando caja registra una compra, la tarjeta se actualiza sola ----
async function refresh() {
  try {
    const prev = card.points;
    card = await api(`/api/public/cards/${serial}`);
    applyBrand(card.program);
    render(prev);
    setupWallets();
  } catch {}
}

const es = new EventSource(`/api/public/cards/${serial}/stream`);
es.addEventListener("update", (e) => {
  const { state, event } = JSON.parse(e.data);
  const prev = card.points;
  const unlockedBefore = new Set(card.rewards.filter((r) => r.unlocked).map((r) => r.id));
  card = { ...card, ...state };
  render(prev);
  if (event) {
    const delta = event.points;
    const big = delta ? `<span class="big">${delta > 0 ? "+" : ""}${delta} pts</span>` : "";
    toast(toastEl, `${big}${esc(event.message)}`);
    navigator.vibrate?.(delta > 0 ? [60, 40, 60] : 80);
    const newly = card.rewards.filter((r) => r.unlocked && !unlockedBefore.has(r.id));
    if (newly.length && delta > 0) {
      setTimeout(() => toast(toastEl, `<span class="big">¡Premio desbloqueado!</span>${esc(newly.map((r) => r.name).join(", "))}`, 4500), 3800);
    }
  }
});
es.addEventListener("promo", (e) => {
  card.program.promo = JSON.parse(e.data);
  renderPromo();
  if (card.program.promo) toast(toastEl, `📣 ${esc(card.program.promo.title)}`);
});
es.addEventListener("program", () => refresh());
es.addEventListener("deleted", () => {
  es.close();
  document.querySelector("main").innerHTML = '<div class="center-msg"><h1>Tarjeta eliminada</h1><p>Tus datos fueron borrados del programa.</p></div>';
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
