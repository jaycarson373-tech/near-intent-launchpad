import { getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { decodeLaunchTransaction } from './launch-wire.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
export function signedCloutMatches(reviewed, signed) {
    const a = getTransactionDecoder().decode(reviewed), b = getTransactionDecoder().decode(signed);
    if (a.messageBytes.length !== b.messageBytes.length ||
        !a.messageBytes.every((v, i) => v === b.messageBytes[i]))
        throw Error('Wallet returned an altered transaction. Nothing was submitted.');
    verifyAllSignatures(signed);
}
// Phantom signs first (so it can simulate without a pre-signed warning) and then
// appends Lighthouse assertion instructions and may retune compute budget.
const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
function launchEffects(wire) {
    const message = decodeLaunchTransaction(wire).message;
    // Reviewed bundle transactions read fixed accounts through one frozen lookup table. Lookup
    // accounts are compared by (table, index), so the wallet may add static keys for its own
    // assertions but cannot add a table, change an index or move a reviewed account.
    const lookups = (message.addressTableLookups || []).map((l) => ({
        table: l.accountKey.toBase58(),
        writable: [...l.writableIndexes],
        readonly: [...l.readonlyIndexes],
    }));
    const keys = message.staticAccountKeys, loaded = [
        ...lookups.flatMap((l) => l.writable.map((i) => l.table + '#' + i)),
        ...lookups.flatMap((l) => l.readonly.map((i) => l.table + '#' + i)),
    ];
    const keyAt = (i) => {
        const key = i < keys.length ? keys[i].toBase58() : loaded[i - keys.length];
        if (!key)
            throw Error('Wallet returned an altered transaction. Nothing was submitted.');
        return key;
    };
    const instructions = message.compiledInstructions.map((ix) => ({
        program: keyAt(ix.programIdIndex),
        accounts: ix.accountKeyIndexes.map((i) => ({
            key: keyAt(i),
            signer: message.isAccountSigner(i),
            writable: message.isAccountWritable(i),
        })),
        data: bs58.encode(ix.data),
    }));
    return {
        blockhash: message.recentBlockhash,
        lookups: JSON.stringify(lookups),
        signers: keys
            .slice(0, message.header.numRequiredSignatures)
            .map((k) => k.toBase58()),
        instructions: instructions.filter((ix) => ix.program !== COMPUTE_BUDGET_PROGRAM),
    };
}
function sameInstruction(a, b) {
    return (a.program === b.program &&
        a.data === b.data &&
        a.accounts.length === b.accounts.length &&
        a.accounts.every((acc, i) => acc.key === b.accounts[i].key &&
            acc.signer === b.accounts[i].signer &&
            (!acc.writable || b.accounts[i].writable)));
}
/**
 * Accepts a wallet-signed launch whose message differs from the review only by
 * Lighthouse assertions and compute-budget settings. Fee payer, signers,
 * blockhash, lookup tables and every reviewed instruction must be unchanged and in order.
 */
export function walletSignedLaunchMatches(reviewed, signed) {
    const a = launchEffects(reviewed), b = launchEffects(signed);
    const kept = b.instructions.filter((ix) => ix.program !== LIGHTHOUSE_PROGRAM);
    if (a.lookups !== b.lookups)
        throw Error('Wallet changed the reviewed address lookup tables. Nothing was submitted.');
    if (a.blockhash !== b.blockhash ||
        a.signers.join() !== b.signers.join() ||
        kept.length !== a.instructions.length ||
        kept.some((ix, i) => !sameInstruction(a.instructions[i], ix)))
        throw Error('Wallet returned an altered transaction. Nothing was submitted.');
    verifyAllSignatures(signed);
}
function verifyAllSignatures(signed) {
    const b = getTransactionDecoder().decode(signed);
    const tx = decodeLaunchTransaction(signed), keys = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (keys.some((key, i) => !tx.signatures[i] ||
        !ed25519.verify(tx.signatures[i], new Uint8Array(b.messageBytes), key.toBytes())))
        throw Error('Wallet returned an incomplete or invalid signature. Nothing was submitted.');
}
export function mintPartialSign(wire, seed) {
    const transaction = getTransactionDecoder().decode(wire), key = bs58.encode(ed25519.getPublicKey(seed));
    if (!(key in transaction.signatures))
        throw Error('The generated mint is not a signer in this review.');
    const signature = ed25519.sign(new Uint8Array(transaction.messageBytes), seed);
    return new Uint8Array(getTransactionEncoder().encode({
        ...transaction,
        signatures: { ...transaction.signatures, [key]: signature },
    }));
}
export function cloutPaymentSignature(wire) {
    const decoded = getTransactionDecoder().decode(wire), tx = decodeLaunchTransaction(wire), payer = tx.message.staticAccountKeys[0];
    const sig = tx.signatures[0];
    if (!sig ||
        !ed25519.verify(sig, new Uint8Array(decoded.messageBytes), payer.toBytes()))
        throw Error('The fee payer has not signed this transaction.');
    return bs58.encode(sig);
}
