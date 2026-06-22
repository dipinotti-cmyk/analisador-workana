export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const { prompt } = await req.json();
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Prompt required' }), { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
  });

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  return new Response(JSON.stringify({ text }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
