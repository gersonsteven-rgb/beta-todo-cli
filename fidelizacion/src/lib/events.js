// Server-Sent Events: la tarjeta del cliente y el panel se actualizan en vivo.
const channels = new Map();

export function subscribe(channel, req, res, initial) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  if (initial !== undefined) send(res, "state", initial);
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    const set = channels.get(channel);
    set?.delete(res);
    if (set && set.size === 0) channels.delete(channel);
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function publish(channel, event, data) {
  for (const res of channels.get(channel) || []) send(res, event, data);
}

// Envía a todos los canales que empiezan con `prefix` (ej. todas las tarjetas abiertas).
export function publishAll(prefix, event, data) {
  for (const [channel, set] of channels) {
    if (channel.startsWith(prefix)) for (const res of set) send(res, event, data);
  }
}
