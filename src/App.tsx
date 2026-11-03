import {INTENT_MINT} from "../lib/fee-allocation.mjs";
import {CurveProgress,type CurveState} from "./CurveProgress";
import {ActivityTape,HolderFlow} from './ActivityTape';
import {usePulse} from './use-pulse';
import { useEffect, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import {
  useSolanaLaunch,
  api,
  EMPTY_COIN,
  type Coin,
  type CoinDraft,
} from "./use-solana-launch";
import { useRoute, coinPath } from "./navigation";
import { Icon, IntentMark, IntentMesh } from "./icons";
import { price, safeIcon } from "./market-model";
import { Funding } from "./Funding";
import { Modal } from "./Modal";
import { NativeReceipt } from "./NativeReceipt";
import "./App.css";
const DRAFT_KEY = "intent-pad-solana-editor.v1",
  INTENT_CA = INTENT_MINT,
  YEAR = new Date().getFullYear();
const atoms = (raw: string, dec = 9) => {
  if (!/^\d+$/.test(raw)) return "—";
  const n = BigInt(raw),
    s = 10n ** BigInt(dec),
    f = (n % s).toString().padStart(dec, "0").replace(/0+$/, "");
  return (n / s).toString() + (f ? "." + f : "");
};
const short = (s: string) => s.slice(0, 6) + "…" + s.slice(-5);
function initialDraft(): CoinDraft {
  try {
    return {
      ...EMPTY_COIN,
      ...JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"),
    };
  } catch {
    return EMPTY_COIN;
  }
}
function CoinArt({
  coin,
  large = false,
}: {
  coin: Pick<Coin, "name" | "symbol" | "image">;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={large ? "token-icon large" : "token-icon"}>
      {safeIcon(coin.image) && !failed ? (
        <img
          src={coin.image}
          alt={coin.name + " logo"}
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{coin.symbol.slice(0, 3) || <IntentMark />}</span>
      )}
    </span>
  );
}
function Address({
  value,
  label,
  onCopy,
}: {
  value: string;
  label: string;
  onCopy: (s: string) => void;
}) {
  return (
    <button
      className="copy-address"
      title={value}
      aria-label={"Copy " + label}
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .then(() => onCopy("Address copied."))
          .catch(() => onCopy("Copy this address: " + value))
      }
    >
      <code>{value}</code>
      <Icon name="copy" size={15} />
    </button>
  );
}
function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name="layers" size={24} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export default function App() {
  const pulse = usePulse();
  const launch = useSolanaLaunch(),
    { route, navigate } = useRoute(),
    [draft, setDraft] = useState<CoinDraft>(initialDraft),
    [coins, setCoins] = useState<Coin[]>([]),
    [loading, setLoading] = useState(true),
    [feedError, setFeedError] = useState(""),
    [query, setQuery] = useState(""),
    [menu, setMenu] = useState(false),
    [notice, setNotice] = useState(""),
    [funding, setFunding] = useState(false),
    [imageBusy, setImageBusy] = useState(false),
    [now, setNow] = useState(() => Date.now());
  function load() {
    void api<{ coins: Coin[] }>("/api/coins")
      .then((d) => {
        setCoins(d.coins);
        setFeedError("");
      })
      .catch((e) => setFeedError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 20000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!launch.review) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [launch.review]);
  useEffect(() => {
    document.title =
      route.page === "home"
        ? "Intent Pad — The NEAR-Paired Solana Launchpad"
        : route.page === "coin"
          ? "Coin · Intent Pad"
          : route.page[0].toUpperCase() + route.page.slice(1) + " · Intent Pad";
  }, [route.page]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  const go = (path: string) => {
    navigate(path);
    setMenu(false);
  };
  const link = (e: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      go(path);
    }
  };
  const change = (patch: Partial<CoinDraft>) =>
    setDraft((old) => {
      const next = { ...old, ...patch };
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  const list = coins.filter(
    (c) =>
      (route.page !== "dashboard" || c.creator === launch.account) &&
      [c.name, c.symbol, c.mint]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const onConfirmed = (coin: Coin | undefined) => {
    if (coin) {
      setCoins((old) => [coin, ...old.filter((c) => c.mint !== coin.mint)]);
      go(coinPath(coin.mint));
    }
  };
  useEffect(() => {
    if (launch.confirmedCoin) navigate(coinPath(launch.confirmedCoin.mint));
  }, [launch.confirmedCoin, navigate]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void launch.prepare(draft);
  };
  async function chooseImage(file?: File) {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 1500000
    ) {
      setNotice("Choose a PNG, JPEG or WebP under 1.5 MB.");
      return;
    }
    setImageBusy(true);
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(Error("Image could not be read."));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      change({ image });
    } catch {
      setNotice("The image could not be read. Choose it again.");
    } finally {
      setImageBusy(false);
    }
  }
  const gallery = () => (
    <>
      {loading && !coins.length ? (
        <div className="coin-grid" role="status" aria-label="Loading launches">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton coin-skeleton" />
          ))}
        </div>
      ) : feedError && !coins.length ? (
        <Empty
          title="Launches are temporarily unavailable."
          action={
            <button className="button secondary" onClick={load}>
              Retry <Icon name="refresh" />
            </button>
          }
        >
          {feedError}
        </Empty>
      ) : list.length ? (
        <div className="coin-grid">
          {list.map((c) => (
            <a
              key={c.mint}
              className="coin-card"
              href={coinPath(c.mint)}
              onClick={(e) => link(e, coinPath(c.mint))}
            >
              <div className="coin-art">
                <CoinArt coin={c} />
                <span className="card-network">NEAR PAIR · SOLANA</span>
              </div>
              <div className="coin-content">
                <span className="eyebrow">${c.symbol}</span>
                <h3>{c.name}</h3>
                <p className="coin-description">
                  {c.description || "A NEAR-paired community coin."}
                </p>
                <div className="card-footer">
                  <span className="status-dot">
                    {c.creatorFeeBps / 100}% creator fee
                  </span>
                  <Icon name="arrow" size={16} />
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <Empty
          title={
            route.page === "dashboard" && !launch.account
              ? "Your coins. Your workspace."
              : query
                ? "No matching coins."
                : "The next launch could be yours."
          }
          action={
            <button
              className="button primary"
              onClick={() =>
                route.page === "dashboard" && !launch.account
                  ? void launch.connect()
                  : go("/launch")
              }
            >
              {route.page === "dashboard" && !launch.account
                ? "Connect Solana wallet"
                : "Launch a coin"}
              <Icon name="arrow" />
            </button>
          }
        >
          {route.page === "dashboard" && !launch.account
            ? "Connect the wallet you launch with to see your confirmed coins."
            : query
              ? "Try a different name, ticker or mint."
              : "NEAR-paired coins appear here after finalized Pump.fun creation. Launch yours to start the next community."}
        </Empty>
      )}
    </>
  );
  return (
    <div className="site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <div className="header-inner">
          <a className="brand" href="/" onClick={(e) => link(e, "/")}>
            <img className="intent-brand-logo" src="/intent-logo.png" width="34" height="34" alt=""/>
            <span>
              Intent<span className="brand-light">Pad</span>
            </span>
          </a>
          <nav
            className={menu ? "nav open" : "nav"}
            aria-label="Main navigation"
          >
            {[
              ["/explore", "Explore"],
              ["/dashboard", "My launches"],
              ["/docs", "How it works"],
            ].map(([path, label]) => (
              <a
                key={path}
                className={route.page === path.slice(1) ? "active" : ""}
                href={path}
                onClick={(e) => link(e, path)}
              >
                {label}
              </a>
            ))}
          </nav>
          <button className="header-ca" title={INTENT_CA} aria-label="Copy Intent Pad contract address" onClick={()=>void navigator.clipboard.writeText(INTENT_CA).then(()=>setNotice("Contract address copied.")).catch(()=>setNotice(INTENT_CA))}><span>CA</span><code>{INTENT_CA}</code><Icon name="copy" size={13}/></button>
          <div className="header-actions">
            <a className="icon-button header-x" href="https://x.com/IntentPad" target="_blank" rel="noreferrer" aria-label="Intent Pad on X"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l8.2-9.4L.8 2h6.5l5.9 7.8L18.9 2Zm-1.1 18h1.7L6.4 3.9H4.6L17.8 20Z"/></svg></a>
            <button
              className="button secondary wallet-button"
              onClick={() => void launch.connect()}
            >
              <Icon name="wallet" />
              {launch.account ? short(launch.account) : "Connect wallet"}
            </button>
            <a
              className="button primary header-launch"
              href="/launch"
              onClick={(e) => link(e, "/launch")}
            >
              Launch a coin <Icon name="arrow" />
            </a>
            <button
              className="icon-button menu-button"
              aria-label={menu ? "Close navigation" : "Open navigation"}
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              <Icon name={menu ? "close" : "menu"} />
            </button>
          </div>
        </div>
        <ActivityTape pulse={pulse} coins={coins} onNavigate={go}/>
      </header>
      <main id="main">
        {route.page === "home" && (
          <>
            <section className="hero container">
              <div className="hero-copy">
                <span className="eyebrow hero-eyebrow">
                  <span className="status-dot" /> NEAR POWERED. SOLANA NATIVE.
                </span>
                <h1>
                  Solana’s dedicated
                  <br />
                  <span>NEAR launchpad.</span>
                </h1>
                <p>
                  Launch a coin paired with NEAR.
                  <br />
                  Buy with SOL. Approve with your Solana wallet.
                </p>
                <div className="hero-actions">
                  <a
                    className="button primary"
                    href="/launch"
                    onClick={(e) => link(e, "/launch")}
                  >
                    Launch a coin <Icon name="arrow" />
                  </a>
                  <a
                    className="button secondary"
                    href="/explore"
                    onClick={(e) => link(e, "/explore")}
                  >
                    Explore coins <Icon name="arrow" />
                  </a>
                </div>
                <div className="hero-proof">
                  <span>
                    <Icon name="shield" size={14} /> Wallet-approved creation
                  </span>
                  <span>
                    <Icon name="layers" size={14} /> Powered by Pump.fun
                  </span>
                </div>
              </div>
              <div className="hero-visual">
                <IntentMesh />
                <HolderFlow pulse={pulse}/>
                <div className="mesh-caption">
                  <span className="status-dot" /> NEAR / SOLANA
                  <span>ONE CONNECTED LAUNCH</span>
                </div>
              </div>
            </section>
            <section className="directory-section container">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">
                    THE NEXT COMMUNITY STARTS HERE
                  </span>
                  <h2>
                    Recent launches<span className="open-label">ONCHAIN</span>
                  </h2>
                </div>
                <a
                  className="text-link"
                  href="/explore"
                  onClick={(e) => link(e, "/explore")}
                >
                  View all <Icon name="arrow" size={16} />
                </a>
              </div>
              {gallery()}
            </section>
            <section className="steps container">
              <div>
                <span className="eyebrow">FROM NEAR TO YOUR NEXT COIN</span>
                <h2>A straightforward launch.</h2>
              </div>
              <div className="step-grid">
                {[
                  [
                    "01",
                    "Buy with SOL.",
                    "Enter your initial buy in SOL. The combined swap and launch are checked before a wallet approval. Keep SOL for rent and gas.",
                  ],
                  [
                    "02",
                    "Make it yours.",
                    "Set your name, ticker and creator fee. Review the simulated creation and optional SOL buy.",
                  ],
                  [
                    "03",
                    "Launch. Then share.",
                    "Approve in your Solana wallet. Your coin gets a public page and a finalized launch receipt.",
                  ],
                ].map(([n, title, body]) => (
                  <article key={n}>
                    <span>{n}</span>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
        {(route.page === "explore" || route.page === "dashboard") && (
          <section className="container page-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">
                  {route.page === "dashboard"
                    ? "YOUR WORKSPACE"
                    : "NEAR-PAIRED. SOLANA-SETTLED."}
                </span>
                <h1>
                  {route.page === "dashboard" ? "My launches" : "Explore coins"}
                </h1>
                <p className="page-lede">
                  {route.page === "dashboard"
                    ? "Recent confirmed launches from your connected Solana wallet."
                    : "Discover NEAR-paired coins and their onchain launch records."}
                </p>
              </div>
              <button className="button primary" onClick={() => go("/launch")}>
                Launch a coin <Icon name="arrow" />
              </button>
            </div>
            <div className="directory-toolbar">
              <label className="search">
                <Icon name="search" />
                <input
                  type="search"
                  aria-label="Search coins"
                  placeholder="Search name, ticker or mint"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <button
                className="icon-button"
                aria-label="Refresh launches"
                disabled={loading}
                onClick={load}
              >
                <Icon name="refresh" />
              </button>
            </div>
            {gallery()}
          </section>
        )}
        {route.page === "launch" && (
          <section className="container launch-page">
            <div className="launch-intro">
              <span className="eyebrow">YOUR NEXT COMMUNITY STARTS HERE</span>
              <h1>Launch a coin.</h1>
              <p>
                Paired with NEAR. Created on Solana.
                <br />
                Reviewed by you before your wallet signs.
              </p>
              <div className="launch-steps">
                <span className={!launch.review ? "active" : ""}>
                  01 · Configure
                </span>
                <span
                  className={launch.review && !launch.signature ? "active" : ""}
                >
                  02 · Review & approve
                </span>
                <span className={launch.signature ? "active" : ""}>
                  03 · Confirm
                </span>
              </div>
              <div className="draft-preview">
                <div className="coin-art">
                  <CoinArt
                    coin={{
                      name: draft.name || "Your coin",
                      symbol: draft.symbol || "COIN",
                      image: draft.image,
                    }}
                  />
                  <span className="card-network">NEAR PAIR · SOLANA</span>
                </div>
                <div className="coin-content">
                  <span className="eyebrow">
                    {draft.symbol ? "$" + draft.symbol : "YOUR COIN"}
                  </span>
                  <h3>{draft.name || "Make it yours."}</h3>
                  <p>{draft.description || "A new coin. A new community."}</p>
                  <div className="card-footer">
                    <span>{draft.creatorFeeBps / 100}% creator fee</span>
                    <Icon name="arrow" size={16} />
                  </div>
                </div>
              </div>
              <p className="small-note">
                SOL initial buys are reviewed with your launch. Optional
                Intents funding is separate.
              </p>
            </div>
            <div className="launch-form panel">
              <div className="form-heading">
                <h2>
                  {launch.signature
                    ? "Your launch receipt"
                    : launch.review
                      ? "Review your launch"
                      : "Coin details"}
                </h2>
                <span className="network-label">
                  <span className="status-dot" />
                  Solana mainnet
                </span>
              </div>
              {!launch.review ? (
                <form onSubmit={submit}>
                  <fieldset disabled={launch.busy} className="form-fieldset">
                    <div className="form-grid">
                      <label>
                        Coin name
                        <input
                          required
                          maxLength={32}
                          value={draft.name}
                          onChange={(e) => change({ name: e.target.value })}
                          placeholder="Give your coin a name"
                        />
                      </label>
                      <label>
                        Ticker
                        <input
                          required
                          maxLength={10}
                          pattern="[A-Za-z0-9]{1,10}"
                          value={draft.symbol}
                          onChange={(e) =>
                            change({ symbol: e.target.value.toUpperCase() })
                          }
                          placeholder="COIN"
                        />
                      </label>
                      <label className="wide">
                        Description
                        <textarea
                          required
                          maxLength={1000}
                          rows={3}
                          placeholder="What’s your community about?"
                          value={draft.description}
                          onChange={(e) =>
                            change({ description: e.target.value })
                          }
                        />
                      </label>
                      <label className="wide image-upload">
                        Coin image
                        <input
                          required={!draft.image}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) =>
                            void chooseImage(e.target.files?.[0])
                          }
                        />
                        <small>
                          {imageBusy
                            ? "Reading image…"
                            : "PNG, JPEG or WebP · up to 1.5 MB"}
                        </small>
                      </label>
                      <label>
                        Website <span className="optional">(optional)</span>
                        <input
                          type="url"
                          pattern="https://.*"
                          maxLength={250}
                          placeholder="https://"
                          value={draft.website}
                          onChange={(e) => change({ website: e.target.value })}
                        />
                      </label>
                      <label>
                        X <span className="optional">(optional)</span>
                        <input
                          type="url"
                          pattern="https://.*"
                          maxLength={250}
                          placeholder="https://x.com/"
                          value={draft.twitter}
                          onChange={(e) => change({ twitter: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="pair-field">
                      <span>Trading pair</span>
                      <strong>
                        <IntentMark /> Your coin / NEAR
                      </strong>
                      <small>Wrapped NEAR on Solana · Pump.fun</small>
                    </div>
                    <fieldset className="fee-field">
                      <legend>Creator fee</legend>
                      <div className="fee-buttons">
                        {[30, 50, 100, 200, 300].map((bps) => (
                          <button
                            key={bps}
                            type="button"
                            className="button secondary"
                            aria-pressed={draft.creatorFeeBps === bps}
                            onClick={() => change({ creatorFeeBps: bps })}
                          >
                            {bps / 100}%
                          </button>
                        ))}
                      </div>
                      <small>
                        Fixed at launch. Pump’s protocol fee is separate.
                        80% funds this coin’s holder airdrops. 20% funds INTENT holder airdrops.
                      </small>
                    </fieldset>
                    <div className="funding-strip">
                      <div>
                        <span>YOUR SOLANA WALLET</span>
                        <strong>
                          {launch.account
                            ? short(launch.account)
                            : "Connect to view balances"}
                        </strong>
                        {launch.balance && (
                          <small>
                            {atoms(launch.balance.nearRaw)} wNEAR ·{" "}
                            {atoms(launch.balance.solRaw)} SOL
                          </small>
                        )}
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() =>
                          launch.account
                            ? setFunding(true)
                            : void launch.connect()
                        }
                      >
                        Fund with Intents <Icon name="arrow" size={15} />
                      </button>
                    </div>
                    <label className="dev-buy">
                      Initial buy in SOL{" "}
                      <span className="optional">(optional)</span>
                      <input
                        type="number"
                        required
                        min="0"
                        max="100"
                        step="0.000000001"
                        value={draft.devBuySol}
                        onChange={(e) => change({ devBuySol: e.target.value })}
                      />
                      <small>
                        0 skips the buy. Purchased coins go to your Solana
                        wallet. Review the complete launch bundle together. Account rent, network fees and the disclosed relay tip are extra.
                      </small>
                    </label>
                    <button
                      className="button primary full"
                      disabled={
                        launch.busy ||
                        imageBusy ||
                        (!!launch.account && launch.health?.ready === false)
                      }
                      type="submit"
                    >
                      {launch.busy
                        ? "Checking launch…"
                        : launch.account
                          ? "Review launch"
                          : "Connect Solana wallet"}
                      <Icon name={launch.account ? "arrow" : "wallet"} />
                    </button>
                    {launch.health?.ready === false && (
                      <p className="inline-status">
                        Launch service unavailable:{" "}
                        {launch.health.missing.join(", ")}. Retry before a
                        wallet approval.
                        <button type="button" className="text-link health-retry" disabled={launch.healthChecking || launch.busy} onClick={()=>void launch.refreshHealth()}>{launch.healthChecking?"Checking availability…":"Retry launch check"} <Icon name="refresh" size={14}/></button>
                      </p>
                    )}
                  </fieldset>
                </form>
              ) : (
                <div className="deployment-review">
                  <dl>
                    {[
                      [
                        "Coin",
                        launch.review.name + " ($" + launch.review.symbol + ")",
                      ],
                      ["Paired with", "NEAR on Solana"],
                      ["Creator-fee rewards",launch.review.feeAllocationVersion===2?(launch.review.mint===INTENT_MINT?"100% to INTENT holders":"80% coin holders · 20% INTENT holders"):"Original holder-reward allocation"],
                      ["Creator fee", launch.review.creatorFeeBps / 100 + "%"],
                      [launch.review.feeTreasury?"Reward treasury":"Original fee recipient", launch.review.feeTreasury||launch.review.creator],
                      ["Initial buy", launch.review.devBuySolRaw!==undefined?atoms(launch.review.devBuySolRaw)+" SOL"+(launch.review.fundingId?" · converted":""):atoms(launch.review.devBuyRaw)+" NEAR · saved review"],
                      ["Approval",launch.review.bundle?`One launch bundle · ${launch.review.wires?.length} transactions`:launch.review.atomicSolBuy?"SOL buy & launch":launch.review.phase==="conversion"?"Saved SOL conversion":"Coin creation & initial buy"],
                      ...(launch.review.tipLamports?[["Relay tip",atoms(launch.review.tipLamports)+" SOL · included in total"]]:[]),
                      [
                        "Estimated SOL debit",
                        atoms(launch.review.estimatedSolRaw) + " SOL",
                      ],
                      ["Token mint", launch.review.mint],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {launch.signature ? (
                    <>
                      <div className="transaction-status">
                        <span className="status-dot" />
                        {launch.stage === "failed"
                          ? "Transaction failed"
                          : launch.stage === "blocked"
                            ? "Submission blocked"
                          : launch.stage === "partial"
                            ? "Launch partly landed"
                          : launch.stage === "review" || launch.stage === "expired"
                            ? "Launch expired"
                            : "Tracking original launch"}
                      </div>
                      <a
                        className="text-link"
                        href={"https://solscan.io/tx/" + launch.signature}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View transaction <Icon name="arrow" size={15} />
                      </a>
                      <button
                        className="button primary full"
                        disabled={launch.busy}
                        onClick={() => void launch.check().then(onConfirmed)}
                      >
                        Check confirmation <Icon name="refresh" size={15} />
                      </button>
                      {launch.ended ? (
                        <button
                          className="button secondary full"
                          disabled={launch.busy}
                          onClick={launch.edit}
                        >
                          Start a new launch
                        </button>
                      ) : (
                        <button
                          className="button secondary full"
                          disabled={launch.busy}
                          onClick={() => void launch.approve().then(onConfirmed)}
                        >
                          Resume original submission
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="funding-note">
                        <Icon name="shield" />
                        <p>
                          {launch.review.bundle?'Approve all '+(launch.review.wires?.length||3)+' transactions at once: account setup, coin creation, then fee lock with your initial buy. Sent only as one Jito bundle.':launch.review.atomicSolBuy?'This transaction converts SOL, creates your coin and makes the initial buy. Network fees can apply.':launch.review.phase==='conversion'?'This saved review converts SOL to NEAR. Coin creation requires a separate approval. Converted NEAR stays in your wallet if you stop.':'This transaction creates your coin and locks its reviewed fee recipient. Your wallet shows the initial buy, if set, plus rent and network fees.'}
                        </p>
                      </div>
                      <button
                        className="button primary full"
                        disabled={launch.busy}
                        onClick={() => now >= launch.review!.expiresAt ? void launch.refreshReview() : void launch.approve().then(onConfirmed)}
                      >
                        {launch.busy
                          ? "Waiting for wallet…"
                          : now >= launch.review.expiresAt
                            ? "Refresh launch review"
                            : launch.review.bundle?"Approve launch bundle":launch.review.atomicSolBuy?"Approve SOL buy & launch":launch.review.phase==="conversion"?"Approve saved conversion":"Approve coin creation"}
                        <Icon name="wallet" />
                      </button>
                      <p className="review-expiry" role="status">{now >= launch.review.expiresAt ? "This unsigned review expired. Refresh it to keep the same coin details and mint, then review the updated costs." : `Review valid for ${Math.max(0,Math.ceil((launch.review.expiresAt-now)/1000))} seconds. Wallet approval is still required.`}</p>
                      <button
                        className="button secondary full"
                        disabled={launch.busy}
                        onClick={launch.edit}
                      >
                        Edit coin details
                      </button>
                    </>
                  )}
                </div>
              )}
              {launch.message && (
                <p className="inline-status" role="status">
                  {launch.message}
                </p>
              )}
              <div className="verification-caption">
                <Icon name="shield" size={14} /> Wallet-approved.
                Onchain-verified.
              </div>
            </div>
          </section>
        )}
        {route.page === "native" && (
          <NativeReceipt key={route.account} account={route.account || ""} />
        )}
        {route.page === "coin" && (
          <CoinPage
            key={route.account}
            mint={route.account || ""}
            copy={setNotice}
            back={() => go("/explore")}
          />
        )}
        {route.page === "docs" && (
          <section className="container docs-page">
            <span className="eyebrow">NEAR FUNDING. SOLANA EXECUTION.</span>
            <h1>Know your launch.</h1>
            <p className="page-lede">
              A NEAR-paired coin, with a transaction you approve.
            </p>
            <div className="faq">
              {[
                [
                  "Which chain does my coin launch on?",
                  "Solana mainnet, through Pump.fun. Its trading pair uses the verified wrapped NEAR mint on Solana, not a native NEAR token contract.",
                ],
                [
                  "Can I still fund through Intents?",
                  "Connect your Solana wallet, then open Fund with Intents. Connect the NEAR account used for refunds, choose SOL to fund the initial buy, rent and gas, and review the exact Intents quote. The deposit and the launch are separate approvals.",
                ],
                [
                  "Where do creator fees go?",
                  "100% of INTENT creator fees funds INTENT holder airdrops. For new coins launched on Intent Pad, 80% funds that coin’s holders and 20% funds INTENT holders. Claims are checked every 15 minutes. Pump’s protocol fee is separate. Existing launches keep their recorded allocation. INTENT payouts wait for a verified live mint and complete holder snapshot.",
                ],
                [
                  "What happens if confirmation is delayed?",
                  "The mint key and reviewed draft are saved to your wallet’s browser recovery record. The server durably saves the exact fully signed transaction before broadcasting. Resume checks the original signature, rather than requesting another payment. Keep this browser and the original launching wallet available.",
                ],
                [
                  "When does my coin appear?",
                  "After the launch finalizes and the server verifies the exact approved transaction, token mint and immutable creator-fee assignment. The public directory and coin page use confirmed records. Market charts appear only once a supported trading pair is indexed.",
                ],
                [
                  "How are quieter markets supported?",
                  "A 35% timing reserve is held within each holder allocation; it remains owed to those holders. When verified hourly volume falls below half its recent baseline, up to 5% of the reserve is released per 15-minute cycle, capped at 20% of the day’s opening reserve. Eight consecutive volume observations are required. Unavailable data keeps the reserve held.",
                ],
                [
                  "Who receives the initial buy?",
                  "Your connected Solana launching wallet. Enter the initial buy in SOL. Account setup with the SOL conversion, coin creation, and fee lock with the purchase are approved together and sent as one Jito bundle. Every transaction must confirm before the coin is published. Existing finalized conversions keep their recovery path. Network fees can apply; relay bundles also carry a small disclosed tip.",
                ],
                [
                  "Is this an official NEAR or Pump.fun product?",
                  "Intent Pad is an independent application. NEAR Intents provides the funding routes and Pump.fun provides token creation and trading. Tokens are speculative and can lose all value.",
                ],
              ].map(([q, a]) => (
                <details key={q}>
                  <summary>
                    {q}
                    <Icon name="chevron" size={16} />
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
            <div className="documentation-links">
              <a
                href="https://docs.near-intents.org/"
                target="_blank"
                rel="noreferrer"
              >
                NEAR Intents <Icon name="arrow" />
              </a>
              <a
                href="https://pump.fun/docs/fees"
                target="_blank"
                rel="noreferrer"
              >
                Pump.fun fees <Icon name="arrow" />
              </a>
            </div>
          </section>
        )}
      </main>
      <footer className="container footer">
        <a className="brand" href="/" onClick={(e) => link(e, "/")}>
          <img className="intent-brand-logo" src="/intent-logo.png" width="34" height="34" alt=""/>
          <span>
            Intent<span className="brand-light">Pad</span>
          </span>
        </a>
        <div>
          <a href="/dashboard" onClick={(e) => link(e, "/dashboard")}>
            My launches
          </a>
          <a href="/docs" onClick={(e) => link(e, "/docs")}>
            How it works
          </a>
          <a href="https://near-intents.org" target="_blank" rel="noreferrer">
            NEAR Intents <Icon name="arrow" size={13} />
          </a>
        </div>
        <p>
          Independent, built around NEAR. Coins are speculative and can lose all
          value.
        </p>
        <span>© {YEAR} Intent Pad · $INTENT</span>
      </footer>
      {(notice || (route.page !== "launch" && launch.message)) && (
        <div className="toast" role="status">
          <Icon name="layers" size={16} />
          <span>{notice || launch.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => {
              setNotice("");
              launch.dismiss();
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {launch.choosing && (
        <Modal label="wallet-title" close={() => launch.setChoosing(false)}>
          <section className="wallet-modal panel">
            <div className="form-heading">
              <h2 id="wallet-title">Connect a Solana wallet.</h2>
              <button
                className="icon-button"
                aria-label="Close wallet selection"
                onClick={() => launch.setChoosing(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <p className="page-lede">
              Your wallet approves coin creation and receives your initial buy. Creator fees fund holder rewards.
            </p>
            {launch.wallets.length ? (
              launch.wallets.map((w) => (
                <button
                  key={w.name}
                  className="wallet-choice"
                  onClick={() => void launch.connect(w)}
                >
                  <img src={w.icon} alt="" width="28" height="28" />
                  {w.name}
                  <Icon name="arrow" />
                </button>
              ))
            ) : (
              <div className="inline-status">
                No Solana wallet was detected. Open this site in your wallet’s
                browser, or install a supported wallet such as Phantom.
              </div>
            )}
          </section>
        </Modal>
      )}
      {funding && launch.account && (
        <Funding
          recipient={launch.account}
          close={() => setFunding(false)}
          onFunded={() => void launch.refreshBalance()}
        />
      )}
    </div>
  );
}
function HolderRewards({mint,allocationVersion=1}:{mint:string;allocationVersion?:number}){
 const [data,setData]=useState<{claimedRaw:string;intentRoutedRaw?:string;distributedRaw:string;reserveRaw:string;outstandingRaw:string;updatedAt:number;lastSnapshot:{slot:number;root:string}|null;payouts:{signature:string;owner:string;raw:string;time:number}[]}|null>(null),[error,setError]=useState(false);
 useEffect(()=>{let active=true;const refresh=()=>api<{rewards:typeof data}>("/api/rewards?mint="+mint).then(r=>{if(active){setData(r.rewards);setError(false)}}).catch(()=>{if(active)setError(true)});void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh()},30000);return ()=>{active=false;clearInterval(timer)}},[mint]);
 return <section className="holder-rewards panel"><span className="eyebrow">THIS COIN’S HOLDER REWARDS</span><h2>Creator fees, back to holders.</h2><p className="rewards-note">{mint===INTENT_MINT?"100% of INTENT creator fees funds INTENT holder airdrops.":allocationVersion===2?"80% of creator fees funds this coin’s holder airdrops. 20% funds INTENT holder airdrops.":"This earlier launch keeps its original holder-reward allocation."} Claims are checked every 15 minutes.</p>{data?<><div className="reward-metrics">{[["Fees claimed",data.claimedRaw],["Airdropped",data.distributedRaw],["Holder treasury reserve",data.reserveRaw],...(allocationVersion===2&&mint!==INTENT_MINT?[["Allocated to INTENT holders",data.intentRoutedRaw||"0"]]:[])].map(([label,value])=><div key={label}><span>{label}</span><strong>{atoms(value)} wNEAR</strong></div>)}</div><p className="rewards-note">{data.lastSnapshot?<>Latest observed finalized snapshot · slot {data.lastSnapshot.slot.toLocaleString()} · <span title={data.lastSnapshot.root}>{data.lastSnapshot.root.slice(0,12)}…</span></>:"Awaiting the first completed holder snapshot."} {atoms(data.outstandingRaw)} wNEAR in accrued holder credits. Updated {new Date(data.updatedAt*1000).toLocaleTimeString()}.</p>{data.payouts.length?data.payouts.slice(0,6).map((r,i)=><div className="reward-receipt" key={r.signature+':'+i}><span>{short(r.owner)} · {atoms(r.raw)} wNEAR</span><a href={'https://solscan.io/tx/'+r.signature} target="_blank" rel="noreferrer">Confirmed transfer <Icon name="arrow" size={12}/></a></div>):<p className="rewards-note">No confirmed airdrops yet. Transfers appear here after onchain confirmation.</p>}</>:<p className="rewards-note">{error?"Reward records are temporarily unavailable. Refresh to check again.":"The first verified claim, snapshot and airdrop records will appear here. No distribution has been recorded yet."}</p>}</section>;
}
function CoinPage({
  mint,
  copy,
  back,
}: {
  mint: string;
  copy: (s: string) => void;
  back: () => void;
}) {
  const [data, setData] = useState<{
      coin: Coin;
      curve?:CurveState|null;
      curveStatus?:"available"|"unavailable";
      marketStatus: "available" | "pending" | "unavailable";
      market: {
        pair: string;
        quoteSymbol: string;
        priceUsd: number | null;
        marketCap: number | null;
        volume24h: number | null;
        liquidity: number | null;
      } | null;
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0),
    [tab, setTab] = useState("About");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<NonNullable<typeof data>>(
        "/api/coin?mint=" + encodeURIComponent(mint),
      )
        .then((d) => {
          if (active) {
            setData(d);setError("");
            document.title =
              d.coin.name + " ($" + d.coin.symbol + ") · Intent Pad";
          }
        })
        .catch((e) => {
          if (active) {setError(e.message);setData(previous=>previous?{...previous,curve:null,curveStatus:"unavailable",market:null,marketStatus:"unavailable"}:null);}
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [mint, attempt]);
  if (loading)
    return (
      <section className="container page-section">
        <button className="back-link" onClick={back}>
          <Icon name="back" size={16} />
          All coins
        </button>
        <div className="skeleton token-heading-skeleton" />
        <div
          className="skeleton chart-skeleton"
          role="status"
          aria-label="Loading verified coin"
        />
      </section>
    );
  if (!data)
    return (
      <section className="container page-section">
        <button className="back-link" onClick={back}>
          <Icon name="back" size={16} />
          All coins
        </button>
        <Empty
          title="Coin page unavailable."
          action={
            <button
              className="button secondary"
              onClick={() => {
                setLoading(true);
                setError("");
                setAttempt((n) => n + 1);
              }}
            >
              Try again <Icon name="refresh" />
            </button>
          }
        >
          {error || "No confirmed launch was found."}
        </Empty>
      </section>
    );
  const { coin: c, market: m } = data;
  return (
    <section className="container token-page">
      <button className="back-link" onClick={back}>
        <Icon name="back" size={16} />
        All coins
      </button>
      <div className="token-heading">
        <CoinArt coin={c} large />
        <div>
          <div className="token-tags">
            <span className="network-label">
              <span className="status-dot" />
              LIVE ON SOLANA · NEAR PAIR
            </span>
            <span className="tag">Creator fee · {c.creatorFeeBps / 100}%</span>
          </div>
          <h1>
            {c.name}
            <span>${c.symbol}</span>
          </h1>
          <p>{c.description}</p>
        </div>
        <a
          className="button primary"
          href={"https://pump.fun/coin/" + c.mint}
          target="_blank"
          rel="noreferrer"
        >
          Trade with NEAR <Icon name="arrow" />
        </a>
      </div>
      <div className="token-address-row">
        <Address value={c.mint} label="Solana coin address" onCopy={copy} />
        <span>
          <Icon name="shield" size={14} /> Solana contract. Verify before you
          buy.
        </span>
      </div>
      <div className="token-metrics">
        {[
          ["Price", price(m?.priceUsd)],
          ["Market cap", price(m?.marketCap)],
          ["24h volume", price(m?.volume24h)],
          ["Liquidity", price(m?.liquidity)],
        ].map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>
      {error && <p className="inline-status" role="alert">Market data could not refresh. Use Refresh curve to retry; verify prices at the trading venue.</p>}
      <CurveProgress curve={data.curve} retry={()=>{setData(null);setLoading(true);setError("");setAttempt(n=>n+1);}}/>
      <div className="token-workspace">
        <section className="market-panel panel">
          <div className="panel-heading">
            <span>
              {c.symbol} / {m?.quoteSymbol || "NEAR"}
            </span>
            <span className="subtle">
              {m ? "DEX Screener" : "Market overview"}
            </span>
          </div>
          {m ? (
            <iframe
              className="price-chart"
              title={c.symbol + " trading chart"}
              src={
                "https://dexscreener.com/solana/" +
                m.pair +
                "?embed=1&theme=dark&trades=0&info=0"
              }
              loading="lazy"
            />
          ) : (
            <div className="market-empty">
              <div className="chart-grid" aria-hidden="true" />
              <span className="chart-empty-icon">
                <Icon name="layers" size={28} />
              </span>
              <h2>Your coin is onchain.</h2>
              <p>
                {data.marketStatus === "unavailable"
                  ? "Market data is temporarily unavailable. You can still open the coin’s Pump.fun market."
                  : "Its live chart and market metrics appear once DEX Screener indexes the trading pair."}
              </p>
              <a
                className="text-link"
                href={"https://pump.fun/coin/" + c.mint}
                target="_blank"
                rel="noreferrer"
              >
                Open the Pump.fun market <Icon name="arrow" size={15} />
              </a>
              <button
                className="text-link"
                onClick={() => {
                  setLoading(true);
                  setError("");
                  setAttempt((n) => n + 1);
                }}
              >
                Check indexing <Icon name="refresh" size={14} />
              </button>
            </div>
          )}
        </section>
        <aside className="token-sidebar">
          <section className="panel trading-card">
            <span className="eyebrow">TRADE ${c.symbol}</span>
            <h2>Paired with NEAR.</h2>
            <p>
              Buy or sell on the coin’s Pump.fun market. The pair uses wrapped
              NEAR on Solana.
            </p>
            <a
              className="button primary full"
              href={"https://pump.fun/coin/" + c.mint}
              target="_blank"
              rel="noreferrer"
            >
              Trade with NEAR on Pump.fun <Icon name="arrow" />
            </a>
            <small>
              Trades require your wallet approval. Verify the mint at the venue.
            </small>
          </section>
          <section className="panel token-proof">
            <span className="eyebrow">VERIFIED LAUNCH</span>
            <dl>
              <div>
                <dt>Network</dt>
                <dd>Solana mainnet</dd>
              </div>
              <div>
                <dt>Creator fee</dt>
                <dd>{c.creatorFeeBps / 100}%</dd>
              </div>
              <div>
                <dt>Reward treasury</dt>
                <dd title={c.feeTreasury}>{short(c.feeTreasury)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{new Date(c.createdAt).toLocaleDateString()}</dd>
              </div>
            </dl>
            <a
              className="text-link"
              href={"https://solscan.io/tx/" + c.signature}
              target="_blank"
              rel="noreferrer"
            >
              Launch receipt <Icon name="arrow" size={15} />
            </a>
            {c.settlementSignatures?.map((signature,i)=>signature===c.signature?null:<a className="text-link" key={signature} href={'https://solscan.io/tx/'+signature} target="_blank" rel="noreferrer">{i===0?'Account setup receipt':'Fee lock & buy receipt'} <Icon name="arrow" size={15}/></a>)}
          </section>
        </aside>
      </div>
      {c.rewardPolicyHash && <HolderRewards mint={c.mint} allocationVersion={c.feeAllocationVersion}/>}
      <div
        className="tabs detail-tabs"
        role="tablist"
        aria-label="Coin information"
      >
        {["About", "Onchain records"].map((t) => (
          <button
            role="tab"
            key={t}
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="token-detail-body" role="tabpanel">
        <h2>
          {tab === "About"
            ? "About " + c.name
            : "Every launch, backed by a receipt."}
        </h2>
        <p>
          {tab === "About"
            ? c.description
            : "This launch was published after finalized transaction verification, including its exact reviewed instructions, token mint and immutable creator-fee assignment. Market data is provided separately by DEX Screener."}
        </p>
        <div className="receipt-links">
          <a
            href={"https://solscan.io/token/" + c.mint}
            target="_blank"
            rel="noreferrer"
          >
            Token contract <Icon name="arrow" size={15} />
          </a>
          <a
            href={"https://solscan.io/account/" + c.creator}
            target="_blank"
            rel="noreferrer"
          >
            Creator wallet <Icon name="arrow" size={15} />
          </a>
          <a
            href={"https://solscan.io/tx/" + c.signature}
            target="_blank"
            rel="noreferrer"
          >
            Launch transaction <Icon name="arrow" size={15} />
          </a>
          {c.website && (
            <a href={c.website} target="_blank" rel="noreferrer">
              Website <Icon name="arrow" size={15} />
            </a>
          )}
          {c.twitter && (
            <a href={c.twitter} target="_blank" rel="noreferrer">
              X <Icon name="arrow" size={15} />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
