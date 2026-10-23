// Copiar/adaptar SOMENTE no backend do Super App. Nao executar no frontend.
// O cron atual continua sendo responsavel por gerar os alertas nos horarios definidos.
export async function enqueueWhatsAppAlert({ eventType, profileId, title, message, dedupeKey }) {
  const origin = new URL(process.env.WHATSAPP_API_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('whatsapp_origin_invalid');
  const response = await fetch(new URL('/api/control?action=event', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_INTEGRATION_TOKEN}` },
    body: JSON.stringify({ source: 'superapp', event_type: eventType, audience: String(profileId), title, message, idempotency_key: dedupeKey }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`whatsapp_queue_http_${response.status}`);
  return response.json(); // 202 = na fila, ainda nao enviado. Reusar a mesma dedupeKey em retries.
}
