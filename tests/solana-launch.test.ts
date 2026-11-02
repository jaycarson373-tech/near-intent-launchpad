import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,TransactionInstruction,SystemProgram,PublicKey} from '@solana/web3.js';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {ed25519} from '@noble/curves/ed25519';
import {compileLaunchV1,decodeLaunchTransaction} from '../lib/launch-wire.mjs';
import {walletSignedLaunchMatches,cloutPaymentSignature} from '../lib/launch-signatures.ts';
import {validate,units,publicCoin} from '../lib/launch-model.js';
import {fundingRequest,checkedQuote,depositActions,nearAmount,NEAR_ASSET,SOL_ASSET} from '../lib/funding.js';
import {NEAR} from '../lib/solana-rpc.mjs';
const a=Keypair.generate(),m=Keypair.generate(),destination=Keypair.generate();
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5foAAAAASUVORK5CYII=';
const valid={creator:a.publicKey.toBase58(),mint:m.publicKey.toBase58(),name:'NEAR Community',symbol:'nearcoin',description:'A community coin',image,creatorFeeBps:30,devBuyNear:'0.000000001'};
test('launch validates exact NEAR units, every supported fee, UTF-8 and image contents',()=>{
 for(const bps of [30,50,100,200,300]){const p=validate({...valid,creatorFeeBps:bps});assert.equal(p.devBuyRaw,1n);assert.equal(p.symbol,'NEARCOIN');assert.equal(p.creatorFeeBps,bps)}
 assert.equal(units('1000'),1000000000000n);
 for(const devBuyNear of ['-1','1e2','01','0.0000000001','1000.000000001'])assert.throws(()=>validate({...valid,devBuyNear}));
 for(const creatorFeeBps of [0,31,'30',301])assert.throws(()=>validate({...valid,creatorFeeBps}));
 assert.throws(()=>validate({...valid,name:'🌱'.repeat(9)}));assert.throws(()=>validate({...valid,mint:valid.creator}));
 assert.throws(()=>validate({...valid,image:image.replace('image/png','image/jpeg')}));
 assert.throws(()=>validate({...valid,website:'https://user:password@example.com'}));
});
function transaction(extra:TransactionInstruction[]=[],latest={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}){
 const instructions=[new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:a.publicKey,isSigner:true,isWritable:true},{pubkey:m.publicKey,isSigner:true,isWritable:true}],data:Buffer.from('test-only launch binding')}),...extra];
 return compileLaunchV1({payer:a.publicKey,latest,instructions});
}
function sign(tx:ReturnType<typeof transaction>,includeMint=true){const decoded=getTransactionDecoder().decode(tx.serialize());const signatures={...decoded.signatures,[a.publicKey.toBase58()]:ed25519.sign(decoded.messageBytes,a.secretKey.slice(0,32))};if(includeMint)signatures[m.publicKey.toBase58()]=ed25519.sign(decoded.messageBytes,m.secretKey.slice(0,32));return new Uint8Array(getTransactionEncoder().encode({...decoded,signatures}));}
test('v1 launch wire round trips and requires every real signature',()=>{const tx=transaction(),wire=sign(tx);assert.equal(decodeLaunchTransaction(wire).message.version,1);walletSignedLaunchMatches(tx.serialize(),wire);assert.equal(typeof cloutPaymentSignature(wire),'string');assert.throws(()=>walletSignedLaunchMatches(tx.serialize(),sign(tx,false)),/incomplete|invalid/);const bad=new Uint8Array(wire);bad[10]^=1;assert.throws(()=>walletSignedLaunchMatches(tx.serialize(),bad));});
test('wallet may add Lighthouse assertions but cannot change destinations, instructions or blockhash',()=>{
 const original=transaction(),latest={blockhash:original.message.recentBlockhash,lastValidBlockHeight:1000};
 const light=new TransactionInstruction({programId:new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),keys:[],data:Buffer.from([1])});
 walletSignedLaunchMatches(original.serialize(),sign(transaction([light],latest)));
 const transfer=SystemProgram.transfer({fromPubkey:a.publicKey,toPubkey:destination.publicKey,lamports:1});
 assert.throws(()=>walletSignedLaunchMatches(original.serialize(),sign(transaction([transfer],latest))),/altered/);
 assert.throws(()=>walletSignedLaunchMatches(original.serialize(),sign(transaction())),/altered/);
});
const base={asset:'NEAR',amount:'5',recipient:valid.creator,refundTo:'alice.near'};
function response(request:ReturnType<typeof fundingRequest>){return {quoteRequest:structuredClone(request),quote:{amountIn:request.amount,amountOut:'4900000000',minAmountOut:'4851000000',depositAddress:'b'.repeat(64),deadline:request.deadline}}}
test('Intents funding binds exact assets, units, recipients, refund policy and slippage',()=>{
 const request=fundingRequest(base),result=response(request);assert.equal(request.destinationAsset,NEAR_ASSET);assert.equal(fundingRequest({...base,asset:'SOL'}).destinationAsset,SOL_ASSET);assert.equal(nearAmount('1000'),'1000000000000000000000000000');assert.equal(request.amount,'5000000000000000000000000');checkedQuote(result,request);checkedQuote({...result,quote:{...result.quote,amountOut:'4900000001',minAmountOut:'4851000000'}},request);
 for(const field of ['recipient','refundTo','destinationAsset','amount','depositMode']){const changed=structuredClone(result);changed.quoteRequest[field]='tampered';assert.throws(()=>checkedQuote(changed,request));}
 for(const minAmountOut of ['0','4850999999','5000000000'])assert.throws(()=>checkedQuote({...result,quote:{...result.quote,minAmountOut}},request));
 assert.throws(()=>checkedQuote({...result,quote:{...result.quote,deadline:'invalid'}},request));
 assert.throws(()=>checkedQuote({...result,quote:{...result.quote,depositMemo:'unexpected'}},request));
 assert.throws(()=>fundingRequest({...base,asset:'OTHER'}));assert.throws(()=>fundingRequest({...base,amount:'1001'}));assert.throws(()=>fundingRequest({...base,refundTo:'invalid!'}));
});
test('funding registers sender and receiver before wrapping and transfers an exact deposit',()=>{
 assert.throws(()=>depositActions({amount:'1000',wrappedBalance:'400',receiverStorage:null,ownerStorage:null,storageMinimum:'10',owner:'alice.near',receiver:'deposit.near'}),/inconsistent/);
});
test('funding uses existing wrapped funds and never underfunds storage or one-yocto authorization',()=>{
 const p=depositActions({amount:'1000',wrappedBalance:'400',receiverStorage:null,ownerStorage:{total:'10'},storageMinimum:'10',owner:'alice.near',receiver:'deposit.near'});
 assert.deepEqual(p.actions,[{methodName:'storage_deposit',args:{account_id:'deposit.near',registration_only:true},deposit:'10'},{methodName:'near_deposit',args:{},deposit:'600'}]);assert.equal(p.nearRequired,'611');
 const fresh=depositActions({amount:'1000',wrappedBalance:'0',receiverStorage:null,ownerStorage:null,storageMinimum:'10',owner:'alice.near',receiver:'deposit.near'});assert.equal(fresh.nearRequired,'1021');assert.deepEqual(fresh.actions.slice(0,2).map(a=>a.args.account_id),['alice.near','deposit.near']);
 const funded=depositActions({amount:'1000',wrappedBalance:'1200',receiverStorage:{},ownerStorage:{},storageMinimum:'10',owner:'alice.near',receiver:'deposit.near'});assert.equal(funded.nearRequired,'1');assert.deepEqual(funded.actions,[]);
});
test('public launch records expose metadata and receipts, never signed wires or signing keys',()=>{const result=publicCoin({...valid,mint:valid.mint,imageUrl:'https://example.com/image',quoteMint:NEAR,signature:'receipt',wire:'PRIVATE',privateKey:'PRIVATE'});assert.equal(result.quoteSymbol,'NEAR');assert.equal(result.quoteMint,NEAR);assert.equal(result.status,'live');assert.ok(!('wire' in result));assert.ok(!('privateKey' in result));assert.equal(result.image,'https://example.com/image');});
