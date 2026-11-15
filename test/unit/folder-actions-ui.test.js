// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { FolderActionController } from '../../shared/folder-actions-ui.js';
function setup(send = async message => message.command === 'list' ? {success:true,folders:[{id:'2',title:'Areas',path:'Work / Areas'}]} : {success:true,folder:{id:'2',title:'Areas',parentId:'1'},children:[]}) {
 document.body.innerHTML='<div id="parent"><input><div id="results"></div></div>';
 const parent = document.querySelector('#parent'); const input=parent.querySelector('input');
 const api={runtime:{sendMessage:vi.fn(message => message.action === 'arcifyFolderContext' ? Promise.resolve({success:true,scope:null}) : send(message))}};
 const controller = new FolderActionController({api,parent,input});
 return {controller,api,parent,input};
}
it('opens an accessible browser, restores search after Escape, and refreshes names', async () => {
 const {controller,parent,input}=setup(); await controller.ready; await controller.browse('2');
 expect(parent.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Browse Areas');
 expect(input.hidden).toBe(true); expect(parent.textContent).toContain('This folder is empty.');
 parent.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 expect(parent.querySelector('[role=dialog]')).toBeNull(); expect(input.hidden).toBe(false); expect(document.activeElement).toBe(input);
 controller.dispose();
});
it('ignores an old load after disposal', async () => {
 let resolve; const {controller,parent}=setup(message=>message.command==='list'?Promise.resolve({success:true,folders:[]}):new Promise(done=>resolve=done));
 await controller.ready; const opening=controller.browse('2'); controller.dispose(); resolve({success:true,folder:{id:'2',title:'Areas'},children:[]}); await opening;
 expect(parent.querySelector('[role=dialog]')).toBeNull();
});
it('does not execute synthetic click actions', async () => {
 const {controller,api,parent}=setup(); await controller.ready; await controller.browse('2'); const count=api.runtime.sendMessage.mock.calls.length;
 [...parent.querySelectorAll('button')].find(x=>x.textContent.startsWith('Manage')).click();
 expect(api.runtime.sendMessage).toHaveBeenCalledTimes(count); controller.dispose();
});
it('requires separate delete confirmation and blocks repeated Enter', async () => {
 const spy=vi.spyOn(EventTarget.prototype,'addEventListener');
 const {controller,api,parent}=setup(); await controller.ready;
 const scope={context:{ancestors:[{id:'1'}],syncTabGroups:false,bookmarkFolderId:'1',folder:{id:'2',parentId:'1',title:'Areas',children:[]}}};
 api.runtime.sendMessage.mockImplementation(async message=>message.action==='arcifyFolderContext'?{success:true,scope}:message.action==='arcifyFolderAction'?{success:true,result:{folderId:'2'}}:message.command==='list'?{success:true,folders:[]}:{success:true,folder:{id:message.id,title:'Areas',parentId:'1'},children:[]});
 await controller.browse('2'); await controller.manage('2','deleteEmptyFolder');
 expect(document.activeElement.textContent).toBe('Cancel');
 expect(api.runtime.sendMessage.mock.calls.some(([m])=>m.action==='arcifyFolderAction')).toBe(false);
 const submit=[...parent.querySelectorAll('button')].find(b=>b.textContent==='Delete empty folder');
 const listener=spy.mock.calls.find(([type],i)=>type==='click'&&spy.mock.contexts[i]===submit)[1];
 await listener({type:'click',button:0,isTrusted:true});
 expect(api.runtime.sendMessage.mock.calls.filter(([m])=>m.action==='arcifyFolderAction')).toHaveLength(1);
 expect(api.runtime.sendMessage.mock.calls.find(([m])=>m.action==='arcifyFolderAction')[0].fields).toEqual({confirmed:true});
 controller.dispose(); spy.mockRestore();
});
it('preserves errors inline and does not retry an uncertain write', async () => {
 const spy=vi.spyOn(EventTarget.prototype,'addEventListener'); const {controller,api,parent}=setup(); await controller.ready;
 api.runtime.sendMessage.mockImplementation(async m=>m.action==='arcifyFolderContext'?{success:true,scope:{context:{ancestors:[{id:'1'}],syncTabGroups:false,folder:{id:'2',title:'Areas'},bookmarkFolderId:'1'}}}:m.action==='arcifyFolderAction'?{success:false,error:'Uncertain outcome; inspect folder'}:{success:true,folder:{id:'2',title:'Areas'},children:[]});
 await controller.browse('2'); await controller.manage('2','renameSavedFolder');
 const name=parent.querySelector('[aria-label="Folder name"]');name.value='New';
 const listener=spy.mock.calls.find(([type],i)=>type==='keydown'&&spy.mock.contexts[i]===name)[1];
 listener({type:'keydown',key:'Enter',isTrusted:true,preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,0));
 expect(parent.textContent).toContain('Uncertain outcome');expect([...parent.querySelectorAll('button')].find(b=>b.textContent==='Save').disabled).toBe(true);
 expect(api.runtime.sendMessage.mock.calls.filter(([m])=>m.action==='arcifyFolderAction')).toHaveLength(1);controller.dispose();spy.mockRestore();
});
it('cannot reopen a dismissed panel when post-save refresh completes late', async () => {
 const spy=vi.spyOn(EventTarget.prototype,'addEventListener');const {controller,api,parent}=setup();await controller.ready;
 let resolveRefresh, waitForRefresh=false;
 const scope={context:{ancestors:[{id:'1'}],syncTabGroups:false,folder:{id:'2',parentId:'1',title:'Areas'},bookmarkFolderId:'1'}};
 api.runtime.sendMessage.mockImplementation(async message=>{
  if(message.action==='arcifyFolderContext')return {success:true,scope};
  if(message.action==='arcifyFolderAction'){waitForRefresh=true;return {success:true,result:{folderId:'2'}};}
  if(message.command==='list'&&waitForRefresh){waitForRefresh=false;return new Promise(resolve=>resolveRefresh=resolve);}
  if(message.command==='list')return {success:true,folders:[]};
  return {success:true,folder:{id:'2',title:'Areas'},children:[]};
 });
 await controller.browse('2');await controller.manage('2','renameSavedFolder');
 const submit=[...parent.querySelectorAll('button')].find(b=>b.textContent==='Save');
 const listener=spy.mock.calls.find(([type],i)=>type==='click'&&spy.mock.contexts[i]===submit)[1];
 const saving=listener({type:'click',button:0,isTrusted:true});
 for(let i=0;i<10;i++)await Promise.resolve();
 expect(resolveRefresh).toBeTypeOf('function');controller.close();resolveRefresh({success:true,folders:[]});await saving;
 expect(parent.querySelector('[role=dialog]')).toBeNull();controller.dispose();spy.mockRestore();
});
