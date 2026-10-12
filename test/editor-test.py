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
n2 = j('/api/notes', 'POST', {'title': 'wide'})['note']['id']
j(f'/api/notes/{n2}/ops', 'POST', {'ops': [{'put': {'id': 'a', 'kind': 'text', 't': 1, 'x': 0, 'y': 0, 'w': 200, 's': 17, 'c': 'ink', 'text': 'near'}}, {'put': {'id': 'b', 'kind': 'text', 't': 2, 'x': 4000, 'y': 3000, 'w': 200, 's': 17, 'c': 'ink', 'text': 'far away'}}]})
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
    pg.goto(f'{B}/note?id={n2}'); pg.wait_for_timeout(2000)
    ok(pg.locator('#minimap').is_visible(), 'the minimap shows when part of the canvas is off screen')
    cam0 = pg.evaluate('cam.x')
    box = pg.locator('#minimap').bounding_box(); pg.mouse.click(box['x'] + box['width'] - 8, box['y'] + box['height'] - 8); pg.wait_for_timeout(500)
    ok(pg.evaluate('cam.x') < cam0 - 1000, 'tapping the far corner of the minimap moves there: %s -> %s' % (cam0, pg.evaluate('cam.x')))
    pg.evaluate("localStorage.setItem('sl8:minimap', '\"off\"')"); pg.reload(); pg.wait_for_timeout(1500)
    ok(not pg.locator('#minimap').is_visible(), 'the minimap can be switched off')
    pg.goto(f'{B}/share?title=Cool+page&text=Look+at+this&url=https://example.com/x'); pg.wait_for_url('**/note?id=*', timeout=8000); pg.wait_for_timeout(500)
    pg.goto(f'{B}/share?text=Second+one'); pg.wait_for_url('**/note?id=*', timeout=8000)
    inbox = [x for x in j('/api/notes')['notes'] if x['title'] == 'Inbox']
    its = sorted(j('/api/notes/' + inbox[0]['id'])['items'], key=lambda i: i['t'])
    ok(len(inbox) == 1 and len(its) == 2 and its[0]['text'] == 'Cool page\nLook at this\nhttps://example.com/x' and its[1]['y'] > its[0]['y'], 'a phone share lands in one Inbox canvas, below the last one: ' + str([(i['y'], i['text'][:12]) for i in its]))
    ok('share_target' in json.load(urllib.request.urlopen(B + '/manifest.webmanifest')), 'the app asks the phone to list it in the Share menu')
    ok(not errs, 'no script errors ' + str(errs))
    b.close()
sys.exit(1 if failed else 0)
