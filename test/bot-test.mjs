// The bot check (Turnstile) against a `wrangler dev` started with both keys set, e.g.
//   npx wrangler dev --port 8789 --var TURNSTILE_SITE_KEY:test-site --var TURNSTILE_SECRET:test-secret
// The stand-in (test/fake-provider.mjs) passes only the token "pass". Exits non-zero on failure.
const B = process.argv[2] || 'http://127.0.0.1:8789';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const ip = `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
const post = async (path, body) => {
  const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const email = `bot-${Math.random().toString(36).slice(2, 8)}@example.com`, password = 'correcthorse';

const cfg = await (await fetch(B + '/api/config')).json();
ok(cfg.botCheck === 'test-site', 'the page is told the site key', JSON.stringify(cfg));
ok((await post('/api/signup', { email, password })).status === 400, 'sign-up without the check is refused');
ok((await post('/api/signup', { email, password, turnstile: 'fail' })).status === 400, 'sign-up with a failed check is refused');
ok((await post('/api/signup', { email, password, turnstile: 'pass' })).status === 200, 'sign-up with a passed check works');
ok((await post('/api/login', { email, password })).status === 400, 'sign-in without the check is refused');
ok((await post('/api/login', { email, password, turnstile: 'pass' })).status === 200, 'sign-in with a passed check works');
ok((await post('/api/password/forgot', { email })).status === 400, 'reset requests need the check too');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
