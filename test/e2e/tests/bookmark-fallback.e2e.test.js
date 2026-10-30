import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowserWithExtension, waitForExtension, openNewTabPage, closeBrowser } from '../setup.js';

// Fresh Puppeteer profile only. No personal browser/profile, policy overrides or
// sandbox-disabling flags. Optional executable override supports installed test Chromium.
test('saved bookmark fallback: fixture browser acceptance', { timeout: 45000 }, async () => {
    let browser;
    try {
        browser = await launchBrowserWithExtension(process.env.SPOTLIGHT_TEST_CHROMIUM
            ? { executablePath: process.env.SPOTLIGHT_TEST_CHROMIUM } : {});
        const { worker, extensionId } = await waitForExtension(browser);
        console.log('fixture extension ready');
        const ids = await worker.evaluate(async () => {
            const tree=await chrome.bookmarks.getTree();
            const parentId=tree[0].children.find(node=>!node.url).id;
            const root=await chrome.bookmarks.create({parentId,title:'Arcify'});
            const space=await chrome.bookmarks.create({parentId:root.id,title:'Fixture Work'});
            const nested=await chrome.bookmarks.create({parentId:space.id,title:'Fixture Research'});
            const empty=await chrome.bookmarks.create({parentId:space.id,title:'Fixture Empty'});
            const a=await chrome.bookmarks.create({parentId:space.id,title:'Fixture Link',url:'https://example.test/fixture'});
            const b=await chrome.bookmarks.create({parentId:nested.id,title:'Fixture Link',url:'https://example.test/fixture'});
            return {root:root.id,space:space.id,nested:nested.id,empty:empty.id,a:a.id,b:b.id};
        });
        const page=await openNewTabPage(browser,extensionId);
        console.log('fixture page ready');
        const search=async query=>page.evaluate(query=>chrome.runtime.sendMessage({action:'getLocalSuggestions',query,mode:'new-tab'}),query);
        let response=await search('Fixture Link');
        assert.equal(response.success,true);
        const rows=response.results.filter(row=>row.metadata?.savedBookmark && !row.metadata.savedBookmark.folder);
        assert.deepEqual(new Set(rows.map(row=>row.metadata.bookmarkId)),new Set([ids.a,ids.b]));
        await worker.evaluate(()=>chrome.storage.local.set({arcifyBridgePeerId:'a'.repeat(32)}));
        response=await search('Fixture Link');
        assert.match(response.discoveryStatus,/connection unavailable/);
        const fallback=response.results.find(row=>row.metadata?.bookmarkFallback && row.metadata.bookmarkId===ids.a);
        // Observe ordinary native tab creation without contacting the network.
        await page.setRequestInterception(true);
        page.on('request',request=>request.url().startsWith('https://example.test/')?request.abort():request.continue());
        const opened=await page.evaluate(result=>chrome.runtime.sendMessage({action:'spotlightHandleResult',result,mode:'new-tab'}),fallback);
        assert.equal(opened.success,true);
        await worker.evaluate(id=>chrome.bookmarks.update(id,{title:'Fixture Renamed'}),ids.a);
        const stale=await page.evaluate(result=>chrome.runtime.sendMessage({action:'spotlightHandleResult',result,mode:'new-tab'}),fallback);
        assert.equal(stale.success,false);
        await worker.evaluate(()=>chrome.storage.local.remove('arcifyBridgePeerId'));
        console.log('fixture unavailable navigation and stale selection passed');
        const folders=await search('Fixture Empty');
        const folder=folders.results.find(row=>row.metadata?.savedBookmark?.id===ids.empty);
        assert.equal(folder.url,`chrome://bookmarks/?id=${ids.empty}`);
        const before=await worker.evaluate(()=>chrome.tabs.query({}).then(tabs=>tabs.length));
        const folderOpen=await page.evaluate(result=>chrome.runtime.sendMessage({action:'spotlightHandleResult',result,mode:'new-tab'}),folder);
        assert.equal(folderOpen.success,true);
        const after=await worker.evaluate(()=>chrome.tabs.query({}));
        assert.equal(after.length,before+1,'Folder opens one tab, never its descendants');
        assert.ok(after.some(tab=>(tab.url||tab.pendingUrl)===folder.url));
        console.log('fixture folder-manager navigation passed');
    } finally {
        if (browser) {
            const fixtureProcess=browser.process();
            const cleanupTimer=setTimeout(()=>fixtureProcess?.kill(),5000);
            try { await closeBrowser(browser); } finally { clearTimeout(cleanupTimer); }
        }
    }
});
