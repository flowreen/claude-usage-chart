# Privacy Policy: Claude Weekly Usage Chart

Last updated: 2026-09-16

Claude Weekly Usage Chart is an unofficial browser extension. It is not made by, affiliated with, or endorsed by Anthropic.

## What the extension reads

Every 10 minutes, and when you click "Poll now", the extension requests two claude.ai pages using the login you already have in your browser:

* `https://claude.ai/api/organizations`, to find your organization ID
* `https://claude.ai/api/organizations/<id>/usage`, to read your weekly usage percentages and reset times

It reads nothing else from claude.ai: no conversations, files, account details, or payment information.

## What the extension stores

For each weekly limit it stores the time of the reading, the limit name (for example "All models"), the usage percentage, and the reset time. These readings, plus the result of the last poll, are kept in your browser's extension storage on your device.

## What the extension shares

Nothing. The extension has no server, no analytics, and no third-party code. Data leaves your device only if you click "Export JSON", which saves a file wherever you choose.

## Deleting your data

Removing the extension deletes everything it stored.

## Contact

<your contact email or issue tracker URL>
