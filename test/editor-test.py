# Editor details: typed colours, the tenth colour, arrow link suggestions, the hints switch. Run against `wrangler dev`; exits non-zero on failure.
import json, random, sys, urllib.request
from playwright.sync_api import sync_playwright
B = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
jar, IP, failed = {}, '10.7.%d.%d' % (random.randint(1, 250), random.randint(1, 250)), 0
def j(p, m='GET', b=None):
    r = urllib.request.Request(B + p, method=m, data=json.dumps(b or {}).encode() if m != 'GET' else None,
        headers={'content-type': 'application/json', 'cf-connecting-ip': IP, 'cookie': '; '.join(f'{k}={v}' for k, v in jar.items())})
    with urllib.request.urlopen(r) as res:
        for c in res.headers.get_all('set-cookie') or []:
            k, v = c.split(';')[0].split('=', 1); jar[k] = v
        return json.load(res)
def ok(c, n):
    global failed
    print(('ok   - ' if c else 'FAIL - ') + n); failed += not c
j('/api/signup', 'POST', {'email': 'ed%d@example.com' % random.randint(1, 10**9), 'password': 'correcthorse'}); j('/api/me/onboarded', 'POST')
n = j('/api/notes', 'POST', {'title': 't'})['note']['id']
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1000, 'height': 700})
    ctx.add_cookies([{'name': k, 'value': v, 'url': B} for k, v in jar.items()])
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'{B}/note?id={n}'); pg.wait_for_timeout(1500)
    pc = lambda t: pg.evaluate('t => parseColor(t)', t)
    ok(pc('#d9661b') == '#d9661b' and pc('f80') == '#ff8800', 'HEX, with or without #, short or long')
    ok(pc('rgb(217, 102, 27)') == '#d9661b' and pc('217 102 27') == '#d9661b', 'RGB, with or without rgb()')
    ok(pc('hsl(24, 78%, 48%)') in ('#da661b', '#d9661b', '#da671b', '#d9671b'), 'HSL: ' + str(pc('hsl(24, 78%, 48%)')))
    ok(pc('hsl(0, 100%, 50%)') == '#ff0000' and pc('rubbish') is None and pc('rgb(1,2)') is None, 'red is red; nonsense is refused')
    ok(pg.evaluate('COLORS.length') == 10 and pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ink-brown').trim()") != '', 'ten named colours, brown included')
    ok(pg.locator('#conn-presets option').count() >= 8, 'arrow label suggestions exist')
    ok(pg.locator('#hint').is_visible(), 'the empty-canvas hint shows by default')
    pg.evaluate("localStorage.setItem('sl8:hints', '\"off\"')"); pg.reload(); pg.wait_for_timeout(1500)
    ok(not pg.locator('#hint').is_visible(), 'with hints off, it stays hidden')
    ok(not errs, 'no script errors ' + str(errs))
    b.close()
sys.exit(1 if failed else 0)
