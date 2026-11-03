type Recovery = {creator:string;publicKey:string;launchId?:string;completedPhases?:string[];coin?:unknown;review?:{flow?:string;wire?:string;id:string;launchId?:string;phase?:string;creator:string;mint:string};signed?:Uint8Array;signature?:string;bundleSigned?:Uint8Array[]};
export function phaseReceipt<T extends Recovery>(saved:T,receipt:{status:string;launchId?:string;phase?:string;signature?:string;coin?:unknown}):T;
export function stagedContinuation(saved:Recovery,owner:string):{flow:'staged-v1';launchId:string;previousId:string;creator:string;mint:string;feeAllocationVersion:2};
export function finishableBuy(saved:Recovery):boolean;

export function canonicalSignedReceipt<T extends Recovery>(saved:T,receipt:{status:string;id?:string;launchId?:string;phase?:string;signature?:string;wire?:string}):T;
