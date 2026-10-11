# Builds a single-file, backend-free preview of the canvas from the real files in public/.
# python3 scripts/build-preview.py out.html
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
pub = root / 'public'
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'preview.html')

page = (pub / 'note.html').read_text()
inline_css = re.search(r'<style>(.*?)</style>', page, re.S).group(1)
body = page[page.index('<body'):]
body = body[body.index('>') + 1:body.index('<script src="/common.js">')]

note_js = (pub / 'note.js').read_text()
anchor = "const noteId = new URLSearchParams(location.search).get('id');"
assert anchor in note_js
note_js = note_js.replace(anchor, "const noteId = previewNoteId(); // preview build")

def script(src):  # keep "</script>" inside strings from closing the tag early
    return '<script>\n' + src.replace('</script', '<\\/script') + '\n</script>\n'

banner_css = '''
  .pv { position: fixed; z-index: 12; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 60px); transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--surface); box-shadow: var(--shadow); font-size: 13px; color: var(--muted); white-space: nowrap; }
  .pv b { color: var(--text); display: inline-flex; align-items: baseline; gap: 2px; font: 400 15px/1 var(--font-display); }
  .pv button { height: 28px; padding: 0 10px; border: 0; border-radius: 999px; background: var(--accent-soft); color: var(--text); font-size: 13px; font-weight: 600; }
  .pv input[type=color] { width: 28px; height: 26px; padding: 0; border: 0; background: none; }
  @media (max-width: 480px) { .pv .pv-note, .pv b { display: none; } .pv { padding-left: 4px; } }
'''
banner = '''<div class="pv" role="note"><b>Think<span data-mark></span></b><span class="pv-note">Preview · saved only in this browser</span>
  <button type="button" onclick="sessionStorage.setItem('sl8:reveal','1'); store.set('sl8:revealMode','full'); reveal()">Replay</button>
  <button type="button" onclick="tour()">Tour</button>
  <button type="button" onclick="document.getElementById('pv-sound').click()">Sound</button>
  <input id="pv-sound" type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg" hidden onchange="previewSound(this)">
  <button type="button" onclick="document.getElementById('pv-logo').hidden ^= 1">Logo</button>
  <span id="pv-logo" hidden><input type="color" id="pv-bg" value="#0a2b48" oninput="previewLogo()" aria-label="Logo background"><input type="color" id="pv-fg" value="#78d1f9" oninput="previewLogo()" aria-label="Logo mark"></span>
  <button type="button" onclick="previewReset()">Reset</button></div>
'''
html = (
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<title>ThinkSL8 Preview</title>\n'
    '<style>\n' + (pub / 'style.css').read_text() + inline_css + banner_css + '</style>\n'
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gloock&family=Hanken+Grotesk:wght@400;500;600;700&display=swap">\n'
    + body + banner
    + script((pub / 'common.js').read_text())
    + script((root / 'scripts' / 'preview-mock.js').read_text())
    + script((pub / 'sounds.js').read_text())
    + script(note_js)
    + script((pub / 'ai-panel.js').read_text())
)
out.write_text(html)
print(out, len(html), 'bytes')
