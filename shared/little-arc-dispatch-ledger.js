// Session-scoped uncertainty fence. Contains no URL, title, or authorization.
// It survives worker reconnect/restart. Only confirmed commit or native tab
// removal retires it; refreshing choices must never retry a dispatched move.
export function createLittleArcDispatchLedger(api){
 const key='littleArcHeaderDispatchV1';let queue=Promise.resolve();const blocked=new Set();
 const run=fn=>{const job=queue.then(fn);queue=job.catch(()=>{});return job;};
 const read=async()=>{const value=(await api.storage.session.get(key))[key]??{};if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid dispatch ledger');return value;};
 return {
  blocked:tabId=>run(async()=>blocked.has(tabId)||Object.hasOwn(await read(),String(tabId))),
  claim:(tabId,windowId,operation)=>run(async()=>{
   const data=await read();if(blocked.has(tabId)||Object.hasOwn(data,String(tabId))||Object.keys(data).length>=256)throw Error('Unresolved placement');
   blocked.add(tabId);data[tabId]={windowId,operation};
   await api.storage.session.set({[key]:data});
   const saved=(await read())[tabId];if(saved?.operation!==operation||saved?.windowId!==windowId)throw Error('Unconfirmed dispatch fence');
  }),
  retire:(tabId,operation)=>run(async()=>{const data=await read();if(operation!==null&&data[tabId]?.operation!==operation)return;delete data[tabId];await api.storage.session.set({[key]:data});if(Object.hasOwn(await read(),String(tabId)))throw Error('Unconfirmed fence retirement');blocked.delete(tabId);})
 };
}
