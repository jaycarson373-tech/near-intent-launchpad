// Pump instruction builders remain in the legacy adapter. Kit owns v1 wire
// encoding: web3.js 1.x can read v1 but cannot serialize its message/envelope.
import * as web3 from '@solana/web3.js';
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageConfig,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
} from '@solana/kit';
export const MAX_LAUNCH_BASE64 = 5500;
export function decodeLaunchTransaction(wire) {
  const bytes = new Uint8Array(wire);
  if (bytes.length > 4096) throw Error('Invalid signed transaction size.');
  const decoded = getTransactionDecoder().decode(bytes);
  const message = web3.VersionedMessage.deserialize(decoded.messageBytes);
  if (message.version !== 1) {
    if (bytes.length > 1232) throw Error('Invalid signed transaction size.');
    return web3.VersionedTransaction.deserialize(bytes);
  }
  const originalBytes = new Uint8Array(decoded.messageBytes);
  message.serialize = () => new Uint8Array(originalBytes);
  const keys = message.staticAccountKeys.slice(
    0,
    message.header.numRequiredSignatures,
  );
  const tx = new web3.VersionedTransaction(
    message,
    keys.map((k) => new Uint8Array(decoded.signatures[k.toBase58()] || 64)),
  );
  tx.serialize = () =>
    new Uint8Array(
      getTransactionEncoder().encode({
        messageBytes: originalBytes,
        signatures: Object.fromEntries(
          keys.map((k, i) => [k.toBase58(), tx.signatures[i]]),
        ),
      }),
    );
  return tx;
}
export function compileLaunchV1({
  payer,
  latest,
  instructions,
  computeUnitLimit = 1400000,
  loadedAccountsDataSizeLimit = 67108864,
  priorityFeeLamports = 1400n,
}) {
  let message = createTransactionMessage({ version: 1 });
  message = setTransactionMessageFeePayer(payer.toBase58(), message);
  message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: latest.blockhash,
      lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
    },
    message,
  );
  message = setTransactionMessageConfig(
    { computeUnitLimit, loadedAccountsDataSizeLimit, priorityFeeLamports },
    message,
  );
  message = appendTransactionMessageInstructions(
    instructions.map((ix) => ({
      programAddress: ix.programId.toBase58(),
      accounts: ix.keys.map((k) => ({
        address: k.pubkey.toBase58(),
        role: (k.isSigner ? 2 : 0) + (k.isWritable ? 1 : 0),
      })),
      data: new Uint8Array(ix.data),
    })),
    message,
  );
  const wire = getTransactionEncoder().encode(compileTransaction(message));
  if (wire.length > 4096)
    throw Error(
      'Launch exceeds the atomic transaction size limit. No payment was requested.',
    );
  return decodeLaunchTransaction(wire);
}

export async function readLaunchReceipt(rpc,signature){
 if(typeof rpc._rpcRequest!=='function')return rpc.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:1});
 const response=await rpc._rpcRequest('getTransaction',[signature,{commitment:'finalized',maxSupportedTransactionVersion:1,encoding:'base64'}]);
 if(response.error)throw Error('Launch receipt is temporarily unavailable. Keep checking the saved transaction.');
 if(!response.result)return null;
 const result=response.result;
 if(!Array.isArray(result.transaction)||result.transaction[1]!=='base64')throw Error('Invalid launch receipt encoding.');
 const tx=decodeLaunchTransaction(Buffer.from(result.transaction[0],'base64'));
 // Raw JSON-RPC lookup addresses are base58 strings. Match web3's normal
 // getTransaction response before any account identity or sale-history check.
 const loaded=result.meta?.loadedAddresses;
 if(loaded&&(!Array.isArray(loaded.writable)||!Array.isArray(loaded.readonly)))throw Error('Invalid receipt lookup addresses.');
 const meta=loaded?{...result.meta,loadedAddresses:{writable:loaded.writable.map(k=>new web3.PublicKey(k)),readonly:loaded.readonly.map(k=>new web3.PublicKey(k))}}:result.meta;
 return {...result,meta,transaction:{message:tx.message,signatures:tx.signatures}};
}
