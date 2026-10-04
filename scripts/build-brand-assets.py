"""Render editable brand SVGs into native icons, tray states and documentation previews.
Requires rsvg-convert and Pillow. Run from any directory; no AI/raster tracing.
"""
from pathlib import Path
import base64
import re
import subprocess
import tempfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / 'public/delulu-talks-icon.svg'
MARK = ROOT / 'public/delulu-talks-mark.svg'
TRAY = ROOT / 'build/tray'

# The glyph alone, so tray variants can recolor and outline it.
GLYPH = '''
  <path d="M172 61v91c0 33-23 54-54 54s-53-21-53-51 22-51 51-51c15 0 27 5 36 14" fill="none" stroke="{color}" stroke-width="{ribbon}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M167 180l29 26v-56" fill="{color}" stroke="{color}" stroke-width="{tail}" stroke-linejoin="round"/>
  <path d="M105 145v20m24-30v40" fill="none" stroke="{pulse}" stroke-width="{pulses}" stroke-linecap="round"/>
'''
OUTLINE = '''
  <path d="M172 61v91c0 33-23 54-54 54s-53-21-53-51 22-51 51-51c15 0 27 5 36 14" fill="none" stroke="#04182c" stroke-width="43" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M167 180l29 26v-56" fill="#04182c" stroke="#04182c" stroke-width="16" stroke-linejoin="round"/>
'''
# Tray state badges sit in the empty upper-left corner of the glyph.
BADGES = {
    'idle': None,
    'recording': '#ff6f86',
    'busy': '#ffffff',
    'attention': '#f6c979',
    'update': '#5fdcbf',
}
TEMPLATE_BADGES = {
    'idle': '',
    'recording': '<circle cx="70" cy="72" r="26" fill="#000"/>',
    'busy': '<circle cx="70" cy="72" r="20" fill="none" stroke="#000" stroke-width="11"/>',
    'attention': '<path d="M70 48 93 90H47Z" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="round"/>',
    'update': '<path d="M70 46 96 72 70 98 44 72Z" fill="#000"/>',
}


def render(source, destination, size=None):
    args = ['rsvg-convert', str(source), '-o', str(destination)]
    if size:
        args += ['-w', str(size), '-h', str(size)]
    subprocess.run(args, check=True)


def svg(body, view='41 43 180 180'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}">{body}</svg>'


def color_tray(state):
    """Luminous glyph with a depth outline so it reads on light and dark panels."""
    body = '<defs><linearGradient id="voice" x1="54" y1="64" x2="207" y2="207" gradientUnits="userSpaceOnUse"><stop stop-color="#9ff0ff"/><stop offset="1" stop-color="#32baff"/></linearGradient></defs>'
    body += OUTLINE
    body += GLYPH.format(color='url(#voice)', pulse='none', ribbon=29, tail=2, pulses=0)
    badge = BADGES[state]
    if badge:
        body += f'<circle cx="70" cy="72" r="29" fill="#04182c"/><circle cx="70" cy="72" r="21" fill="{badge}"/>'
    return svg(body)


def template_tray(state):
    body = GLYPH.format(color='#000', pulse='none', ribbon=29, tail=2, pulses=0)
    return svg(body + TEMPLATE_BADGES[state])


render(ICON, ROOT / 'build/icon.png', 1024)
image = Image.open(ROOT / 'build/icon.png').convert('RGBA')
image.save(ROOT / 'build/icon.ico', sizes=[(n, n) for n in [16, 24, 32, 48, 64, 128, 256]])
image.save(ROOT / 'build/icon.icns', format='ICNS')

TRAY.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='delulu-brand-') as directory:
    for state in BADGES:
        color = Path(directory) / f'{state}.svg'
        color.write_text(color_tray(state))
        # Linux: 22px plus an @2x companion, which Electron picks up for HiDPI panels.
        render(color, TRAY / f'tray-{state}.png', 22)
        render(color, TRAY / f'tray-{state}@2x.png', 44)
        # Windows: one ICO per state with every notification-area size.
        large = Path(directory) / f'{state}-256.png'
        render(color, large, 256)
        Image.open(large).convert('RGBA').save(
            TRAY / f'tray-{state}.ico', sizes=[(n, n) for n in [16, 20, 24, 32, 40, 48, 64]]
        )
        # macOS: monochrome template images; the "Template" suffix enables system tinting.
        template = Path(directory) / f'{state}-template.svg'
        template.write_text(template_tray(state))
        render(template, TRAY / f'tray-{state}Template.png', 18)
        render(template, TRAY / f'tray-{state}Template@2x.png', 36)

board = ROOT / 'docs/assets/brand-preview.svg'
def refresh_snapshot(match):
    previous = base64.b64decode(match.group(1)).decode()
    master = ICON if '<rect ' in previous else MARK
    return 'xlink:href="data:image/svg+xml;base64,' + base64.b64encode(master.read_bytes()).decode() + '"'
board.write_text(re.sub(r'xlink:href="data:image/svg\+xml;base64,([^"]+)"', refresh_snapshot, board.read_text()))
render(board, ROOT / 'docs/assets/brand-preview.png')
render(ROOT / 'docs/assets/readme-header.svg', ROOT / 'docs/assets/readme-header.png')
print('Rendered app icons, tray states, and brand previews from SVG masters.')
