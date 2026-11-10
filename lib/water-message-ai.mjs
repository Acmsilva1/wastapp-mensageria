import { createHash } from 'node:crypto';
import { whatsappOutbound, WATER_CLOSERS } from './outbound-message.mjs';

export const WATER_MESSAGE_MODEL = 'openai/gpt-oss-120b';
export const CHOICES = [
  'original',
  'pausa gentil',
  'garrafinha',
  'foco e clareza',
  'autocuidado',
  'movimento e energia',
  'ritmo',
  'brinde à saúde',
  'energia matinal',
  'combate à moleza da tarde',
  'corujinha super app',
  'humor não vire cacto',
  'respiração e presença',
  'vitalidade e disposição',
  'reta final da meta',
  'hábito atômico',
  'pausa da tela',
  'parceira de mesa',
  'beba antes da sede',
  'disciplina e constância'
];

function cleanName(job) {
  const title = String(job?.title || '');
  const name = title.includes(' - ') ? title.split(' - ').slice(1).join(' - ').trim() : '';
  return name.replace(/[\r\n\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'você';
}

function extractProgress(message) {
  const str = String(message || '');
  const metaMatch = str.match(/Meta(?:\s*\([^)]*\))?:\s*(\d+)\s*ml/i);
  const doneMatch = str.match(/Já registradas:\s*(\d+)\s*\/\s*(\d+)\s*ml/i);
  const leftMatch = str.match(/Faltam\s*(\d+)\s*ml/i);
  const finished = /Meta de água concluída/i.test(str);
  if (!metaMatch && !doneMatch) return null;
  const meta = Number(metaMatch?.[1] || doneMatch?.[2] || 0);
  const done = Number(doneMatch?.[1] || 0);
  const left = leftMatch ? Number(leftMatch[1]) : Math.max(0, meta - done);
  return { meta, done, left, finished: finished || (meta > 0 && done >= meta) };
}

function formatProgress(p) {
  if (!p) return '';
  if (p.finished) return `\n\n🏆 *Meta de hoje batida!* (${p.done}/${p.meta} ml) — Continue se hidratando.`;
  if (p.done === 0) return `\n\n🎯 *Meta de hoje:* ${p.meta} ml. Vamos começar!`;
  return `\n\n📊 *Hoje:* ${p.done} de ${p.meta} ml (faltam ${p.left} ml)`;
}

export function messages(job) {
  const name = cleanName(job), original = whatsappOutbound(job);
  const p = extractProgress(job?.message);
  const prog = formatProgress(p);
  const [c1, c2, c3, c4, c5, c6, c7, c8] = WATER_CLOSERS;

  return [
    original,
    `💧 ${name}, faça uma pausa gentil e beba um pouco de água.\n\nSeu corpo agradece esse cuidado simples ao longo do dia.${prog}\n\n${c1}`,
    `💧 ${name}, sua garrafinha está chamando. Que tal alguns goles agora?\n\nManter a hidratação distribuída durante o dia ajuda a transformar cuidado em hábito.${prog}\n\n${c1}`,
    `🧠💧 ${name}, antes da próxima tarefa, reserve um instante para beber água.\n\nUma pausa curta hidrata o cérebro e ajuda você a retomar o foco com mais clareza.${prog}\n\n${c3}`,
    `🌿💧 ${name}, este é seu lembrete de autocuidado: água no copo e alguns goles sem pressa.\n\nHidratação também é carinho com a sua rotina de bem-estar.${prog}\n\n${c6}`,
    `⚡💧 ${name}, se você esteve em movimento ou na correria, aproveite para repor líquidos agora.\n\nSeu corpo perde água o tempo todo e merece essa reposição.${prog}\n\n${c5}`,
    `🌊💧 ${name}, mantenha o ritmo com uma pausa para água.\n\nPequenos lembretes ajudam a cuidar da hidratação sem deixar tudo para a noite.${prog}\n\n${c2}`,
    `✨💧 ${name}, um brinde ao cuidado de hoje: pegue sua água e faça essa pausa.\n\nO básico bem cuidado faz diferença.${prog}\n\n${c1}`,
    `☀️💧 Bom dia, ${name}! Hora de acordar o corpo de dentro para fora com um bom copo d'água.\n\nComeçar o dia hidratado dá outro pique.${prog}\n\n${c8}`,
    `🔋💧 Bateu aquele cansaço ou lentidão, ${name}? Muitas vezes é só o corpo pedindo água fresca.\n\nLevanta, estica o corpo e enche o copo para recarregar as energias.${prog}\n\n${c7}`,
    `🦉💧 Piu! A corujinha do Super App passou aqui para checar sua hidratação, ${name}.\n\nÁgua no copo agora para manter as ideias afiadas e o corpo leve.${prog}\n\n${c2}`,
    `🌵💧 Ei, ${name}, não vá virar um cacto hoje!\n\nLembrete amigo para tomar aquele gole d'água gelada ou fresca agora mesmo.${prog}\n\n${c1}`,
    `🧘💧 ${name}, solte os ombros, respire fundo e tome alguns goles com presença.\n\nEssa micropausa renova a sua atenção e faz muito bem para você.${prog}\n\n${c4}`,
    `💧 ${name}, água é o melhor combustível natural que existe para sua disposição e saúde.\n\nColoque a hidratação em primeiro lugar agora.${prog}\n\n${c6}`,
    `🎯💧 ${name}, cada copo te deixa mais perto da sua meta diária de hidratação.\n\nNão deixe acumular para a noite. Que tal tomar uma dose agora?${prog}\n\n${c5}`,
    `🌱💧 ${name}, grandes transformações começam com hábitos simples repetidos todo dia.\n\nBeba um gole de água agora e celebre essa constância.${prog}\n\n${c2}`,
    `👀💧 Hora de tirar os olhos da tela por um minuto, ${name}.\n\nOlhe para longe, beba água e dê um alívio para a mente.${prog}\n\n${c3}`,
    `🥤💧 ${name}, olha pro lado... sua garrafinha ou copo estão aí perto?\n\nDê alguns goles generosos agora mesmo e mantenha o ritmo.${prog}\n\n${c1}`,
    `💧 Sabia, ${name}? Quando a sede aparece, o corpo já está precisando de água há algum tempo.\n\nAntecipe-se e tome um copo agora mesmo!${prog}\n\n${c7}`,
    `🏆💧 ${name}, consistência vence a pressa. Mais um momento do dia dedicado ao seu bem-estar.\n\nPegue sua água e continue firme.${prog}\n\n${c8}`
  ].map(value => value.slice(0, 4000));
}

function fallbackIndex(job, count) {
  const key = String(job?.idempotency_key || `${job?.audience || ''}:${job?.created_at || ''}`);
  return createHash('sha256').update(key).digest().readUInt32BE(0) % count;
}

function providerKey(env) {
  const key = String(env.GROQ_API_KEY || '').trim();
  return key && !/[\r\n]/.test(key) ? key : null;
}

export async function waterOutbound(job, { env = process.env, fetcher = fetch } = {}) {
  const candidates = messages(job), fallback = candidates[fallbackIndex(job, candidates.length)], key = providerKey(env);
  if (!key) return fallback;
  try {
    const hour = String(job?.idempotency_key || '').match(/:(\d{2}):\d{2}:/)?.[1] || null;
    const date = String(job?.idempotency_key || '').split(':')[1] || null;
    const response = await fetcher('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'superapp-mensageria/1.0'
      },
      body: JSON.stringify({
        model: WATER_MESSAGE_MODEL,
        temperature: 0.7,
        max_completion_tokens: 200,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'water_message_choice',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['choice'],
              properties: {
                choice: {
                  type: 'integer',
                  minimum: 0,
                  maximum: candidates.length - 1
                }
              }
            }
          }
        },
        messages: [
          {
            role: 'system',
            content: 'Escolha uma opção variada, acolhedora e natural para o lembrete de hidratação de acordo com o horário. Você apenas escolhe o índice inteiro correspondente; não escreve texto e não fornece orientação médica.'
          },
          {
            role: 'user',
            content: JSON.stringify({ hour, date, choices: CHOICES })
          }
        ]
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'water_ai_rate_limited' : 'water_ai_unavailable');
    const body = await response.json(), parsed = JSON.parse(body.choices?.[0]?.message?.content);
    if (!Number.isInteger(parsed?.choice) || parsed.choice < 0 || parsed.choice >= candidates.length) throw new Error('water_ai_invalid');
    return candidates[parsed.choice];
  } catch (error) {
    const code = ['water_ai_rate_limited', 'water_ai_invalid'].includes(error?.message) ? error.message : 'water_ai_unavailable';
    console.warn(JSON.stringify({ event: 'water_message_fallback', code }));
    return fallback;
  }
}
