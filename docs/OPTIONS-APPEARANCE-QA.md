# Options appearance acceptance

Spotlight settings default to **System**, following live device light/dark changes.
The **Options page theme** selector also supports explicit **Light** and **Dark**.
The preference is stored in this extension origin's localStorage under
`spotlightOptionsAppearance`. It affects only the options page and requires no
new extension permission. A synchronous external head script applies an explicit
choice before the stylesheet/body; CSS follows the system even without JavaScript.
If browser policy blocks storage, the page still changes appearance and explains
that the choice could not be saved.

## Local automated regression

Use the supported Node version from README (Node 22 or 24):

```sh
npm test
npm run build
```

`test/unit/options-appearance.test.js` covers default/invalid preferences, all
three persisted choices, repeated changes, blocked storage, other options
windows, cleanup, early bootstrap ordering, and pairing isolation. It also checks
WCAG text contrast for both palette definitions, control/focus contrast, and that
live-system and explicit-dark palettes stay identical. Existing pairing tests are
unchanged. These checks do not replace rendered browser acceptance.

## Hosted browser handoff

`test/e2e/options-appearance-evidence.js` is import-safe and **does not launch a
browser**. In an authorized hosted browser test job, build `dist/`, load that
extension in a disposable browser profile, and provide an already running
Puppeteer `Browser` and the actual loaded extension ID:

```js
import { collectOptionsAppearanceEvidence } from './test/e2e/options-appearance-evidence.js';
const result = await collectOptionsAppearanceEvidence({
    browser,
    extensionId,
    outputDir: 'test-results/options-appearance'
});
```

The existing `waitForExtension(browser)` helper in `test/e2e/setup.js` can resolve
the ID. The caller owns allowed browser provisioning and teardown. Do not run a
local browser to bypass an executor restriction. No GitHub workflow is changed by
this patch; invoke this helper from the authorized hosted acceptance runner and
upload the output directory as its artifact.

Select changes and peer-ID edits use foregrounded real mouse/keyboard input;
background document polls use a numeric interval. The helper asserts default System on a dark device, a live device change without
navigation, both explicit overrides after reload, a persisted return to System,
cross-window synchronization, real invalid-ID validation, retained unsaved pairing
input, and a narrow/mobile viewport. It writes seven screenshots plus JSON of the
checks and computed colors. It restores the initial appearance preference, closes
only its own pages, and never submits a valid connection change.

Review every screenshot for page/card/input/select/button backgrounds, hint and
status text, keyboard/validation focus, and mobile wrapping. Confirm the native
select menu follows the selected color scheme. Screen-reader semantics and the
copy, refresh, save, disconnect, and reciprocal-pairing flows should remain covered
by the existing paired-browser acceptance suite.

**Status:** the hosted helper is provided for execution by an allowed browser
runner. Passing unit tests/build alone is not a claim that its screenshots were
captured or visually reviewed.
