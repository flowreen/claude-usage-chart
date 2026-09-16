# Claude Weekly Usage Chart

Unofficial Chrome extension (MV3). Polls claude.ai weekly limits every 10 minutes and charts them against the ideal pace, with a rank for how close you finish to 100% at the reset. Not affiliated with Anthropic. Data stays in your browser.

## Install (from this repo)

1. Download this repository (green "Code" button, "Download ZIP") and unzip it, or clone it.
2. Open `chrome://extensions`, turn on "Developer mode" (top right).
3. Click "Load unpacked" and pick the `extension` folder.
4. Stay logged in to claude.ai in that Chrome profile. The first sample arrives within a minute; click the toolbar icon to open the chart.

## Layout

* `extension/`: the unpacked extension. `manifest.json`, `background.js` (poller), `parse.js` (usage payload parser, import merge), `pace.js` (ideal line, zone, finish window, rank maths), `chart.html` + `chart.js` (chart page), `icons/`
* `dev/`: `test_parse.js`, `test_pace.js` (run under several TZ values), `test_poll.js` (background.js against a fake claude.ai: two weekly orgs, one monthly), `demo.html` (chart with fake data), `promo.html` (store tile source), `make_icons.py`, `build.py`
* `store/`: listing copy, privacy policy, store images
* `dist/`: upload zip (generated)

## Commands (from this folder)

```bash
node dev/test_parse.js
```

```bash
node dev/test_pace.js
```

```bash
node dev/test_poll.js
```

```bash
python dev/make_icons.py
```

```bash
python dev/build.py
```

Demo: serve this folder over http (`python -m http.server 8741 --bind 127.0.0.1`) and open `http://127.0.0.1:8741/dev/demo.html`.

## Release

Bump `version` in `extension/manifest.json`, run `python dev/build.py`, upload the zip from `dist/`.
