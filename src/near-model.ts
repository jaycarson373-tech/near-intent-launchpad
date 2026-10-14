export type TokenDraft={name:string;ticker:string;description:string;slug:string;supply:string;decimals:number;savedAt?:string}
export const EMPTY_DRAFT:TokenDraft={name:'',ticker:'',description:'',slug:'',supply:'1000000000',decimals:18}
export function validAccount(value:string){return value.length>=2&&value.length<=64&&/^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/.test(value)}
export function tokenPlan(draft:TokenDraft,owner:string){
 if(!validAccount(owner)||/^[0-9a-f]{64}$/.test(owner))throw new Error('Connect a named NEAR account to create a token subaccount.');
 const name=draft.name.trim(),symbol=draft.ticker.trim().toUpperCase(),slug=draft.slug.trim().toLowerCase();
 if(!name||name.length>40)throw new Error('Use a token name of 1 to 40 characters.');
 if(!/^[A-Z0-9]{1,10}$/.test(symbol))throw new Error('Use a ticker of 1 to 10 letters or numbers.');
 if(!/^[a-z][a-z0-9-]{1,15}$/.test(slug)||slug.endsWith('-'))throw new Error('Use a token account prefix of 2 to 16 lowercase letters, numbers or hyphens.');
 const contract=slug+'.'+owner;if(!validAccount(contract))throw new Error('The complete token account must be no longer than 64 characters.');
 if(!Number.isInteger(draft.decimals)||draft.decimals<0||draft.decimals>24)throw new Error('Choose 0 to 24 decimal places.');
 if(!/^[1-9]\d{0,38}$/.test(draft.supply))throw new Error('Enter a positive whole-number token supply.');
 const atomicSupply=BigInt(draft.supply)*10n**BigInt(draft.decimals);if(atomicSupply>2n**128n-1n)throw new Error('The supply exceeds the NEP-141 balance limit at these decimals.');
 return {contract,owner,supply:atomicSupply.toString(),metadata:{spec:'ft-1.0.0',name,symbol,decimals:draft.decimals,icon:null,reference:null,reference_hash:null}}
}
export function formatNear(atomic:string){const s=atomic.padStart(25,'0');return (s.slice(0,-24)+'.'+s.slice(-24).replace(/0+$/,'')).replace(/\.$/,'')}
export function validateDeployedToken(plan:ReturnType<typeof tokenPlan>,result:{metadata:{name:string;symbol:string;decimals:number};supply:string;account:string;owner:string}){if(result.account!==plan.contract||result.owner!==plan.owner||result.supply!==plan.supply||result.metadata.name!==plan.metadata.name||result.metadata.symbol!==plan.metadata.symbol||result.metadata.decimals!==plan.metadata.decimals)throw new Error('The on-chain token does not match the reviewed launch.');return true}
