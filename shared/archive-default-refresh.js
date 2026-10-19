// Restore only an untouched automatic Open Archive default after token rotation.
// This does not preserve executable scopes or manual/focused action choices.
function openIdentity(result) {
    const action = result?.metadata?.archiveAction;
    if (result?.type !== 'arcify-archive-action' || action?.command !== 'openArchive' || !action.scope?.openIntent) return null;
    const { peerId, generation, context } = action.scope;
    return JSON.stringify([peerId, generation, context.windowId, context.spaceId,
        context.bookmarkFolderId, context.sourceTabId, context.sourceUrl, context.pairingGeneration]);
}
export class ArchiveDefaultRefresh {
    reset() { this.candidate = null; }
    capture(previous, controller, { query, manual, invalidated, focusedResult }) {
        if (this.candidate && (query !== this.candidate.query || manual || invalidated || focusedResult || controller?.pending)) this.reset();
        if (!this.candidate && controller?.refreshing && !controller.pending && query && !manual && !invalidated && !focusedResult) {
            const identity = openIdentity(previous);
            if (identity) this.candidate = { identity, query };
        }
        return Boolean(this.candidate);
    }
    resolve(results, controller) {
        if (!this.candidate) return null;
        if (controller?.refreshing) return { index: -1, invalidated: false };
        const identity = this.candidate.identity;
        this.reset();
        // Do not substitute another default if ranking/context/capability changed.
        const same = !controller?.pending && openIdentity(results[0]) === identity;
        return { index: same ? 0 : -1, invalidated: !same };
    }
}
