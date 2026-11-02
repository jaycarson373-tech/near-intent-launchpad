export function launchDraft(action:'get'|'put'|'delete',network:string,value?:unknown,options?:{storage?:IDBFactory;timeoutMs?:number}):Promise<unknown>;
export function switchWalletDraft(network:string,nextOwner:string,options?:unknown):Promise<void>;
