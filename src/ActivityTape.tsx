import type { Pulse } from "./use-pulse";
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { type Coin } from "./use-solana-launch";
import { IntentMark, Icon } from "./icons";
import { coinPath } from "./navigation";
function nearAmount(raw: string) {
  if (!/^\d+$/.test(raw)) return "—";
  const n = BigInt(raw),
    whole = n / 1_000_000_000n,
    f = (n % 1_000_000_000n).toString().padStart(9, "0");
  if (n > 0n && n < 100_000n) return "<0.0001";
  return (
    whole.toLocaleString() +
    (f.slice(0, 4).replace(/0+$/, "")
      ? "." + f.slice(0, 4).replace(/0+$/, "")
      : "")
  );
}
export function ActivityTape({
  pulse,
  coins,
  onNavigate,
}: {
  pulse: Pulse | null;
  coins: Coin[];
  onNavigate: (path: string) => void;
}) {
  const [paused, setPaused] = useState(false),
    [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const market = pulse?.market,
    byMint = new Map(coins.map((c) => [c.mint, c]));
  const launches = coins.map((c) => ({
    id: "launch:" + c.signature,
    kind: "launch" as const,
    mint: c.mint,
    signature: c.signature,
    raw: "0",
    at: Date.parse(c.verifiedAt),
    recipients: 0,
  }));
  const events = [...launches, ...(pulse?.activity.events || [])]
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 24);
  const navigate = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      onNavigate(href);
    }
  };
  const cards = events.length ? (
    events.map((e) => {
      const coin = byMint.get(e.mint),
        symbol = coin?.symbol || e.mint.slice(0, 5) + "…";
      return (
        <a
          key={e.id}
          className={"tape-item " + e.kind}
          href={
            e.kind === "launch"
              ? coinPath(e.mint)
              : "https://solscan.io/tx/" + e.signature
          }
          onClick={
            e.kind === "launch"
              ? (event) => navigate(event, coinPath(e.mint))
              : undefined
          }
          target={e.kind === "launch" ? undefined : "_blank"}
          rel={e.kind === "launch" ? undefined : "noreferrer"}
          title={
            new Date(e.at).toLocaleString() +
            " · " +
            (e.kind === "airdrop" ? "wNEAR on Solana · " : "") +
            e.signature
          }
        >
          <Icon
            name={
              e.kind === "launch"
                ? "layers"
                : e.kind === "airdrop"
                  ? "wallet"
                  : "check"
            }
            size={12}
          />
          <strong>
            {e.kind === "launch"
              ? "$" + symbol
              : e.kind === "airdrop"
                ? nearAmount(e.raw) + " NEAR"
                : nearAmount(e.raw) + " NEAR claimed"}
          </strong>
          <span>
            {e.kind === "launch"
              ? "launched"
              : e.kind === "airdrop"
                ? "airdropped · " +
                  (e.recipients || 1) +
                  " holder" +
                  ((e.recipients || 1) === 1 ? "" : "s")
                : "· $" + symbol}
          </span>
        </a>
      );
    })
  ) : (
    <>
      <span className="tape-item tape-empty">
        <span className="tape-square" />
        First launches & confirmed airdrops appear here
      </span>
      <span className="tape-item">
        <strong>100%</strong> for holders
      </span>
      <span className="tape-item">
        <strong>35%</strong> low-volume reserve
      </span>
      <span className="tape-item">
        <strong>15 min</strong> reward cycles
      </span>
    </>
  );
  return (
    <div
      className="activity-tape"
      aria-label="NEAR market and confirmed platform activity"
    >
      <a
        className={
          "near-price " + (market?.status === "delayed" ? "delayed" : "")
        }
        href={market?.url || "https://www.coingecko.com/en/coins/near"}
        target="_blank"
        rel="noreferrer"
        title={
          market
            ? market.source +
              " · " +
              new Date(market.asOf).toLocaleString() +
              " · native NEAR reference price" +
              (market.status === "delayed" ? " · delayed" : "")
            : "NEAR market price is temporarily unavailable"
        }
      >
        <IntentMark />
        <span className="price-symbol">
          NEAR<span>/ USD</span>
        </span>
        <strong>
          {market
            ? "$" +
              market.usd.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 4,
              })
            : "—"}
        </strong>
        {market?.change24h !== null && market?.change24h !== undefined && (
          <span
            title="24-hour change"
            className={
              "price-change " + (market.change24h < 0 ? "negative" : "positive")
            }
          >
            {market.change24h > 0 ? "+" : ""}
            {market.change24h.toFixed(2)}%
          </span>
        )}
        {market?.status === "delayed" && (
          <span className="price-delay">Delayed</span>
        )}
      </a>
      <span className="tape-label">
        {events.length ? "ONCHAIN" : "ACTIVITY"}
      </span>
      <div
        className="tape-window"
        role="region"
        aria-label="Recent confirmed launches and NEAR rewards"
        tabIndex={0}
      >
        <div
          className="tape-track"
          data-paused={paused || hidden}
          style={
            {
              "--tape-duration": Math.max(32, events.length * 6) + "s",
            } as CSSProperties
          }
        >
          <div className="tape-group">{cards}</div>
          <div className="tape-group" aria-hidden="true" inert>
            {cards}
          </div>
        </div>
      </div>
      <button
        className="tape-pause"
        type="button"
        aria-label={paused ? "Resume activity ticker" : "Pause activity ticker"}
        aria-pressed={paused}
        onClick={() => setPaused((v) => !v)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          {paused ? (
            <path d="m5 3 7 5-7 5V3Z" stroke="currentColor" strokeWidth="1.3" />
          ) : (
            <path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2" />
          )}
        </svg>
      </button>
    </div>
  );
}
export function HolderFlow({ pulse }: { pulse: Pulse | null }) {
  const total = pulse?.activity.totalDistributedRaw;
  return (
    <div className="holder-flow">
      <div className="holder-flow-heading">
        <span>
          <span className="flow-glyph" /> 100% OF CREATOR FEES → HOLDERS
        </span>
        <span>15 MIN CYCLE</span>
      </div>
      <div className="holder-flow-numbers">
        <div>
          <strong>
            65<span>%</span>
          </strong>
          <span>Regular airdrops</span>
        </div>
        <div>
          <strong>
            35<span>%</span>
          </strong>
          <span>Holder treasury</span>
        </div>
      </div>
      <div className="holder-flow-meter">
        <span />
        <span />
      </div>
      <div className="holder-flow-footer">
        <span>
          {total !== null && total !== undefined
            ? nearAmount(total) + " NEAR airdropped"
            : "NEAR rewards · onchain receipts"}
        </span>
        <Icon name="shield" size={12} />
      </div>
    </div>
  );
}
