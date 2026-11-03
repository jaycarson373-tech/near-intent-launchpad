// Refreshing is allowed only before anything has been signed. Recovery records
// and their original mint must survive every retry.
export function unsignedReviewDetails(saved, owner) {
  if (
    !saved ||
    saved.creator !== owner ||
    saved.review?.creator !== owner ||
    saved.review?.mint !== saved.publicKey
  )
    throw Error("Reconnect the original wallet to refresh this launch review.");
  if (saved.signed || saved.signature || saved.bundleSigned?.length)
    throw Error(
      "This launch already has signed transactions. Resume the original submission instead.",
    );
  if (!saved.details || typeof saved.details !== "object")
    throw Error("The saved coin details could not be restored.");
  return { ...saved.details };
}
