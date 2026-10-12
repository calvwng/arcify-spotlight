# Optional Arcify connection (protocol v1)

Spotlight remains a standalone extension until explicitly paired. When paired, Arcify owns workspace membership, tab order, pinned bookmarks, active workspaces, and all result navigation. Spotlight requests a fresh read-only snapshot for each search and before each action; it never copies a snapshot into its own `spaces` storage or writes Arcify state directly.

Companion implementation: [Arcify draft PR #75](https://github.com/calvwng/arcify/pull/75), pinned at commit `795e961ce2556154e18ab030e84477b7393a7011`. See the [Arcify-side protocol and installation guide](https://github.com/calvwng/arcify/blob/integration/arcify-bridge-v1/docs/spotlight-bridge.md) for its authoritative storage model and supported commands.

## Load and pair

1. Build the matching Arcify and Spotlight forks. In Spotlight: `PUPPETEER_SKIP_DOWNLOAD=1 npm ci`, then `npm run build`.
2. In Chrome's extension manager (`chrome://extensions`), enable Developer mode and load each repository's `dist` folder as an unpacked extension.
3. Copy each extension's ID. Open **Arcify Spotlight → Details → Extension options** (or **Connection settings** below Spotlight search results).
4. Paste the **Arcify** ID into Spotlight, then select **Save Arcify ID**. This saves the ID locally and checks the connection. **Awaiting Arcify approval** means the ID is saved, but Arcify has not yet approved this Spotlight ID.
5. Select **Copy Spotlight ID**, open Arcify's connection settings, paste that ID into its Spotlight extension ID field, and save it there too. If clipboard access is unavailable, the field is selected for manual copying.
6. Return to Spotlight and select **Refresh status**; it should report **Connected** once both IDs are saved correctly.

You can save the IDs in either order. The first side can show **Awaiting approval** until the reciprocal ID is saved on the other side; this is an expected setup step, not a failed save. A saved ID alone does not establish trust in both directions. Spotlight displays its saved Arcify ID separately from connection status, including while you edit an unsaved replacement.

IDs are 32 lowercase letters from `a` through `p`. Unpacked IDs can change when the extension directory moves; re-pair both sides if needed. Never paste credentials or tokens into this field. Pair only a trusted Arcify build: the peer can read workspace metadata and receive workspace navigation requests.

Use **Disconnect** in Spotlight options to restore standalone behavior. A result left on-screen from the old connection is rejected after disconnect; search again to obtain standalone results. Invalid, missing, mismatched, or unavailable configured peers show an error rather than silently creating ordinary duplicate tabs.

## Behavior

- Search includes current-window live tabs, saved pinned bookmark titles/URLs, ordinary bookmarks/history, workspaces, and the existing autocomplete sources.
- Default tab order follows Arcify's ordered workspace membership; global favorites and unowned pages follow the workspace tabs. Same-URL items in different workspaces retain separate identities.
- Selecting an Arcify live tab switches to its existing workspace/tab in either Spotlight mode. A saved pin is opened or reused by exact bookmark identity, including after its live tab has navigated elsewhere.
- Ordinary current-tab overlay navigation goes through Arcify using the originating tab ID. New-tab navigation and paired Spotlight helper-page navigation open inside Arcify's active workspace; the helper closes only after a confirmed switch to a different tab.
- Search queries use Chrome's configured default search engine in the Arcify-managed target tab.
- Switching to an empty workspace does not close the helper new-tab page and accidentally reactivate a different workspace.
- Arcify's **Search with Spotlight** launch targets its explicit browser window. Restricted pages use Spotlight's new-tab UI in that window; repeated launches reuse an active helper page.
- If one bookmark folder is unavailable, live tabs and other bookmark folders remain searchable, with a visible warning. The unavailable pin still cannot be opened by guessed URL.

### Things to try after pairing

- **Switch workspaces:** Search for a space name and select its workspace result. An empty space can be activated too; the helper new-tab page stays open so you can choose what to open there.
- **Return to an existing tab:** Select a live-tab result from another space. Arcify activates that exact tab and its space instead of creating a duplicate.
- **Open a saved pin:** Select a saved pinned bookmark. Arcify reuses its bound live tab if available, or opens the exact saved bookmark in its own space. Identical URLs in different spaces are still distinct pins.
- **Open a URL or search:** In new-tab mode, enter a URL or search query to open it in Arcify's active space. In a normal page's current-tab overlay, navigation keeps the source tab's workspace membership. Spotlight's helper page uses new-tab navigation into the active space.
- **Launch from the sidebar:** Use Arcify's **Search with Spotlight** control. It opens Spotlight in that browser window; restricted pages use the helper new-tab UI.

## Trust and recovery

The manifest accepts extension senders so unpacked and installed IDs can be paired manually. Runtime checks allow only the exact configured ID and extension origin, reject website senders, validate protocol versions/payloads, and scope actions to an explicit window. Only Spotlight's own options page can change its pairing.

The transport timeout is five seconds. Mutations are never automatically retried: a timeout can mean the remote action completed after the response was lost. Check the actual tabs before trying again. Reverse launch requests have a bounded service-worker-lifetime replay guard, plus per-window serialization and active helper reuse; the guard is not persisted across worker restarts.

- **Awaiting Arcify approval:** Arcify answered with `UNAUTHORIZED`. Save this installation's Spotlight ID in Arcify's connection settings, then refresh. If it was already saved, compare both displayed IDs with the IDs in the extension manager.
- **Unavailable:** The saved Arcify ID could not be reached, or the check timed out. Check that Arcify is enabled in the same browser profile, verify its ID, reload both extensions, then refresh. This is different from reciprocal approval still being needed.
- **Connection error:** Check the displayed detail. For a protocol mismatch, reload matching builds of both extensions and refresh status.

If either ID changed, update both settings. Disconnect explicitly if you want standalone behavior while Arcify is unavailable. Pending approval never bypasses sender verification or falls back to unpaired actions.

## Verification

Run `npm test` and `npm run build`. Bridge unit/integration tests use fake Chrome APIs and never start a browser. Browser verification requires manually loading both built extensions in a supported Chrome session; unit tests are not a substitute for that check.

A manual check in Helium before the pairing-UX update confirmed that saving both reciprocal IDs establishes the connection. The revised settings UI and broader workspace/navigation examples above still need real-browser acceptance checks.

The unchanged upstream baseline built successfully. Its full test run had 689 passing tests and seven integration timeouts. Both failing files passed all 35 tests with autocomplete networking stubbed. `test/integration/setup.js` now stubs autocomplete fetch for deterministic integration runs; provider networking/error behavior remains covered in its existing unit tests. No production autocomplete behavior changed.

The upstream checkout tracks some `node_modules` files. Do not include dependency-install churn in a bridge commit. The lockfile has not changed.
