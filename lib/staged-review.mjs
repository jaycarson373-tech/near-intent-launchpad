import {walletSignedLaunchMatches,cloutPaymentSignature} from "./launch-signatures.mjs";
import {MAX_LAUNCH_BASE64} from "./launch-wire.mjs";
const hasSigned = saved => !!(saved.signed || saved.signature || saved.bundleSigned?.length);
function confirmedPhase(saved, receipt) {
  const review = saved.review;
  if (receipt.status !== 'phase-confirmed' || receipt.launchId !== review?.launchId || receipt.phase !== review?.phase || typeof receipt.signature !== 'string' || !receipt.signature)
    throw Error('The phase receipt does not match this launch. Resume its original signature.');
  if (receipt.coin && receipt.coin.mint !== saved.publicKey) throw Error('The phase receipt names another mint. Keep the original launch and retry.');
  return review;
}
export function phaseReceipt(saved, receipt) {
  const review = confirmedPhase(saved, receipt);
  const next = {...saved, launchId: review.launchId,
    completedPhases: [...new Set([...(saved.completedPhases || []), receipt.phase])],
    coin: receipt.coin || saved.coin};
  delete next.signed;
  delete next.bundleSigned;
  delete next.signature;
  return next;
}
export function stagedContinuation(saved, owner) {
  const review = saved.review;
  if (!review) throw Error('Reconnect the original wallet to resume this launch.');
  if (saved.creator !== owner || review.creator !== owner || review.mint !== saved.publicKey || !(saved.launchId || review.launchId))
    throw Error('Reconnect the original wallet to resume this launch.');
  if (hasSigned(saved)) throw Error('Resume the original signed phase before refreshing.');
  return {flow:'staged-v1',launchId:saved.launchId || saved.review.launchId,previousId:saved.review.id,creator:owner,mint:saved.publicKey,feeAllocationVersion:2};
}
export function finishableBuy(saved) {
  return !!saved.coin && saved.completedPhases?.includes('create') === true && !hasSigned(saved);
}
function canonicalPhase(saved, receipt, expectedStatus) {
  const review = saved.review;
  if (receipt.status !== expectedStatus || review?.flow !== 'staged-v1' || receipt.id !== review.id || receipt.launchId !== review.launchId || receipt.phase !== review.phase)
    throw Error('The canonical signed receipt belongs to another phase. Keep the original recovery and retry.');
  if (saved.launchId !== review.launchId || saved.creator !== review.creator || saved.publicKey !== review.mint)
    throw Error('The saved launch identity changed. Reconnect its original wallet to recover.');
  return review;
}
export function canonicalSignedReceipt(saved, receipt) {
  const review = canonicalPhase(saved, receipt, 'canonical-signed');
  if (typeof review.wire !== 'string') throw Error('The original phase review is unavailable. Restore its recovery record before resuming.');
  if (typeof receipt.wire !== 'string' || receipt.wire.length > MAX_LAUNCH_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.wire))
    throw Error('The canonical signed bytes are unavailable or malformed. Keep the original recovery and retry.');
  const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
  const signed = decode(receipt.wire);
  walletSignedLaunchMatches(decode(review.wire), signed);
  const signature = cloutPaymentSignature(signed);
  if (signature !== receipt.signature) throw Error('The canonical signature does not match its signed bytes. Keep the original recovery and retry.');
  const next = {...saved, signed, signature};
  delete next.bundleSigned;
  return next;
}
export function validateCanonicalRequired(saved, receipt) {
  canonicalPhase(saved, receipt, 'canonical-required');
  if (!saved.signed?.length || !saved.signature || saved.bundleSigned?.length)
    throw Error('The original signed phase is unavailable. Restore its local recovery before resuming.');
}
