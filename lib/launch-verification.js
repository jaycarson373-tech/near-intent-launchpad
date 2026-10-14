export function reviewedInitialization(transaction,account,owner) {
  if (transaction?.signer_id!==owner || transaction?.receiver_id!==account || account.split('.').length!==owner.split('.').length+1 || !account.endsWith('.'+owner)) throw new Error('The deployment does not belong to this wallet and token subaccount.');
  const actions=transaction.actions;
  if (!Array.isArray(actions) || actions.map(a=>typeof a==='string'?a:Object.keys(a)[0]).join(',')!=='CreateAccount,Transfer,DeployContract,FunctionCall') throw new Error('The transaction is not the reviewed token-creation sequence.');
  const call=actions[3].FunctionCall;
  if (!call || call.method_name!=='new' || String(call.deposit)!=='0') throw new Error('The deployment initializer does not match Intent Pad.');
  let init;try { init=JSON.parse(Buffer.from(call.args,'base64').toString('utf8')); } catch { throw new Error('Token initialization arguments are unreadable.'); }
  if (init.owner_id!==owner || !/^[1-9]\d*$/.test(String(init.total_supply)) || BigInt(init.total_supply)>2n**128n-1n || init.metadata?.spec!=='ft-1.0.0' || !Number.isInteger(init.metadata.decimals) || init.metadata.decimals<0 || init.metadata.decimals>24 || typeof init.metadata.name!=='string' || typeof init.metadata.symbol!=='string') throw new Error('The token owner, supply or metadata does not match the reviewed deployment.');
  return init;
}
export function assertInitializedToken(init,metadata,supply) {
  if (String(init.total_supply)!==supply || ['spec','name','symbol','decimals'].some(k=>init.metadata[k]!==metadata[k])) throw new Error('The on-chain token does not match its deployment transaction.');
}
