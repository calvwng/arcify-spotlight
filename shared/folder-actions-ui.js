import { FOLDER_RESULT_TYPE, folderResults } from './folder-search.js';
import { trustedActionGesture } from './arcify-space-actions-ui.js';

export class FolderActionController {
    constructor({ api = chrome, parent, input, newTab = false, onChange = () => {}, showError = () => {} }) {
        Object.assign(this, { api, parent, input, newTab, onChange, showError });
        this.folders = []; this.revision = 0; this.disposed = false; this.pending = false;
        this.ready = this.prepare();
    }
    async request(command, fields = {}) {
        const response = await this.api.runtime.sendMessage({ action: 'spotlightFolders', command, ...fields, ...(this.tabId ? { tabId: this.tabId } : {}) });
        if (!response?.success) throw new Error(response?.error || 'Folder action was not confirmed.');
        return response;
    }
    async prepare() {
        const revision = ++this.revision;
        if (this.api.extension?.inIncognitoContext) return;
        try {
            if (this.newTab && this.api.tabs?.getCurrent) this.tabId = (await this.api.tabs.getCurrent())?.id;
            const { folders } = await this.request('list'); if (!this.disposed && revision === this.revision) { this.folders = folders; this.onChange(); } }
        catch { /* Ordinary search remains available when bookmarks are unavailable. */ }
    }
    results(query) { return this.disposed ? [] : folderResults(this.folders, query); }
    invoke(result, event) {
        if (result?.type !== FOLDER_RESULT_TYPE) return false;
        if (!this.disposed && !this.pending && trustedActionGesture(event)) this.operation = this.browse(result.metadata.folder.id);
        return true;
    }
    async browse(id) {
        const revision = ++this.revision;
        this.pending = true;
        try {
            const [{ folder, children }, management] = await Promise.all([this.request('children', { id }), this.managementContext(id).catch(() => null)]);
            if (this.disposed || revision !== this.revision) return;
            this.panel?.remove();
            const doc = this.parent.ownerDocument;
            const panel = doc.createElement('section'); this.panel = panel;
            panel.className = 'spotlight-folder-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', `Browse ${folder.title}`);
            Object.assign(panel.style, { position: 'relative', maxHeight: '420px', zIndex: '10', background: 'var(--spotlight-bg, #202124)', color: 'inherit', padding: '16px', overflow: 'auto', borderRadius: '12px' });
            const heading = doc.createElement('h3'); heading.textContent = this.folders.find(item => item.id === id)?.path || folder.title; panel.append(heading);
            const add = (label, action) => {
                const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
                Object.assign(button.style, { display: 'block', margin: '6px 0', padding: '8px', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', background: '#414141', border: '1px solid #888', borderRadius: '6px', cursor: 'pointer' });
                button.addEventListener('click', async event => { if (this.pending || !trustedActionGesture(event)) return; this.pending = true; try { await action(); } catch (error) { this.reportError(error.message); } finally { this.pending = false; } });
                panel.append(button); return button;
            };
            const close = add('Back to search', () => this.close());
            if (folder.parentId && folder.parentId !== '0') add('↑ Parent folder', () => this.browse(folder.parentId));
            if (management?.scope) {
                if (id === management.scope.context.bookmarkFolderId || management.scope.context.ancestors.length === 1 && !management.scope.context.syncTabGroups) add('Create subfolder…', () => this.manage(id, 'createChildFolder'));
                else { const limit = doc.createElement('p'); limit.textContent = 'Subfolders unavailable here: Arcify allows two folder levels, and nesting requires native group sync off.'; panel.append(limit); }
                if (id !== management.scope.context.bookmarkFolderId) {
                    add('Rename folder…', () => this.manage(id, 'renameSavedFolder'));
                    if (management.scope.destinations?.length) add('Move folder to another Space…', () => this.manage(id, 'moveSavedFolderToSpace'));
                    if (!children.length) add('Delete empty folder…', () => this.manage(id, 'deleteEmptyFolder'));
                }
            }
            if (!management?.scope) { const note = doc.createElement('p'); note.textContent = 'Inline changes require a matching paired Arcify build and a folder in the selected Space.'; panel.append(note); }
            add('Manage this folder in Bookmark Manager', () => this.request('manage', { id }));
            for (const child of children) add(`${child.url ? '↗' : '▸'} ${child.title || child.url || 'Untitled folder'}`, () => child.url ? this.request('openBookmark', { id, bookmarkId: child.id }) : this.browse(child.id));
            if (!children.length) { const empty = doc.createElement('p'); empty.textContent = 'This folder is empty.'; panel.append(empty); }
            panel.addEventListener('keydown', event => {
                event.stopPropagation();
                if (event.key === 'Enter' && (event.repeat || event.isComposing)) { event.preventDefault(); return; }
                if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.close(); }
                if (event.key === 'Tab') {
                    const controls = [...panel.querySelectorAll('button, input, select')];
                    const index = controls.indexOf(doc.activeElement);
                    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
                    else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
                }
            });
            if (!this.hiddenChildren) {
                this.hiddenChildren = [...this.parent.children].map(child => [child, child.inert, child.hidden]);
                for (const [child] of this.hiddenChildren) { child.inert = true; child.hidden = true; }
            }
            this.parent.append(panel); close.focus();
        } catch (error) { if (!this.disposed) this.reportError(error.message); }
        finally { this.pending = false; }
    }
    async managementContext(folderId) {
        return this.api.runtime.sendMessage({ action: 'arcifyFolderContext', folderId, ...(this.tabId ? { tabId: this.tabId } : {}) });
    }
    async manage(id, command) {
        const revision = ++this.revision;
        const response = await this.managementContext(id);
        if (this.disposed || revision !== this.revision || !this.panel) return;
        if (!response?.success || !response.scope) throw new Error(response?.error || 'Inline management requires a paired Arcify build and a folder in the selected Space.');
        const scope = response.scope;
        const panel = this.panel, doc = panel.ownerDocument;
        panel.replaceChildren();
        const heading = doc.createElement('h3'); heading.textContent = command === 'deleteEmptyFolder' ? `Delete empty folder “${scope.context.folder.title}”?` : command === 'createChildFolder' ? 'Create subfolder' : command === 'moveSavedFolderToSpace' ? 'Move folder to another Space' : 'Rename folder'; panel.append(heading);
        const name = doc.createElement('input'); name.type = 'text'; name.maxLength = 256; name.setAttribute('aria-label', 'Folder name');
        name.value = command === 'renameSavedFolder' ? scope.context.folder.title : '';
        if (!['deleteEmptyFolder','moveSavedFolderToSpace'].includes(command)) panel.append(name);
        const destination = doc.createElement('select'); destination.setAttribute('aria-label', 'Destination Space');
        if (command === 'moveSavedFolderToSpace') {
            const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a Space…'; placeholder.disabled = true; placeholder.selected = true; destination.append(placeholder);
            for (const [index, target] of scope.destinations.entries()) { const option = doc.createElement('option'); option.value = String(index); option.textContent = `${target.name} (${target.spaceId})`; destination.append(option); }
            panel.append(destination);
        }
        const error = doc.createElement('p'); error.setAttribute('role', 'alert'); panel.append(error);
        const cancel = doc.createElement('button'); cancel.textContent = 'Cancel'; cancel.type = 'button'; panel.append(cancel);
        const submit = doc.createElement('button'); submit.textContent = command === 'deleteEmptyFolder' ? 'Delete empty folder' : command === 'moveSavedFolderToSpace' ? 'Move folder' : 'Save'; submit.type = 'button'; panel.append(submit);
        cancel.addEventListener('click', event => { if (trustedActionGesture(event) && !this.pending) this.browse(id); });
        const submitAction = async event => {
            if (!trustedActionGesture(event) || this.pending || submit.disabled) return;
            const title = name.value.trim();
            const target = scope.destinations?.[Number(destination.value)];
            if (command === 'moveSavedFolderToSpace' && (!destination.value || !target)) { error.textContent = 'Choose a destination Space.'; return; }
            if (!['deleteEmptyFolder','moveSavedFolderToSpace'].includes(command) && (!title || title.length > 256 || /[\u0000-\u001f\u007f]/.test(title))) { error.textContent = 'Enter a name of 1–256 characters without control characters.'; return; }
            this.pending = true; submit.disabled = true;
            try {
                const result = await this.api.runtime.sendMessage({ action: 'arcifyFolderAction', command, scope, fields: command === 'deleteEmptyFolder' ? { confirmed: true } : command === 'moveSavedFolderToSpace' ? { destination: {spaceId: target.spaceId, bookmarkFolderId: target.bookmarkFolderId} } : { title }, ...(this.tabId ? { tabId: this.tabId } : {}) });
                if (this.disposed || revision !== this.revision) return;
                if (!result?.success) throw new Error(result?.error || 'The folder action was not confirmed. Inspect it before trying again.');
                const refreshed = await this.request('list');
                if (this.disposed || revision !== this.revision) return;
                this.folders = refreshed.folders; this.onChange();
                if (this.disposed || revision !== this.revision) return;
                await this.browse(command === 'deleteEmptyFolder' ? scope.context.folder.parentId : id);
            } catch (failure) { if (!this.disposed && revision === this.revision) error.textContent = failure.message; }
            finally { this.pending = false; }
        };
        submit.addEventListener('click', submitAction);
        name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submitAction(event); } });
        // Delete starts on Cancel; held Enter must never confirm a deletion.
        (command === 'deleteEmptyFolder' ? cancel : command === 'moveSavedFolderToSpace' ? destination : name).focus();
    }
    reportError(message) { if (!this.panel) { this.showError(message); return; } const error = this.panel.ownerDocument.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = message; this.panel.append(error); }
    restore() { this.panel?.remove(); this.panel = null; for (const [child, inert, hidden] of this.hiddenChildren || []) { child.inert = inert; child.hidden = hidden; } this.hiddenChildren = null; }
    close() { this.revision++; this.restore(); this.input.focus(); this.ready = this.prepare(); }
    dispose() { this.disposed = true; this.revision++; this.restore(); }
}
