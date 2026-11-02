import { useState } from "react";
import { Modal } from "./Modal";
import { useNearLaunch } from "./use-near-launch";
import { api } from "./use-solana-launch";
import { formatNear } from "./near-model";
import { Icon } from "./icons";
type Quote = {
  id: string;
  amountIn: string;
  amountOutFormatted: string;
  minAmountOut: string;
  asset: string;
  depositAddress: string;
  deadline: string;
  recipient: string;
  refundTo: string;
  authenticated: boolean;
};
type Plan = {
  amount:string;
  recipient:string;
  depositAddress:string;
  owner: string;
  receiverId: string;
  actions: {
    methodName: string;
    args: Record<string, unknown>;
    deposit: string;
  }[];
  nearRequired: string;
};
export function Funding({
  recipient,
  close,
  onFunded,
}: {
  recipient: string;
  close: () => void;
  onFunded: () => void;
}) {
  const near = useNearLaunch(true),
    storage = "intent-pad-funding:" + recipient,
    [amount, setAmount] = useState("5"),
    [asset, setAsset] = useState("NEAR"),
    [quote, setQuote] = useState<Quote | null>(() => {
      try {
        return (
          JSON.parse(localStorage.getItem(storage) || "null")?.quote || null
        );
      } catch {
        return null;
      }
    }),
    [requested, setRequested] = useState(() => {
      try {
        return !!JSON.parse(localStorage.getItem(storage) || "null")?.requested;
      } catch {
        return false;
      }
    }),
    [plan, setPlan] = useState<Plan | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [status, setStatus] = useState("");
  async function getQuote() {
    if (!near.account) {
      await near.connect();
      return;
    }
    setBusy(true);
    setMessage("Requesting an exact Intents funding quote.");
    try {
      const q = await api<Quote>("/api/intents", {
        amount,
        asset,
        recipient,
        refundTo: near.account,
      });
      localStorage.setItem(
        storage,
        JSON.stringify({ quote: q, requested: false }),
      );
      setQuote(q);
      setRequested(false);
      setPlan(
        await api<Plan>(
          "/api/intents?action=plan&id=" + q.id + "&owner=" + near.account,
        ),
      );
      setMessage(
        "Review the conversion, recipient and NEAR deposit before approving.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deposit() {
    if (!quote || requested) return;
    setBusy(true);
    try {
      if (!near.account || near.account !== quote.refundTo) {
        await near.connect();
        return;
      }
      const fresh = await api<Plan>(
        "/api/intents?action=plan&id=" + quote.id + "&owner=" + near.account,
      );
      if(fresh.owner!==quote.refundTo||fresh.recipient!==recipient||quote.recipient!==recipient||fresh.amount!==quote.amountIn||fresh.depositAddress!==quote.depositAddress)throw Error('The saved funding quote differs from this wallet. No deposit was requested.');
      setPlan(fresh);
      localStorage.setItem(storage, JSON.stringify({ quote, requested: true }));
      setRequested(true);
      setMessage("Approve wrapping and the quote deposit in your NEAR wallet.");
      const hash = await near.fund(fresh);
      setMessage(
        hash
          ? "Deposit transaction returned. Check the Intents status for settlement."
          : "Return after wallet approval and check the saved funding status.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (!quote) return;
    setBusy(true);
    try {
      const r = await api<{ status: string }>("/api/intents?id=" + quote.id);
      setStatus(r.status);
      setMessage(
        "Intents status: " +
          r.status.replaceAll("_", " ") +
          ". Your Solana wallet balance is checked separately before launch.",
      );
      onFunded();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const terminal = ["SUCCESS", "REFUNDED"].includes(status);
  return (
    <Modal label="funding-title" close={close}>
      <section className="funding-modal panel">
        <div className="form-heading">
          <div>
            <span className="eyebrow">POWERED BY NEAR INTENTS</span>
            <h2 id="funding-title">Fund your Solana wallet.</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close funding"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="page-lede">
          Use NEAR for your coin’s initial buy, or convert to SOL for account
          rent and network fees.
        </p>
        {!quote ? (
          <>
            <div className="form-grid">
              <label>
                Amount in NEAR
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label>
                Receive on Solana
                <select
                  value={asset}
                  onChange={(e) => setAsset(e.target.value)}
                >
                  <option value="NEAR">wNEAR · Initial buy</option>
                  <option value="SOL">SOL · Network fees</option>
                </select>
              </label>
            </div>
            <button
              className="button primary full"
              disabled={busy}
              onClick={() => void getQuote()}
            >
              {busy
                ? "Getting quote…"
                : near.account
                  ? "Review funding quote"
                  : "Connect NEAR funding wallet"}
              <Icon name="arrow" />
            </button>
          </>
        ) : (
          <>
            <dl className="funding-review">
              <div>
                <dt>Send</dt>
                <dd>{formatNear(quote.amountIn)} NEAR</dd>
              </div>
              <div>
                <dt>Receive (estimated)</dt>
                <dd>
                  {quote.amountOutFormatted}{" "}
                  {quote.asset === "NEAR" ? "wNEAR" : "SOL"} on Solana
                </dd>
              </div>
              <div>
                <dt>Minimum received</dt>
                <dd>
                  {(BigInt(quote.minAmountOut) / 1000000000n).toString()}.
                  {(BigInt(quote.minAmountOut) % 1000000000n)
                    .toString()
                    .padStart(9, "0")}{" "}
                  {quote.asset}
                </dd>
              </div>
              <div>
                <dt>Solana recipient</dt>
                <dd>{quote.recipient}</dd>
              </div>
              <div>
                <dt>Refund NEAR wallet</dt>
                <dd>{quote.refundTo}</dd>
              </div>
              {plan && (
                <div>
                  <dt>Maximum attached NEAR</dt>
                  <dd>{formatNear(plan.nearRequired)} NEAR + network gas</dd>
                </div>
              )}
            </dl>
            <p className="small-note">
              1% maximum slippage. Provider and bridge costs are reflected in
              the quote.
              {!quote.authenticated
                ? " The provider applies its additional 0.25% unauthenticated fee."
                : ""}{" "}
              NEAR is wrapped only as needed before the quote deposit. This is a
              funding transaction, separate from coin creation.
            </p>
            {!requested && !terminal && (
              <button
                className="button primary full"
                disabled={busy}
                onClick={() => void deposit()}
              >
                {near.account === quote.refundTo
                  ? "Approve deposit in NEAR wallet"
                  : "Connect the funding NEAR wallet"}
                <Icon name="wallet" />
              </button>
            )}
            <button
              className="button secondary full"
              disabled={busy}
              onClick={() => void check()}
            >
              Check saved funding status <Icon name="refresh" />
            </button>
            {(!requested || terminal) && (
              <button
                className="text-link"
                onClick={() => {
                  localStorage.removeItem(storage);
                  setQuote(null);
                  setPlan(null);
                  setRequested(false);
                }}
              >
                Start another funding quote
              </button>
            )}
          </>
        )}
        {(message || near.message) && (
          <p className="inline-status" role="status">
            {message || near.message}
          </p>
        )}
      </section>
    </Modal>
  );
}
