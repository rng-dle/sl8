# Checklist lines inside a text note: tap the box to tick it, Enter continues the list, "[] " makes one. Run against `wrangler dev`; exits non-zero on failure.
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
j('/api/signup', 'POST', {'email': 'cl%d@example.com' % random.randint(1, 10**9), 'password': 'correcthorse'}); j('/api/me/onboarded', 'POST')
n = j('/api/notes', 'POST', {'title': 't'})['note']['id']
j(f'/api/notes/{n}/ops', 'POST', {'ops': [{'put': {'id': 'a', 'kind': 'text', 't': 1, 'x': 100, 'y': 100, 'w': 320, 's': 17, 'c': 'ink', 'text': '☐ one\n☐ two'}}]})
saved = lambda: next(i for i in j(f'/api/notes/{n}')['items'] if i['id'] == 'a')['text']
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1000, 'height': 700})
    ctx.add_cookies([{'name': k, 'value': v, 'url': B} for k, v in jar.items()])
    pg = ctx.new_page(); pg.goto(f'{B}/note?id={n}'); pg.wait_for_selector('.tb textarea')
    ta = pg.locator('.tb textarea'); box = ta.bounding_box()
    pg.mouse.click(box['x'] + 8, box['y'] + 12); pg.wait_for_timeout(400)
    ok(ta.input_value() == '☑ one\n☐ two', 'tapping a box ticks it: ' + repr(ta.input_value()))
    ta.focus(); pg.keyboard.press('Control+End'); pg.keyboard.press('Enter'); pg.keyboard.type('three'); pg.wait_for_timeout(300)
    ok(ta.input_value() == '☑ one\n☐ two\n☐ three', 'Enter continues the list: ' + repr(ta.input_value()))
    pg.keyboard.press('Enter'); pg.keyboard.press('Enter'); pg.wait_for_timeout(300)
    ok(ta.input_value() == '☑ one\n☐ two\n☐ three\n', 'Enter on an empty item ends the list: ' + repr(ta.input_value()))
    pg.keyboard.type('[] four'); pg.wait_for_timeout(1200)
    ok(ta.input_value().endswith('\n☐ four'), '"[] " becomes a box: ' + repr(ta.input_value()))
    ok(saved() == ta.input_value(), 'it is saved')
    b.close()
sys.exit(1 if failed else 0)
