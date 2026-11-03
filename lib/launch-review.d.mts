export function unsignedReviewDetails<T>(
  saved:
    | {
        creator: string;
        publicKey: string;
        review?: { creator: string; mint: string };
        details: T;
        signed?: Uint8Array;
        signature?: string;
        bundleSigned?: Uint8Array[];
      }
    | undefined,
  owner: string,
): T;
