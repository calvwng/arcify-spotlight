import { it, expect, vi } from 'vitest';
import { ArcifyFolderActionsClient } from '../../shared/arcify-folder-actions.js';
const peer = 'b'.repeat(32), source = {windowId:2,tabId:9};
const context = { windowId:2, sourceTabId:9, pairingGeneration:'arcify', spaceId:'space',bookmarkFolderId:'1',folder:{id:'2',parentId:'1',title:'Areas',url:null,children:[]}, ancestors:[{id:'1',parentId:'0',title:'Work'}],syncTabGroups:false };
const snapshot = { windowId:2,activeSpaceId:'space',capturedAt:1,spaces:[{id:'space',name:'Work',color:'purple',bookmarkFolderId:'1',tabIds:[9],pinnedTabIds:[],temporaryTabIds:[9]}],tabs:[{id:9,windowId:2,spaceId:'space',title:'Example',url:'https://example.com/',active:true,pinned:false}],bookmarks:[] };
function setup(otherSpace = false) {
 const liveSnapshot = structuredClone(snapshot);
 if (otherSpace) liveSnapshot.spaces.push({id:"other",name:"Other",color:"purple",bookmarkFolderId:"10",tabIds:[],pinnedTabIds:[],temporaryTabIds:[]});
 const state={peer, generation:'spotlight',context:structuredClone(context)};
 const api={storage:{local:{get:async()=>({arcifyBridgePeerId:state.peer,arcifyBridgePairingGeneration:state.generation})}}};
 const bridge={getPeerId:async()=>state.peer,serializeAction:fn=>fn()};
 const envelope = value => ({type:'arcify-bridge',version:1,requestId:'test',role:'arcify',ok:true,...value});
 const send=vi.fn(async(_,command)=>envelope(command==='hello'?{extensionId:peer,capabilities:['folderActionsV1']}:command==='folderActionContext'?{extensionId:peer,snapshot:liveSnapshot,folderContext:structuredClone(state.context)}:{snapshot:liveSnapshot,folderId:'2',...(command==='moveSavedFolderToSpace'?{destinationSpaceId:'other'}:{})}));
 return {client:new ArcifyFolderActionsClient(api,bridge,send),send,state};
}
it('negotiates folder capability and binds exact selected Space/folder',async()=>{const {client}=setup();expect((await client.readFolder(source,'2')).context).toEqual(context);});
it('degrades older peers to no inline management',async()=>{const {client,send}=setup();send.mockResolvedValueOnce({extensionId:peer,capabilities:[]});expect(await client.readFolder(source,'2')).toBeNull();});
it('rejects conflicting folder identity',async()=>{const {client,state}=setup();state.context.folder.id='3';await expect(client.readFolder(source,'2')).rejects.toThrow('conflicting');});
it('revalidates and dispatches once',async()=>{const {client,send}=setup();const scope=await client.readFolder(source,'2');const before=vi.fn(async()=>{});await client.executeFolder(source,scope,'renameSavedFolder',{title:'New'},before);expect(send.mock.calls.filter(x=>x[1]==='renameSavedFolder')).toHaveLength(1);expect(before).toHaveBeenCalledOnce();});
it('rejects stale subtree and re-pairing without mutation',async()=>{const {client,send,state}=setup();const scope=await client.readFolder(source,'2');state.context.folder.title='New';await expect(client.executeFolder(source,scope,'deleteEmptyFolder',{confirmed:true},async()=>{})).rejects.toThrow('changed');expect(send.mock.calls.filter(x=>x[1]==='deleteEmptyFolder')).toHaveLength(0);state.generation='new';await expect(client.executeFolder(source,scope,'deleteEmptyFolder',{confirmed:true},async()=>{})).rejects.toThrow('pairing');});
it('requires explicit delete confirmation and bounded safe names',async()=>{const {client}=setup();const scope=await client.readFolder(source,'2');for(const [command,fields] of [['deleteEmptyFolder',{confirmed:false}],['renameSavedFolder',{title:'bad\nname'}],['createChildFolder',{title:' '}]])await expect(client.executeFolder(source,scope,command,fields,async()=>{})).rejects.toThrow('Invalid');});
it('never retries an uncertain mutation',async()=>{const {client,send}=setup();const scope=await client.readFolder(source,'2');const original=send.getMockImplementation();send.mockImplementation(async(...args)=>{if(args[1]==='renameSavedFolder')throw new Error('timeout');return original(...args);});await expect(client.executeFolder(source,scope,'renameSavedFolder',{title:'New'},async()=>{})).rejects.toThrow('timeout');expect(send.mock.calls.filter(x=>x[1]==='renameSavedFolder')).toHaveLength(1);});

it('moves only to a captured destination and checks the returned destination', async()=>{const {client,send}=setup(true);const scope=await client.readFolder(source,'2');await client.executeFolder(source,scope,'moveSavedFolderToSpace',{destination:{spaceId:'other',bookmarkFolderId:'10'}},async()=>{});expect(send.mock.calls.filter(x=>x[1]==='moveSavedFolderToSpace')).toHaveLength(1);await expect(client.executeFolder(source,scope,'moveSavedFolderToSpace',{destination:{spaceId:'unknown',bookmarkFolderId:'10'}},async()=>{})).rejects.toThrow('Invalid');});
it('rejects malformed bounded context before offering actions',async()=>{const {client,state}=setup();state.context.folder.extra='unexpected';await expect(client.readFolder(source,'2')).rejects.toThrow('conflicting');});
