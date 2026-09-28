// Fachada de wallets: el resto de la app no sabe si hay Apple, Google o ninguna.
// Sin credenciales, todo sigue funcionando con la tarjeta web.
import * as apple from "./apple.js";
import * as google from "./google.js";

function logError(scope) {
  return (err) => console.error(`[${scope}]`, err.message);
}

export const wallet = {
  apple,
  google,

  status() {
    return { apple: apple.status(), google: google.status() };
  },

  links(customer) {
    return {
      apple: apple.status().enabled ? `/wallet/apple/${customer.serial}.pkpass` : null,
      google: google.status().enabled ? `/wallet/google/${customer.serial}` : null,
    };
  },

  // Cambió el saldo/historial de una tarjeta.
  async cardChanged(customer) {
    await Promise.all([apple.notifyChanged(customer).catch(logError("apple")), google.updateObject(customer).catch(logError("google"))]);
  },

  async cardDeleted(customer) {
    await google.expireObject(customer).catch(logError("google"));
  },

  // Cambió la marca o el catálogo: hay que refrescar todos los pases.
  async programChanged() {
    await Promise.all([
      apple.notifyAll().catch(logError("apple")),
      google
        .upsertClass()
        .then(() => google.updateAllObjects())
        .catch(logError("google")),
    ]);
  },

  async promoSent(promo) {
    await Promise.all([apple.notifyAll().catch(logError("apple")), google.sendClassMessage(promo).catch(logError("google"))]);
  },
};
