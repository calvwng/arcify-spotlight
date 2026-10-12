# Arcify Spotlight

Spotlight-style search, an overlay, and a new-tab page for Chromium browsers.
This fork adds an optional, explicitly paired connection to the Arcify sidebar;
Spotlight can still run standalone.

## Documentation

- [Pairing: setup, usage, mechanics, limitations, and recovery](docs/ARCIFY-BRIDGE.md)
- [Fork backlog: deferred considerations, not implemented features](docs/BACKLOG.md)
- [Inherited project roadmap](.planning/ROADMAP.md) (historical upstream planning)

## Build and check

Use Node 22 or 24. Run `npm ci`, `npm run build`, and `npm test`.
`PUPPETEER_SKIP_DOWNLOAD=1 npm ci` skips the browser download when only building
or running unit tests. Load the generated `dist` directory as an unpacked
extension in a browser/profile that permits it; do not load the repository root.

The [pairing guide](docs/ARCIFY-BRIDGE.md) explains how to build the companion,
exchange actual extension IDs, and update existing installs. Unit-test success
is not full paired-browser acceptance. The current changes are in
[draft PR #1](https://github.com/calvwng/arcify-spotlight/pull/1), paired with
[Arcify draft PR #75](https://github.com/calvwng/arcify/pull/75).
