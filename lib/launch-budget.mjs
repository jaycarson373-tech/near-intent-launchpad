import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { fail } from './http.js';

// Keep account creation when missing (including dust-prefunded System accounts).
// An existing ATA can be omitted only after checking its actual token identity.
export async function compactTokenSetup(instructions, rpc) {
  const setup = instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  if (!setup.length) return instructions;
  const infos = await rpc.getMultipleAccountsInfo(setup.map(ix => ix.keys[1].pubkey), 'finalized');
  let index = 0;
  const seen = new Set(), closed = new Set();
  return instructions.filter(ix => {
    if ([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(ix.programId)) && ix.data.length===1 && ix.data[0]===9) {
      const key=ix.keys[0].pubkey.toBase58();closed.add(key);seen.delete(key);return true;
    }
    if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const info = infos[index++], address = ix.keys[1].pubkey;
    // Only the reviewed idempotent ATA setup may be coalesced.
    if (ix.data.length !== 1 || ix.data[0] !== 1) return true;
    if (seen.has(address.toBase58())) return false;
    seen.add(address.toBase58());
    if (closed.has(address.toBase58())) return true;
    if (!info || (info.owner.toBase58() === '11111111111111111111111111111111' && info.data.length === 0)) return true;
    const account = unpackAccount(address, info, ix.keys[5].pubkey);
    if (!account.isInitialized || !account.owner.equals(ix.keys[2].pubkey) || !account.mint.equals(ix.keys[3].pubkey))
      fail('A launch token account has an unexpected owner, mint or state. No payment was requested.');
    return false;
  });
}

// The captured failing Phantom request added 21 Lighthouse checks. Account for
// that measured overhead before requesting any new SOL conversion. Wallet checks
// are still preserved and the exact signed transaction is simulated again.
export const WALLET_INSTRUCTION_ALLOWANCE = 21;
export function assertLaunchTraceBudget(tx, simulation) {
  if (JSON.stringify(simulation.value.err || '').includes('MaxInstructionTraceLengthExceeded'))
    fail('The combined swap and launch exceeds Solana’s instruction limit. No wallet approval was requested and no SOL was swapped.', 503);
  if (simulation.value.err) return;
  if (!Array.isArray(simulation.value.innerInstructions))
    fail('The RPC could not verify the full launch instruction budget. No wallet approval was requested.', 503);
  const executed = tx.message.compiledInstructions.length + simulation.value.innerInstructions.reduce((n, row) => n + row.instructions.length, 0);
  if (executed + WALLET_INSTRUCTION_ALLOWANCE > 64)
    fail('This launch does not leave enough instruction capacity for wallet security checks. No wallet approval was requested and no SOL was swapped.', 503);
}

export function blockedLaunchResult(draft, signature, error) {
  return { status: 'blocked', signature, mint: draft.mint, error };
}
