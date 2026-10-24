const CLOSERS = {
  'health.water_progress': '💙 Um gole de cada vez. Você está cuidando de você.',
  'health.diet_menu': '💪 Cada refeição do plano conta. Constância ganha de pressa.',
  'financeiro.daily_summary': '✨ Clareza hoje, tranquilidade amanhã.'
};
const HEADS = {
  'health.water_progress': '💧 Hora de beber água!',
  'health.diet_menu': '🍽️ Hora da sua refeição!',
  'financeiro.daily_summary': '📊 Seu resumo financeiro'
};
const TELEGRAM_BUTTON = /\n*Quanto você bebeu agora\?[\s\S]*$/;
const STYLED = /^(?:💧|🍽️|📊|💰|🐷|🚗|🥗)/;

function clean(value) {
  return String(value || '').replace(TELEGRAM_BUTTON, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function whatsappOutbound({ event_type, title, message } = {}) {
  const event = Object.hasOwn(CLOSERS, event_type) ? event_type : 'financeiro.daily_summary';
  const closer = CLOSERS[event];
  let body = clean(message);
  if (body.endsWith(closer)) body = body.slice(0, -closer.length).trim();
  const styled = STYLED.test(body);
  const heading = clean(title);
  const text = styled
    ? body
    : [HEADS[event], heading && heading !== body ? heading : '', body].filter(Boolean).join('\n\n');
  const withCloser = text.includes(closer) ? text : `${text}\n\n${closer}`;
  return withCloser.slice(0, 4000);
}
