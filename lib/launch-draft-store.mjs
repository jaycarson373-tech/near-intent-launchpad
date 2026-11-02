// Non-extractable mint CryptoKeys and the reviewed draft stay in this browser.
// Persist before the first signature so a reload cannot strand paid setup.
async function database(storage, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished=false;
    const end=(error,db)=>{if(finished){db?.close();return;}finished=true;clearTimeout(timer);if(error)reject(error);else resolve(db);};
    const timer=setTimeout(()=>end(Error('Saving coin details timed out. No wallet approval was requested. Retry after closing other Intent Pad tabs.')),timeoutMs);
    let request;
    try {request=storage.open('intent-pad-solana-launch-drafts',1);} catch {end(Error('Launch recovery storage is unavailable. No wallet approval was requested.'));return;}
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => {request.result.onversionchange=()=>request.result.close();end(null,request.result);};
    request.onerror = () => end(Error('This browser cannot save launch recovery. No wallet approval was requested.'));
    request.onblocked = () => end(Error('Launch recovery storage is busy. Close other Intent Pad tabs and retry; no wallet approval was requested.'));
  });
}
export async function launchDraft(action, network, value, {storage=globalThis.indexedDB,timeoutMs=8000}={}) {
  const db = await database(storage,timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', action === 'get' ? 'readonly' : 'readwrite');
      let finished=false;
      const end=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
      const timer=setTimeout(()=>{end(Error('Saving coin details timed out. No new wallet approval was requested.'));try{tx.abort();}catch{}},timeoutMs);
      const store = tx.objectStore('drafts');
      let request;
      try {request=action === 'get' ? store.get(network) : action === 'put' ? store.put(value, network) : store.delete(network);}catch{end(Error('Coin details could not be saved in this browser. No new wallet approval was requested.'));return;}
      tx.oncomplete = () => end(null,request.result);
      tx.onabort = tx.onerror = () => end(Error('Launch recovery could not be saved. No new signature was requested.'));
    });
  } finally { db.close(); }
}

// Keep each wallet's paid setup, mint signer and unresolved signature together.
// Switching the active editor never deletes the previous wallet's recovery copy.
export async function switchWalletDraft(network,nextOwner,{draft=launchDraft,storage=globalThis.localStorage}={}){
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(nextOwner))throw Error('Invalid connected wallet.');
 const current=await draft('get',network),pendingKey=`intent-pad-solana-pending-${network}`;
 if(current?.creator===nextOwner)return;
 if(current?.creator){
  await draft('put',`${network}:${current.creator}`,current);
  const pending=storage.getItem(pendingKey);
  if(pending)storage.setItem(`${pendingKey}:${current.creator}`,pending);
  else storage.removeItem(`${pendingKey}:${current.creator}`);
 }else if(storage.getItem(pendingKey)){
  // Legacy orphan receipts remain recoverable without blocking another wallet.
  storage.setItem(`${pendingKey}:unassigned:${Date.now()}`,storage.getItem(pendingKey));
 }
 const restored=await draft('get',`${network}:${nextOwner}`);
 if(restored&&restored.creator!==nextOwner)throw Error('Saved draft wallet does not match.');
 const savedPending=storage.getItem(`${pendingKey}:${nextOwner}`);
 if(restored)await draft('put',network,restored);else await draft('delete',network);
 if(savedPending)storage.setItem(pendingKey,savedPending);else storage.removeItem(pendingKey);
}
