import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsappOutbound } from '../lib/outbound-message.mjs';

const waterBot = [
  '💧 Hora de beber água, Ana!',
  '📅 24/10/2026 · ⏰ 10:00',
  '🥤 Meta (Garrafa): 2000 ml',
  '✅ Já registradas: 400 / 2000 ml',
  '🎯 Faltam 1600 ml para a meta.',
  'Quanto você bebeu agora? Escolha 100, 200, 300, 400, 500 ml, 1 L ou 2 L nos botões ou responda a esta mensagem, por exemplo: 200 ml.'
].join('\n');

test('texto do bot de água perde a instrução de botão e ganha o fechamento', () => {
  const text = whatsappOutbound({ event_type: 'health.water_progress', title: 'Progresso de agua - Ana', message: waterBot });
  assert.match(text, /^💧 Hora de beber água, Ana!/);
  assert.doesNotMatch(text, /Progresso de agua/);
  assert.doesNotMatch(text, /botões|200 ml\.$/);
  assert.match(text, /Faltam 1600 ml/);
  assert.match(text, /Um gole de cada vez/);
  assert.equal(whatsappOutbound({ event_type: 'health.water_progress', title: 'x', message: text }), text);
});

test('dieta e financeiro simples entram no tom do bot', () => {
  const diet = whatsappOutbound({ event_type: 'health.diet_menu', title: 'Almoço', message: 'Arroz, feijão e salada.' });
  assert.match(diet, /^🍽️ Hora da sua refeição!/);
  assert.match(diet, /Almoço/);
  assert.match(diet, /Arroz, feijão e salada/);
  assert.match(diet, /Constância ganha de pressa/);
  const money = whatsappOutbound({ event_type: 'financeiro.daily_summary', title: 'Resumo', message: 'Receitas do mês: R$ 10,00' });
  assert.match(money, /^📊 Seu resumo financeiro/);
  assert.match(money, /R\$ 10,00/);
  assert.match(money, /Clareza hoje/);
});
