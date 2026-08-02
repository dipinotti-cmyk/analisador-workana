// Analisador Workana — endpoint de IA
// Migrado de OpenAI para Gemini em 29/07/2026 (créditos da OpenAI acabaram e
// não há cartão que passe). Usa a camada de compatibilidade OpenAI da Gemini,
// então o formato de requisição e resposta continua idêntico ao anterior.
//
// 30/07/2026 — correção do 404. O gemini-2.5-flash foi retirado antes da data
// de desligamento anunciada, e a camada de compatibilidade devolve 404 seco,
// sem corpo de erro, quando o modelo não existe mais. Em vez de cravar um
// modelo só, agora existe uma CASCATA: a chamada tenta os modelos na ordem e
// pula pro próximo quando recebe 404 ou 400. Assim a próxima aposentadoria de
// modelo do Google não derruba a ferramenta de novo.
//
// 02/08/2026 — correção da MENSAGEM CORTADA PELA METADE.
// Sintoma: o follow-up voltava truncado no meio da frase, com HTTP 200 e sem
// erro nenhum. Causa: no Gemini o "thinking" consome o MESMO orçamento do
// max_tokens. O reasoning_effort 'low' reserva 1.024 tokens só para pensar, e
// o front manda 1.000 como padrão — ou seja, a cota de pensamento era maior
// que o orçamento inteiro. O modelo pensava, estourava o teto e devolvia umas
// quarenta palavras. Passou a acontecer justamente quando a cascata trocou o
// 2.5-flash ('none', sem thinking) pelos 3.x ('low', com thinking).
// Correção: a reserva de pensamento agora é somada POR CIMA do que o front
// pediu, em vez de descontada dele. No free tier isso não custa nada.
// Reforço: se mesmo assim a resposta vier cortada (finish_reason 'length'),
// a chamada é repetida uma vez com o dobro de saída, e se ainda assim vier
// truncada o texto volta com um aviso visível — nunca mais meia mensagem
// passando por mensagem pronta.
//
// Pra fixar um modelo específico sem mexer no código, basta criar a variável
// de ambiente GEMINI_MODEL na Vercel — ela entra na frente da cascata.
//
// A chave é lida de GEMINI_API_KEY e, se não existir, de OPENAI_API_KEY.
//
// Sobre reasoning_effort: no Gemini 2.5 o valor 'none' desliga o thinking. Na
// família 3.x o mínimo aceito é 'low'. Cada candidato carrega o valor certo, e
// o último da fila vai sem o parâmetro nenhum, como rede de segurança.

export const config = { runtime: 'edge' };

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const CANDIDATOS = [
  { model: 'gemini-3.5-flash', reasoning_effort: 'low' },
  { model: 'gemini-3.1-flash-lite', reasoning_effort: 'low' },
  { model: 'gemini-2.5-flash', reasoning_effort: 'none' },
  { model: 'gemini-3.5-flash' }
];

// Quanto cada nivel de reasoning_effort gasta pensando, segundo a doc da
// Gemini. Esse valor e SOMADO ao teto de saida, nunca descontado dele.
const FOLGA_THINKING = { none: 0, low: 1500, medium: 9000, high: 26000 };

// Teto absoluto de tokens numa unica chamada, so pra nao mandar valor absurdo.
const TETO_ABSOLUTO = 32000;

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
});

const espera = (ms) => new Promise(res => setTimeout(res, ms));

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

  const fila = process.env.GEMINI_MODEL
    ? [{ model: process.env.GEMINI_MODEL, reasoning_effort: 'low' }, ...CANDIDATOS]
    : CANDIDATOS;

  // tetoSaida = quanto de TEXTO a chamada precisa poder gerar. A reserva de
  // pensamento entra em cima disso, porque a Gemini cobra os dois do mesmo
  // orcamento e quem paga a conta quando falta e o texto.
  const chamar = (candidato, tetoSaida) => {
    const reserva = FOLGA_THINKING[candidato.reasoning_effort] || 0;
    const corpo = {
      model: candidato.model,
      max_tokens: Math.min(tetoSaida + reserva, TETO_ABSOLUTO),
      messages: [{ role: 'user', content: prompt }]
    };
    if (candidato.reasoning_effort) corpo.reasoning_effort = candidato.reasoning_effort;

    return fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(corpo)
    });
  };

  const tentativas = [];
  const ESPERAS_MS = [2000, 5000];
  const PASSADAS = 2; // segunda passada dobra o teto de saida se vier cortado

  try {
    for (const candidato of fila) {
      let resultado = null;
      let abortouCandidato = false;

      for (let passada = 0; passada < PASSADAS; passada++) {
        const tetoSaida = Math.min(maxTokens * (passada + 1), TETO_ABSOLUTO);
        let r = null;
        let detalhe = '';

        // So o 429 (limite por minuto) merece insistir no MESMO modelo, porque
        // e questao de esperar. 503 significa modelo sobrecarregado do lado do
        // Google, e 404/400 sao definitivos: nos tres casos trocar de modelo e
        // mais rapido que esperar, entao cai direto pro proximo da fila.
        for (let tentativa = 0; tentativa <= ESPERAS_MS.length; tentativa++) {
          r = await chamar(candidato, tetoSaida);
          if (r.ok) break;
          detalhe = (await r.text()).slice(0, 200);
          const temporario = r.status === 429;
          if (!temporario || tentativa === ESPERAS_MS.length) break;
          await espera(ESPERAS_MS[tentativa]);
        }

        // Qualquer falha que sobreviveu as tentativas: proximo modelo da fila.
        if (!r.ok) {
          tentativas.push(candidato.model + ' -> ' + r.status + ' ' + detalhe);
          abortouCandidato = true;
          break;
        }

        const data = await r.json();
        const choice = data.choices && data.choices[0];
        const texto = (choice && choice.message && choice.message.content) || '';
        const motivo = (choice && choice.finish_reason) || '';

        // Vazio de verdade: o thinking comeu tudo ou o modelo nao respondeu.
        // Nao adianta dobrar, e caso de trocar de modelo.
        if (!texto) {
          tentativas.push(candidato.model + ' -> vazio (' + (motivo || 'sem finish_reason') + ')');
          abortouCandidato = true;
          break;
        }

        resultado = { texto: texto, motivo: motivo };

        // Resposta inteira: pode sair. Cortada no limite: repete com o dobro.
        if (motivo !== 'length') break;
        tentativas.push(candidato.model + ' -> cortado no limite com teto ' + tetoSaida);
      }

      if (abortouCandidato || !resultado) continue;

      // Se depois das duas passadas ainda veio cortado, o texto volta com um
      // aviso visivel. Melhor o Diogo ver o alerta na tela do que copiar meia
      // mensagem e mandar pro cliente sem perceber.
      const cortado = resultado.motivo === 'length';
      const text = cortado
        ? resultado.texto + '\n\n[!] RESPOSTA CORTADA NO LIMITE DE TOKENS. Clique em Gerar de novo ou reduza o pedido antes de enviar.'
        : resultado.texto;

      return json({ text: text, model: candidato.model, truncado: cortado }, 200);
    }

    return json({
      error: 'Nenhum modelo da Gemini respondeu agora. Tentativas: ' + tentativas.join(' | ')
    }, 502);
  } catch (e) {
    return json({ error: 'Erro na chamada da Gemini: ' + e.message }, 500);
  }
}
