// Envío de notificaciones push de Apple Wallet (APNs HTTP/2).
// Para pases, el payload es un JSON vacío y el topic es el Pass Type ID:
// el iPhone responde pidiendo el pase actualizado al web service.
import http2 from "node:http2";

export function pushPassUpdates(tokens, { host, cert, key, passphrase, topic }) {
  if (!tokens.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const results = [];
    let pending = tokens.length;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      resolve(results);
    };
    const client = http2.connect(host, { cert, key, passphrase: passphrase || undefined });
    const timer = setTimeout(finish, 15000);
    client.on("error", (err) => {
      for (const token of tokens) {
        if (!results.some((r) => r.token === token)) results.push({ token, status: 0, error: err.message });
      }
      finish();
    });
    for (const token of tokens) {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        "apns-topic": topic,
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      req.setEncoding("utf8");
      req.on("response", (headers) => (status = headers[":status"]));
      req.on("data", (d) => (body += d));
      let ended = false;
      const end = (error) => {
        if (ended) return;
        ended = true;
        results.push({ token, status, body, error });
        if (--pending === 0) finish();
      };
      req.on("end", () => end());
      req.on("error", (err) => end(err.message));
      req.end("{}");
    }
  });
}
