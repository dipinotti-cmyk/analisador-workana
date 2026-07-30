// Analisador Workana — endpoint de IA
// Migrado de OpenAI para Gemini em 29/07/2026 (créditos da OpenAI acabaram e
// não há cartão que passe). Usa a camada de compatibilidade OpenAI da Gemini,
// então o formato de requisição e resposta continua idêntico ao anterior.
//
// A chave é lida de GEMINI_API_KEY e, se não existir, de OPENAI_API_KEY — assim
// dá para simplesmente colar a chave do Google no valor da variável antiga que
// já está cadastrada na Vercel, sem criar variável nova.
//
// reasoning_effort: 'none' desliga o "thinking" do Gemini 2.5. Sem isso o modelo
// gasta o orçamento de tokens pensando e pode devolver texto vazio.

export const config = { runtime: 'edge' };

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MODEL = 'gemini-2.5-flash';

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
});

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let prompt, maxTokens;
  try {
    const body = JSON.parse(await req.text());
    prompt = body.prompt;
    maxTokens = Math.min(Math.max(parseInt(body.max_tokens) || 1000, 100), 16000);
  } catch (e) {
    return json({ error: 'Body invalido: ' + e.message }, 400);
  }

  if (!prompt) {
    return json({ error: 'Prompt vazio' }, 400);
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: 'Chave nao configurada no servidor (GEMINI_API_KEY)' }, 500);
  }

  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    reasoning_effort: 'none',
    messages: [{ role: 'user', content: prompt }]
  });

  // O free tier da Gemini tem limite por minuto. Uma tentativa extra depois de
  // 3s resolve a esmagadora maioria dos 429 sem o usuario perceber.
  const call = () => fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': 'Bearer ' + apiKey
    },
    body: payload
  });

  try {
    let r = await call();

    if (r.status === 429) {
      await new Promise(res => setTimeout(res, 3000));
      r = await call();
      if (r.status === 429) {
        return json({ error: 'Limite gratuito da Gemini atingido. Espere 1 minuto e tente de novo.' }, 429);
      }
    }

    const data = await r.json();

    if (data.error) {
      return json({ error: 'Gemini: ' + (data.error.message || JSON.stringify(data.error)) }, 500);
    }
    if (!r.ok) {
      return json({ error: 'Gemini respondeu ' + r.status }, 500);
    }

    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';

    if (!text) {
      const motivo = choice?.finish_reason || 'sem finish_reason';
      return json({ error: 'Gemini respondeu vazio (' + motivo + '). Tente reduzir o texto da vaga ou aumentar o limite de tokens.' }, 500);
    }

    return json({ text }, 200);
  } catch (e) {
    return json({ error: 'Erro na chamada da Gemini: ' + e.message }, 500);
  }
}
