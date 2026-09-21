# Privacy Policy: Claude Weekly Usage Chart

Last updated: 2026-09-21

Claude Weekly Usage Chart is an unofficial browser extension. It is not made by, affiliated with, or endorsed by Anthropic.

## What the extension reads

Every 10 minutes, and when you click "Poll now", the extension requests two claude.ai pages using the login you already have in your browser:

* `https://claude.ai/api/organizations`, to find your organization ID
* `https://claude.ai/api/organizations/<id>/usage`, to read your weekly usage percentages and reset times

It also reads `https://claude.ai/api/account` for the name shown on the chart.

To keep several accounts updating while the browser is signed in to only one, it reads the claude.ai `sessionKey` login cookie of each account it sees (normal windows and, if you allow the extension in incognito, incognito windows) and keeps it in your browser's extension storage. It sends that key only to claude.ai, only with the requests above. The key is never exported. A key is deleted when you press "Log out" for that account, which also sends claude.ai's logout request (`https://claude.ai/api/auth/logout`) with that key to end its session. The extension blocks the logout request that claude.ai's own "Log out" button sends, so that button switches accounts instead of ending the session. "Add account", "Log out" and claude.ai's "Log out" remove the browser's claude.ai login cookie (and claude.ai's `lastActiveOrg` cookie); the extension changes no other cookie.

It reads nothing else from claude.ai: no conversations, files, or payment information.

## What the extension stores

For each weekly limit it stores the time of the reading, the limit name (for example "All models"), the usage percentage, and the reset time. These readings, plus the result of the last poll, are kept in your browser's extension storage on your device.

## What the extension shares

Nothing. The extension has no server, no analytics, and no third-party code. Data leaves your device only if you click "Export JSON", which saves a file wherever you choose.

## Deleting your data

Removing the extension deletes everything it stored.

## Contact

<your contact email or issue tracker URL>
