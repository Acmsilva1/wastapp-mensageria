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

export function whatsappOutbound({ event_type, title, message, agent_project, agent_request } = {}) {
  if(event_type==='agent.notice') {
    const reply=agent_request?`Responda CITANDO este aviso ou envie /agente ${agent_request.request_id} seguido da sua orientação. A resposta vale somente para este projeto e esta pergunta.`:'Aviso do projeto. O canal de resposta só abre quando o agente faz uma pergunta identificada.';
    const neutral=value=>String(value || '').replace(/\n{3,}/g,'\n\n').trim();
    return [`🦉 Agente · ${agent_project}`,neutral(title),neutral(message),reply].filter(Boolean).join('\n\n').slice(0,4000);
  }
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
