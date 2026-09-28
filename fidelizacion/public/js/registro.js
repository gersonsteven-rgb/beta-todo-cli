import { api, applyBrand, esc, remember, remembered } from "./common.js";

const $ = (s) => document.querySelector(s);
const form = $("#form");
const errorEl = $("#error");

const program = await api("/api/public/program");
applyBrand(program);
document.title = `${program.programName} · ${program.businessName}`;

if (program.welcomeBonus > 0) {
  $("#welcome-pts").textContent = `+${program.welcomeBonus} pts`;
  $("#welcome-txt").textContent = "de regalo al registrarte";
}
const [rulePts, ...ruleRest] = program.rule.split(" por ");
$("#rule-pts").textContent = rulePts;
$("#rule-txt").textContent = ruleRest.length ? `por ${ruleRest.join(" por ")}` : "en cada compra";
$("#prefix").textContent = program.phonePrefix;
$("#rewards").innerHTML = program.rewards
  .slice(0, 6)
  .map((r) => `<li><b>${r.cost} pts</b> · ${esc(r.name)}</li>`)
  .join("");
$("#terms-text").textContent = program.termsText;
const c = program.contact || {};
$("#contact").innerHTML = [c.address, c.hours, c.instagram].filter(Boolean).map(esc).join("<br>");

// Si este celular ya tiene tarjeta, ofrecer abrirla.
const saved = remembered();
if (saved) {
  fetch(`/api/public/cards/${saved}`).then((r) => {
    if (!r.ok) return;
    $("#existing-link").href = `/tarjeta/${saved}`;
    $("#existing").hidden = false;
  });
}

$("#terms-open").addEventListener("click", () => $("#terms").showModal());

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const data = Object.fromEntries(new FormData(form));
  if (!data.fullName?.trim() || !data.email?.trim() || !data.phone?.trim()) return showError("Completá nombre, correo y teléfono.");
  if (!form.acceptTerms.checked) return showError("Para continuar tenés que aceptar los términos.");
  const btn = $("#submit");
  btn.disabled = true;
  btn.textContent = "Creando tu tarjeta…";
  try {
    const res = await api("/api/public/register", {
      method: "POST",
      body: { ...data, acceptTerms: true, marketingOptIn: form.marketingOptIn.checked },
    });
    remember(res.serial);
    location.href = `${res.cardUrl}${res.existing ? "?recuperada=1" : "?nueva=1"}`;
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = "Obtener mi tarjeta";
  }
});
