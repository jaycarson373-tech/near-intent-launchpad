export const INTENT_MINT: string;
export const FEE_ALLOCATION_VERSION: 2;
export function feeBeneficiaries(mint: string, raw: string | bigint, version?: number): {mint: string; raw: string}[];
