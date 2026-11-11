import { createHash } from 'node:crypto';
import { whatsappOutbound, WATER_CLOSERS } from './outbound-message.mjs';

export const WATER_MESSAGE_MODEL = 'openai/gpt-oss-120b';
export const CHOICES = [
  'gole caprichado',
  'pausa rapida',
  'garrafinha',
  'clarear mente',
  'ritmo do dia',
  'lembrete correria',
  'agua fresca',
  'adiantar meta',
  'comecar dia',
  'combater cansaco',
  'foco no dia',
  'humor nao vire cacto',
  'pausa trinta segundos',
  'combustivel pro corpo',
  'bater a meta',
  'consistencia',
  'tirar olho da tela',
  'encher garrafinha',
  'beba antes da sede',
  'fechar bloco do dia'
];

function cleanName(job) {
  const title = String(job?.title || '');
  const name = title.includes(' - ') ? title.split(' - ').slice(1).join(' - ').trim() : '';
  return name.replace(/[\r\n\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'você';
}

function extractProgress(message) {
  const str = String(message || '');
  const metaMatch = str.match(/Meta(?:\s*\([^)]*\))?:\s*([\d.]+)\s*ml/i);
  const doneMatch = str.match(/Já registradas:\s*([\d.]+)\s*\/\s*([\d.]+)\s*ml/i);
  const leftMatch = str.match(/Faltam\s*([\d.]+)\s*ml/i);
  const finished = /Meta de água concluída/i.test(str);
  if (!metaMatch && !doneMatch) return null;
  const meta = Number((metaMatch?.[1] || doneMatch?.[2] || '0').replace(/\./g, ''));
  const done = Number((doneMatch?.[1] || '0').replace(/\./g, ''));
  const left = leftMatch ? Number(leftMatch[1].replace(/\./g, '')) : Math.max(0, meta - done);
  return { meta, done, left, finished: finished || (meta > 0 && done >= meta) };
}

function makeProgressBar(done, meta) {
  if (!meta || meta <= 0) return '';
  const ratio = Math.min(Math.max(done / meta, 0), 1);
  const totalBlocks = 8;
  const filledBlocks = Math.round(ratio * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  const bar = '■'.repeat(filledBlocks) + '□'.repeat(emptyBlocks);
  const percent = Math.round((done / meta) * 100);
  return `[${bar}] ${percent}%`;
}

function formatProgress(p) {
  if (!p || !p.meta) return '';
  const bar = makeProgressBar(p.done, p.meta);
  if (p.finished) {
    return `\n\n🏆 *Uso diário:* ${bar} (${p.done} de ${p.meta} ml)\n🎉 *Meta de hoje concluída!* Mandou muito bem!`;
  }
  return `\n\n📊 *Uso diário:* ${bar} (${p.done} de ${p.meta} ml)\n🎯 *Faltam:* ${p.left} ml para a meta`;
}

export function messages(job) {
  const name = cleanName(job);
  const p = extractProgress(job?.message);
  const prog = formatProgress(p);
  const [c1, c2, c3, c4, c5, c6, c7, c8] = WATER_CLOSERS;

  return [
    `💧 ${name}, hora daquele gole caprichado de água! Bora manter o corpo hidratado.${prog}\n\n${c1}`,
    `💧 ${name}, que tal uma pausa rápida agora pra beber uma água?${prog}\n\n${c2}`,
    `💧 ${name}, sua garrafinha tá por perto? Dá uns bons goles aí agora pra manter o ritmo.${prog}\n\n${c1}`,
    `🧠💧 ${name}, antes de ir pra próxima tarefa, bebe um copo d'água. Ajuda demais a clarear as ideias.${prog}\n\n${c3}`,
    `💧 Bora de água agora, ${name}? Manter o ritmo durante o dia evita ter que beber tudo à noite.${prog}\n\n${c4}`,
    `⚡💧 E aí ${name}, na correria do dia a gente esquece, mas o corpo pede água. Toma um copo aí!${prog}\n\n${c5}`,
    `🌊💧 ${name}, hora de hidratar! Pega aquela água fresca e manda pra dentro.${prog}\n\n${c6}`,
    `✨💧 Passando pra lembrar da sua água, ${name}. Um copo agora já adianta bem a sua meta.${prog}\n\n${c7}`,
    `☀️💧 Bom dia, ${name}! Começar o dia com um bom copo d'água acorda o corpo e dá outro pique.${prog}\n\n${c8}`,
    `🔋💧 Bateu aquele cansaço ou lentidão, ${name}? Levanta, dá uma esticada e bebe uma água fresca.${prog}\n\n${c3}`,
    `💧 E aí, ${name}! Lembrete rápido pra tomar água e manter o foco nas coisas de hoje.${prog}\n\n${c1}`,
    `🌵💧 Ei, ${name}, não vá virar um cacto hoje! Pega um copo d'água agora mesmo.${prog}\n\n${c2}`,
    `💧 ${name}, faz uma pausa de 30 segundos, toma uma água e volta com tudo.${prog}\n\n${c4}`,
    `💧 ${name}, água é combustível pro cérebro e pro corpo. Não deixa de lado não!${prog}\n\n${c5}`,
    `🎯💧 ${name}, bora bater essa meta de água de hoje? Mais um copo pra conta!${prog}\n\n${c6}`,
    `🌱💧 ${name}, consistência é tudo: um gole aqui, outro ali, e a meta do dia tá batida.${prog}\n\n${c7}`,
    `👀💧 Hora de tirar o olho da tela rapidinho, ${name}. Bebe uma água e descansa a vista.${prog}\n\n${c8}`,
    `🥤💧 ${name}, olha pro lado... sua garrafinha tá cheia? Enche o copo e toma mais um pouco.${prog}\n\n${c1}`,
    `💧 Sabia, ${name}? Não espera dar sede pra beber água. Toma um copo agora pra se antecipar!${prog}\n\n${c2}`,
    `🏆💧 ${name}, tá indo bem! Mais uma dose de água pra fechar esse bloco do dia com chave de ouro.${prog}\n\n${c6}`
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
        reasoning_effort: 'low',
        max_completion_tokens: 1500,
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
            content: 'Escolha uma opção variada, direta e descontraída para o lembrete de hidratação de acordo com o horário. Você apenas escolhe o índice inteiro correspondente; não escreve texto e não fornece orientação médica.'
          },
          {
            role: 'user',
            content: JSON.stringify({ hour, date, choices: CHOICES })
          }
        ]
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(6000)
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
