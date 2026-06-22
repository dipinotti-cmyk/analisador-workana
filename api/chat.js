export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let prompt;
  try {
    const raw = await req.text();
    prompt = JSON.parse(raw).prompt;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Body invalido: ' + e.message }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Prompt vazio' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Chave nao configurada no servidor' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (data.error) {
      return new Response(JSON.stringify({ error: 'OpenAI: ' + data.error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }
    const text = data.choices?.[0]?.message?.content || '';
    return new Response(JSON.stringify({ text }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Erro fetch OpenAI: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
