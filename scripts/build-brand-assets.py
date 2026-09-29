"""Render editable brand SVGs into native icons and documentation previews.
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

def render(source, destination, size=None):
    args = ['rsvg-convert', str(source), '-o', str(destination)]
    if size:
        args += ['-w', str(size), '-h', str(size)]
    subprocess.run(args, check=True)

render(ICON, ROOT / 'build/icon.png', 1024)
image = Image.open(ROOT / 'build/icon.png').convert('RGBA')
image.save(ROOT / 'build/icon.ico', sizes=[(n, n) for n in [16, 24, 32, 48, 64, 128, 256]])
image.save(ROOT / 'build/icon.icns', format='ICNS')
render(MARK, ROOT / 'build/tray.png', 64)
# macOS uses a transparent monochrome template for light/dark menu bars.
with tempfile.TemporaryDirectory(prefix='delulu-brand-') as directory:
    template = Path(directory) / 'template.svg'
    template.write_text(MARK.read_text().replace('url(#voice)', '#000000'))
    render(template, ROOT / 'build/trayTemplate.png', 22)
    render(template, ROOT / 'build/trayTemplate@2x.png', 44)
board = ROOT / 'docs/assets/brand-preview.svg'
def refresh_snapshot(match):
    previous = base64.b64decode(match.group(1)).decode()
    master = ICON if '<rect ' in previous else MARK
    return 'xlink:href="data:image/svg+xml;base64,' + base64.b64encode(master.read_bytes()).decode() + '"'
board.write_text(re.sub(r'xlink:href="data:image/svg\+xml;base64,([^"]+)"', refresh_snapshot, board.read_text()))
render(board, ROOT / 'docs/assets/brand-preview.png')
render(ROOT / 'docs/assets/readme-header.svg', ROOT / 'docs/assets/readme-header.png')
print('Rendered app icons, tray templates, and brand previews from SVG masters.')
