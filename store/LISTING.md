# Chrome Web Store listing copy

Paste these into the developer dashboard tabs.

## Store listing

**Name:** Claude Weekly Usage Chart

**Summary** (same as the manifest description):
Unofficial. Charts your claude.ai weekly limits over time against the ideal pace. Data stays in your browser.

**Category:** Productivity (Tools also fits)

**Description:**

See how fast you are using your Claude weekly limits, not just where they stand right now.

The extension records your claude.ai weekly usage every 10 minutes and draws one chart per limit (All models, plus per-model caps such as Fable). A dashed line shows the ideal pace, where usage would reach 100% exactly at the reset.

* Pace figure: how far ahead of or behind the ideal pace you are
* Hover any point to see the exact percentage, time, and ideal value
* Browse past weeks
* Fit data or full-week view
* Export and import your history as JSON

Privacy: the extension only reads your usage percentages from claude.ai using your existing login. Everything stays in your browser. No server, no analytics.

You must be logged in to claude.ai in the same browser. The chart fills in from the moment you install; earlier weeks cannot be recovered.

This is an unofficial tool, not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic.

**Images:** `store/icon128.png` is `icons/icon128.png`; `store/screenshot-1280x800.png`; `store/promo-440x280.png`.

## Privacy tab

**Single purpose:**
Record the user's claude.ai weekly usage limits over time and chart them against the ideal pace.

**Permission justifications:**

* `storage`: saves usage readings and the last poll status locally so the chart can show history.
* `unlimitedStorage`: history grows by a few points per hour for as long as the extension is installed; this keeps the default local storage quota from cutting off old weeks.
* `alarms`: runs the usage check every 10 minutes while the browser is open.
* Host permission `https://claude.ai/api/organizations`: reads the user's organization ID, needed to build the usage URL.
* Host permission `https://claude.ai/api/organizations/*/usage`: reads the weekly usage percentages and reset times that the chart displays.

**Remote code:** No, the extension does not use remote code.

**Data usage disclosures:** the only data handled is usage percentages and reset times read from claude.ai, stored locally, never transmitted. Pick the dashboard category that matches (check the current list; "Website content" looked closest when this was written) and certify the standard statements: not sold, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL:** host `store/PRIVACY.md` publicly (GitHub Pages, a Gist, or a repo README) and paste that URL. Fill in the Contact line first.

## Test instructions tab

Reviewers need a claude.ai account with a paid plan to see weekly limits. Without one, the chart page shows the "No samples yet" message and the status line shows the poll error.
