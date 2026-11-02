import { useEffect, useState } from "react";
import { api } from "./use-solana-launch";
import { safeIcon, tokenUnits, type TokenInfo } from "./market-model";
import { Icon } from "./icons";
// Earlier native NEAR share links remain readable; they never enter the Solana launch flow.
export function NativeReceipt({ account }: { account: string }) {
  const [token, setToken] = useState<TokenInfo | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<TokenInfo>(
      "/api/near?action=token&network=mainnet&account=" +
        encodeURIComponent(account),
    )
      .then((t) => {
        if (active) setToken(t);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [account]);
  return (
    <section className="container docs-page">
      <span className="eyebrow">NATIVE NEAR TOKEN · LEGACY SHARE LINK</span>
      <h1>{token?.metadata.name || account}</h1>
      {error ? (
        <p className="inline-status" role="alert">
          {error}
        </p>
      ) : !token ? (
        <p role="status">Reading the NEAR token record…</p>
      ) : (
        <>
          <p className="page-lede">
            ${token.metadata.symbol} ·{" "}
            {tokenUnits(token.supply, token.metadata.decimals)} total supply
          </p>
          {safeIcon(token.metadata.icon) && (
            <img
              src={token.metadata.icon!}
              alt={token.metadata.name}
              width="80"
              height="80"
            />
          )}
          <p className="page-lede">
            This is a native NEAR contract from the previous version. New Intent
            Pad launches are NEAR-paired coins on Solana.
          </p>
          <a
            className="button secondary"
            href={
              "https://nearblocks.io/address/" + encodeURIComponent(account)
            }
            target="_blank"
            rel="noreferrer"
          >
            View NEAR contract <Icon name="arrow" />
          </a>
        </>
      )}
    </section>
  );
}
