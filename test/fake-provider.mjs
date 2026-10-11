// Local stand-in for OpenRouter / OpenAI / Anthropic / Gemini and Resend, used only by tests via TEST_BASE.
// Keys steer behaviour: "...revoked..." -> 401, "...broke..." -> 402, "...bad..." -> rejected at connect.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const challenges = new Map(); // code -> code_challenge
const revokedKeys = new Set(); // keys revoked "on the provider's side" after connecting
const emails = [];
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const keyOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-api-key'] || '';
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s ? JSON.parse(s) : {})); });

const MODELS = {
  openrouter: [{ id: 'meta-llama/llama-test:free', name: 'Llama test (free)', created: 2 }, { id: 'openai/gpt-test', name: 'GPT test', created: 1 }],
  openai: [{ id: 'gpt-test', created: 2 }, { id: 'text-embedding-test', created: 3 }, { id: 'whisper-1', created: 1 }],
  anthropic: [{ id: 'claude-sonnet-test', display_name: 'Claude Sonnet test', created_at: '2026-01-01T00:00:00Z' }],
  gemini: [{ id: 'models/gemini-flash-test' }, { id: 'models/text-embedding-004' }],
};

function answerFrom(userContent) {
  // echo the first numbered note so tests can prove the answer is grounded in retrieved text
  const m = userContent.match(/\[1\] Canvas "([^"]*)", edited [^:]*:\n([^\n]*)/);
  return m ? `From your notes: ${m[2]} [1]` : 'I could not find anything about that in your notes.';
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const [, p, ...rest] = url.pathname.split('/');
  const path = '/' + rest.join('/');
  const key = keyOf(req);

  if (p === 'openrouter-auth') { // the consent page: approve immediately and send the user back with a code
    const code = randomUUID();
    challenges.set(code, url.searchParams.get('code_challenge'));
    res.writeHead(302, { location: `${url.searchParams.get('callback_url')}?code=${code}` });
    return res.end();
  }
  if (p === 'openrouter' && path === '/auth/keys' && req.method === 'POST') {
    const { code, code_verifier } = await readBody(req);
    const expected = challenges.get(code);
    challenges.delete(code);
    if (!expected || b64url(createHash('sha256').update(code_verifier || '').digest()) !== expected) return send(res, 403, { error: { message: 'Invalid code or verifier' } });
    return send(res, 200, { key: 'sk-or-v1-oauth-' + randomUUID().slice(0, 8) });
  }
  if (url.pathname === '/__revoke') { revokedKeys.add((await readBody(req)).key); return send(res, 200, {}); }
  // stand-in for Resend: keep emails so tests can read the reset link
  if (url.pathname === '/resend/emails' && req.method === 'POST') { const m = await readBody(req); m.at = Date.now(); emails.push(m); return send(res, 200, { id: randomUUID() }); }
  if (url.pathname === '/__emails') return send(res, 200, emails.filter((m) => m.to.includes(url.searchParams.get('to'))));
  if (key.includes('revoked') || revokedKeys.has(key)) return send(res, 401, { error: { message: 'Key revoked' } });
  if (key.includes('bad')) return send(res, 401, { error: { message: 'Invalid key' } });
  if (path === '/models' && req.method === 'GET') return send(res, 200, { data: MODELS[p] || [] });
  if (p === 'openrouter' && path === '/key') return send(res, 200, { data: { is_free_tier: true } });

  if ((path === '/chat/completions' || path === '/messages') && req.method === 'POST') {
    const body = await readBody(req);
    if (key.includes('broke')) return send(res, 402, { error: { message: 'Insufficient credits' } });
    const anthropic = path === '/messages';
    const userMsg = body.messages.at(-1).content;
    const text = answerFrom(userMsg);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': processing\n\n');
    for (const word of text.split(/(?<= )/)) {
      res.write(anthropic
        ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: word } })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
    }
    res.end(anthropic ? `data: ${JSON.stringify({ type: 'message_stop' })}\n\n` : 'data: [DONE]\n\n');
    return;
  }
  send(res, 404, { error: { message: 'not found: ' + url.pathname } });
}).listen(PORT, '127.0.0.1', () => console.log(`fake provider on ${PORT}`));
