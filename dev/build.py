"""Packages the store upload: dist/claude-weekly-usage-chart-<version>.zip

python dev/build.py   (from the project root)

Uses zipfile with forward-slash entry names; PowerShell 5.1 Compress-Archive writes
backslashes, which the Chrome Web Store rejects.
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / 'extension'
FILES = ['manifest.json', 'background.js', 'parse.js', 'pace.js', 'chart.html', 'chart.js',
         'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png']


def main():
    manifest = json.loads((EXT / 'manifest.json').read_text(encoding='utf-8'))
    for key in ('name', 'version', 'description', 'icons'):
        assert key in manifest, f'manifest missing {key}'
    assert len(manifest['description']) <= 132, 'store description limit is 132 chars'
    for f in FILES:
        assert (EXT / f).is_file(), f'missing {f}'

    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    out = dist / f"claude-weekly-usage-chart-{manifest['version']}.zip"
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            z.write(EXT / f, f)
    print(f'{out} ({out.stat().st_size} bytes, {len(FILES)} files)')


if __name__ == '__main__':
    main()
