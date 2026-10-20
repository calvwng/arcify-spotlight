import { describe, it, expect } from 'vitest';
import { ArchiveDefaultRefresh } from '../../shared/archive-default-refresh.js';
import { archiveScope } from '../fixtures/archive-actions.js';
const row = (scope = archiveScope(), command = 'openArchive') => ({ type:'arcify-archive-action',metadata:{archiveAction:{command,scope,entryId:null}} });
const options = extra => ({query:'open archive',manual:false,invalidated:false,focusedResult:false,...extra});
function capture() { const guard=new ArchiveDefaultRefresh(); const controller={refreshing:true,pending:false}; expect(guard.capture(row(),controller,options())).toBe(true); return {guard,controller}; }
describe('automatic Open Archive refresh guard', () => {
    it('keeps the gap empty and accepts fresh tokens in the same stable context', () => {
        const {guard,controller}=capture(); expect(guard.resolve([{type:'search-query'}],controller)).toEqual({index:-1,invalidated:false});
        const scope=archiveScope(); scope.viewId='fresh-view';scope.openIntent='fresh-intent'; controller.refreshing=false;
        expect(guard.resolve([row(scope)],controller)).toEqual({index:0,invalidated:false}); expect(guard.resolve([row(scope)],controller)).toBeNull();
    });
    it.each(['peerId','generation','windowId','spaceId','bookmarkFolderId','sourceTabId','sourceUrl','pairingGeneration'])('rejects changed %s', key => {
        const {guard,controller}=capture(),scope=archiveScope();
        if(['peerId','generation'].includes(key)) scope[key]='changed'; else scope.context[key]='changed';
        controller.refreshing=false; expect(guard.resolve([row(scope)],controller)).toEqual({index:-1,invalidated:true});
    });
    it.each(['manual','invalidated','focusedResult'])('never captures a %s choice', key => {
        const guard=new ArchiveDefaultRefresh(); expect(guard.capture(row(),{refreshing:true},options({[key]:true}))).toBe(false);
    });
    it('does not restore a reopen entry default or substitute a newly ranked action', () => {
        const guard=new ArchiveDefaultRefresh(); expect(guard.capture(row(archiveScope(),'reopenArchivedTab'),{refreshing:true},options())).toBe(false);
        const tracked=capture();tracked.controller.refreshing=false;
        expect(tracked.guard.resolve([{type:'search-query'},row()],tracked.controller)).toEqual({index:-1,invalidated:true});
    });
    it.each(['pending','manual','invalidated','focusedResult','query'])('cancels restoration after %s changes', key => {
        const {guard,controller}=capture(); const next=key==='query'?{query:'other'}:{[key]:true};
        if(key==='pending')controller.pending=true;
        expect(guard.capture(null,controller,options(next))).toBe(false); expect(guard.resolve([row()],controller)).toBeNull();
    });
    it('rejects a failed or unavailable refresh and clears explicit resets', () => {
        const {guard,controller}=capture();controller.refreshing=false;
        expect(guard.resolve([],controller)).toEqual({index:-1,invalidated:true});
        const next=capture();next.guard.reset();expect(next.guard.resolve([row()],next.controller)).toBeNull();
    });
});
