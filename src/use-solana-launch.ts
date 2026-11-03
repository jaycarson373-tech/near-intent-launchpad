import { useEffect, useEffectEvent, useRef, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import { getTransactionDecoder, getTransactionEncoder } from "@solana/kit";
import bs58 from "bs58";
import { launchDraft } from "../lib/launch-draft-store.mjs";
import {
  walletSignedLaunchMatches,
  cloutPaymentSignature,
} from "../lib/launch-signatures.mjs";
export type Coin = {
  feeTreasury:string;rewardPolicyHash:string|null;
  mint: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  creator: string;
  creatorFeeBps: number;
  quoteMint: string;
  quoteSymbol: string;
  signature: string;
  createdAt: string;
  verifiedAt: string;
  status: string;
  website: string;
  twitter: string;
};
export type CoinDraft = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
  creatorFeeBps: number;
  devBuySol: string;
};
export const EMPTY_COIN: CoinDraft = {
  name: "",
  symbol: "",
  description: "",
  image: "",
  website: "",
  twitter: "",
  creatorFeeBps: 30,
  devBuySol: "0",
};
export type Review = {
  feeTreasury:string;rewardPolicyHash:string;
  id: string;
  phase?:"conversion"|"launch";
  atomicSolBuy?:boolean;
  fundingId?:string|null;
  mint: string;
  wire?: string; // single-transaction reviews saved before bundles
  bundle?: { role: "setup" | "create" | "fees"; wire: string }[];
  tipLamports?: string;
  expiresAt: number;
  estimatedSolRaw: string;
  devBuyRaw: string;
  devBuySolRaw?:string;
  creatorFeeBps: number;
  name: string;
  symbol: string;
  creator: string;
};
type Saved = {
  creator: string;
  privateKey: CryptoKey;
  publicKey: string;
  details: CoinDraft;
  review?: Review;
  fundingId?:string;
  fundingSignature?:string;
  fundingSolRaw?: string; // exact SOL amount the saved conversion was for
  signed?: Uint8Array; // single-transaction launches saved before bundles
  signedBundle?: Uint8Array[]; // every bundle transaction, in review order
  signature?: string; // coin creation's fee-payer signature identifies the launch
  // Dead attempts (failed onchain or expired unsent), kept for reconciliation only.
  retired?: { reviewId: string; signature: string; status: string; at: number }[];
};
// Server statuses that mean the signed launch can never land again: "failed" is a
// finalized onchain error; "expired" (and legacy "review" after signing) means its
// blockhash passed unseen; "partial" means part of a bundle landed outside it.
const DEAD = ["failed", "review", "expired", "partial"];
const deadMessage = (status: string, error?: string) =>
  status === "partial"
    ? error || "Part of the launch landed. Keep this receipt; nothing will be re-signed."
    : status === "failed"
      ? "Failed onchain, so nothing was created. Start a new launch to retry."
      : "Expired before landing, so nothing was charged. Start a new launch to retry.";
type LaunchStatus = { status: string; coin?: Coin; funding?: { id: string; signature: string }; error?: string; created?: boolean };
const isSigned = (saved?: Saved) => !!(saved?.signed || saved?.signedBundle?.length);
// Same format the server accepts (lib/launch-model.js units); null if invalid.
const lamports = (value: string) => {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,9})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return String(BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0")));
};
// Unlinks a finalized conversion that no longer matches the launch. Its NEAR stays
// in the wallet; the receipt is archived for reconciliation.
const dropFunding = (saved: Saved) => {
  saved.retired = [
    ...(saved.retired || []),
    { reviewId: saved.fundingId || "", signature: saved.fundingSignature || "", status: "conversion-unused", at: Date.now() },
  ].slice(-5);
  delete saved.fundingId;
  delete saved.fundingSignature;
  delete saved.fundingSolRaw;
};
type Account = { address: string; chains: readonly string[] };
type Connected = { wallet: Wallet; account: Account };
const from64 = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0)),
  to64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
export async function api<T>(url: string, input?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: input ? "POST" : "GET",
    headers: input ? { "content-type": "application/json" } : undefined,
    body: input ? JSON.stringify(input) : undefined,
    signal: AbortSignal.timeout(input ? 70000 : 30000),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(
      Error(
        data.error || "Request unavailable. Keep the original receipt and retry.",
      ),
      { status: r.status },
    );
  return data;
}
export function useSolanaLaunch() {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]),
    [connected, setConnected] = useState<Connected | null>(null),
    [choosing, setChoosing] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [signature, setSignature] = useState(""),
    [confirmedCoin, setConfirmedCoin] = useState<Coin | null>(null),
    [stage, setStage] = useState("idle"),
    [health, setHealth] = useState<{
      ready: boolean;
      missing: string[];
      creatorFeeOptions: number[];
    } | null>(null),
    [balance, setBalance] = useState<{
      solRaw: string;
      nearRaw: string;
    } | null>(null);
  const current = useRef<Connected | null>(null),
    lock = useRef(false);
  useEffect(() => {
    current.current = connected;
  }, [connected]);
  useEffect(() => {
    const directory = getWallets(),
      update = () =>
        setWallets(
          directory
            .get()
            .filter((w) => w.chains.some((c) => c.startsWith("solana:"))),
        );
    update();
    const off = directory.on("register", update),
      off2 = directory.on("unregister", update);
    void api<typeof health>("/api/launch?action=health")
      .then(setHealth)
      .catch(() =>
        setHealth({
          ready: false,
          missing: ["launch availability check"],
          creatorFeeOptions: [],
        }),
      );
    return () => {
      off();
      off2();
    };
  }, []);
  async function connect(wallet?: Wallet) {
    if (lock.current) return;
    if (!wallet) {
      setChoosing(true);
      return;
    }
    try {
      setMessage("");
      const feature = wallet.features["standard:connect"] as {
        connect: () => Promise<{ accounts: Account[] }>;
      };
      const result = await feature.connect();
      const account = result.accounts.find((a) =>
        a.chains.includes("solana:mainnet"),
      );
      if (!account) throw Error("Choose a Solana mainnet account.");
      current.current = { wallet, account };
      setConnected({ wallet, account });
      setConfirmedCoin(null);
      setChoosing(false);
      setReview(null);
      setSignature("");
      setStage("idle");
      const saved = (await launchDraft("get", "mainnet:" + account.address)) as
        | Saved
        | undefined;
      if (saved?.review) {
        setReview(saved.review);
        setSignature(saved.signature || "");
        setStage(isSigned(saved) ? "submitted" : "review");
        setMessage(
          isSigned(saved)
            ? "Your signed launch is saved. Resume the original transaction."
            : "Your saved launch review is restored.",
        );
      }
      void refreshBalance(account.address);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  useEffect(() => {
    if (!connected) return;
    const events = connected.wallet.features["standard:events"] as
      | {
          on: (
            event: string,
            callback: (value: { accounts: Account[] }) => void,
          ) => () => void;
        }
      | undefined;
    return events?.on("change", ({ accounts }) => {
      const account = accounts.find(
        (a) => a.address === connected.account.address,
      );
      if (!account) {
        current.current = null;
        setConnected(null);
        setBalance(null);
        setConfirmedCoin(null);
        setReview(null);
        setSignature("");
        setStage("idle");
        setMessage(
          "Wallet account changed. The previous launch receipt remains saved to its original wallet.",
        );
      }
    });
  }, [connected]);
  async function refreshBalance(address = connected?.account.address) {
    if (!address) return;
    try {
      const next = await api<{ solRaw: string; nearRaw: string }>(
        "/api/launch?action=balance&address=" + address,
      );
      if (current.current?.account.address === address) setBalance(next);
    } catch {
      if (current.current?.account.address === address) setBalance(null);
    }
  }
  async function prepare(details: CoinDraft) {
    if (lock.current) return;
    setConfirmedCoin(null);
    if (!connected) {
      setChoosing(true);
      return;
    }
    lock.current = true;
    setBusy(true);
    setMessage("Checking the SOL purchase route and simulating coin creation.");
    const creator = connected.account.address,
      key = "mainnet:" + creator;
    let amountChanged = false,
      held: Saved | undefined;
    try {
      let saved = (await launchDraft("get", key)) as Saved | undefined;
      if (isSigned(saved)) {
        throw Error(
          "This wallet has a signed launch. Resume it before preparing another coin.",
        );
      }
      if (!saved) {
        const pair = (await crypto.subtle.generateKey(
          { name: "Ed25519" },
          false,
          ["sign", "verify"],
        )) as CryptoKeyPair;
        const publicKey = bs58.encode(
          new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
        );
        saved = { creator, privateKey: pair.privateKey, publicKey, details };
      } else {
        // A finalized conversion only funds the exact SOL amount it converted. A new
        // nonzero amount needs a new atomic review; the old NEAR stays.
        const next = lamports(details.devBuySol),
          converted = saved.fundingSolRaw ?? lamports(saved.details.devBuySol);
        if (saved.fundingId && next && next !== "0" && next !== converted) {
          dropFunding(saved);
          amountChanged = true;
        }
        saved.details = details;
      }
      held = saved;
      await launchDraft("put", key, saved);
      const result = await api<Review>("/api/launch?action=prepare", {
        ...details,
        flow: "bundle",
        creator,
        mint: saved.publicKey,
        fundingId:saved.fundingId,
      });
      if (current.current?.account.address !== creator)
        throw Error(
          "The connected wallet changed. Reconnect the original wallet to restore this review.",
        );
      saved.review = result;
      await launchDraft("put", key, saved);
      setReview(result);
      setStage("review");
      setMessage(
        amountChanged
          ? "New amount prepared as one SOL buy and launch. Your earlier NEAR stays in your wallet."
          : "Simulation passed. Review the costs before approving in your wallet.",
      );
    } catch (e) {
      // Older drafts did not record the converted amount; the server's mismatch
      // answer is then the signal. Nothing is requested until the user prepares again.
      if (
        held?.fundingId &&
        /saved SOL conversion belongs to another/.test((e as Error).message)
      ) {
        dropFunding(held);
        await launchDraft("put", key, held);
        setMessage(
          "This amount needs a new atomic launch review. Your earlier NEAR stays in your wallet. Prepare again.",
        );
      } else setMessage((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function converted(saved:Saved,funding:{id:string;signature:string}){
    saved.fundingId=funding.id;saved.fundingSignature=funding.signature;saved.fundingSolRaw=saved.review?.devBuySolRaw;delete saved.signed;delete saved.signedBundle;delete saved.signature;delete saved.review;await launchDraft('put','mainnet:'+saved.creator,saved);
    if(current.current?.account.address!==saved.creator)return;
    setReview(null);setSignature('');setStage('idle');setMessage('SOL conversion finalized. Preparing coin creation; no second SOL conversion is requested.');
    const result=await api<Review>('/api/launch?action=prepare',{...saved.details,flow:'bundle',creator:saved.creator,mint:saved.publicKey,fundingId:saved.fundingId});saved.review=result;await launchDraft('put','mainnet:'+saved.creator,saved);
    if(current.current?.account.address!==saved.creator)return;setReview(result);setStage('review');setMessage('SOL is converted. Approve coin creation and the initial buy. Converted tokens stay in your wallet if you stop.');
  }
  // Clears a dead signed attempt so the wallet can launch again. The mint key, any
  // finalized SOL conversion and the form details stay, so a retry never double-creates
  // a mint or asks for a second conversion. A partial launch that created its coin used
  // the mint, so the next launch gets a fresh mint key.
  async function retire(saved: Saved, status: string, mintUsed = false) {
    if (!saved.signature || !saved.review) return;
    saved.retired = [
      ...(saved.retired || []),
      { reviewId: saved.review.id, signature: saved.signature, status, at: Date.now() },
    ].slice(-5);
    delete saved.signed;
    delete saved.signedBundle;
    delete saved.signature;
    delete saved.review;
    if (mintUsed) {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
      saved.privateKey = pair.privateKey;
      saved.publicKey = bs58.encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    }
    await launchDraft("put", "mainnet:" + saved.creator, saved);
  }
  async function follow(saved: Saved) {
    const r = await api<LaunchStatus>(
      "/api/launch?action=submit",
      saved.signedBundle?.length
        ? { id: saved.review!.id, wires: saved.signedBundle.map(to64) }
        : { id: saved.review!.id, wire: to64(saved.signed!) },
    );
    if(r.status==="converted"&&r.funding){await converted(saved,r.funding);return;}
    if (r.status === "confirmed" && r.coin) {
      await launchDraft("delete", "mainnet:" + saved.creator);
      if (current.current?.account.address !== saved.creator) return;
      setConfirmedCoin(r.coin);
      setStage("confirmed");
      setReview(null);
      setSignature(saved.signature!);
      setMessage("Coin creation is finalized and its page is published.");
      return r.coin;
    }
    if (DEAD.includes(r.status)) await retire(saved, r.status, r.created === true);
    if (current.current?.account.address !== saved.creator) return;
    setStage(r.status);
    if (DEAD.includes(r.status)) setMessage(deadMessage(r.status, r.error));
    else if (r.error) setMessage(r.error);
    else
      setMessage(
        "Tracking your original transaction. No second payment is requested.",
      );
  }
  async function approve() {
    if (lock.current || !connected || !review) return;
    lock.current = true;
    setBusy(true);
    const owner = connected.account.address,
      key = "mainnet:" + owner;
    try {
      const saved = (await launchDraft("get", key)) as Saved | undefined;
      if (
        !saved?.review ||
        saved.review.id !== review.id ||
        saved.creator !== owner
      )
        throw Error("The saved launch does not match this wallet.");
      if (!isSigned(saved)) {
        if (Date.now() > saved.review.expiresAt)
          throw Error(
            "This review expired. Edit the details and prepare a fresh review; no transaction was submitted.",
          );
        const bundle = saved.review.bundle;
        if (!bundle?.length || bundle.filter((b) => b.role === "create").length !== 1)
          throw Error("Prepare a fresh review for the updated launch flow; nothing was submitted.");
        const signer = connected.wallet.features["solana:signTransaction"] as {
          signTransaction: (
            ...inputs: { account: Account; transaction: Uint8Array; chain: string }[]
          ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
        };
        if (!signer)
          throw Error("This wallet cannot sign Solana transactions.");
        setStage("wallet");
        setMessage("Approve once. Your wallet shows " + bundle.length + " transactions that run together or not at all.");
        // One wallet request signs every bundle transaction; outputs come back in input order.
        const outputs = await signer.signTransaction(
          ...bundle.map((b) => ({
            account: connected.account,
            transaction: from64(b.wire),
            chain: "solana:mainnet",
          })),
        );
        if (outputs.length !== bundle.length || outputs.some((o) => !o?.signedTransaction))
          throw Error("The wallet did not return every signed transaction. Nothing was submitted.");
        const wires: Uint8Array[] = [];
        for (let i = 0; i < bundle.length; i++) {
          let wire = new Uint8Array(outputs[i].signedTransaction);
          if (bundle[i].role === "create") {
            // The browser-held mint key co-signs coin creation only.
            const decoded = getTransactionDecoder().decode(wire);
            const mintSignature = new Uint8Array(await crypto.subtle.sign({name:'Ed25519'},saved.privateKey,new Uint8Array(decoded.messageBytes)));
            wire = new Uint8Array(getTransactionEncoder().encode({...decoded,signatures:{...decoded.signatures,[saved.publicKey]:mintSignature}}));
          }
          walletSignedLaunchMatches(from64(bundle[i].wire), wire);
          wires.push(wire);
        }
        saved.signedBundle = wires;
        saved.signature = cloutPaymentSignature(wires[bundle.findIndex((b) => b.role === "create")]);
        // Saved before submission so a reload resumes these exact bytes.
        await launchDraft("put", key, saved);
        if (current.current?.account.address === owner)
          setSignature(saved.signature);
      }
      if (current.current?.account.address !== owner)
        throw Error(
          "Reconnect the original signing wallet to resume its saved launch.",
        );
      setStage("submitted");
      setMessage("Submitting and confirming the saved launch.");
      return await follow(saved);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!connected || !review || !signature || busy || lock.current) return;
    const owner = connected.account.address;
    try {
      setBusy(true);
      const r = await api<LaunchStatus>(
        "/api/launch?action=status&id=" + review.id + "&signature=" + signature,
      );
      if (DEAD.includes(r.status)) {
        const saved = (await launchDraft("get", "mainnet:" + owner)) as Saved | undefined;
        if (saved?.signature === signature) await retire(saved, r.status, r.created === true);
      }
      if (current.current?.account.address !== owner) return;
      setStage(r.status);
      if(r.status==='converted'&&r.funding){const saved=await launchDraft('get','mainnet:'+owner) as Saved|undefined;if(!saved)throw Error('Reconnect the original wallet to recover the conversion.');await converted(saved,r.funding);return;}
      if (r.status === "confirmed" && r.coin) {
        await launchDraft("delete", "mainnet:" + connected.account.address);
        setReview(null);
        setConfirmedCoin(r.coin);
        setMessage("Coin creation is finalized.");
        return r.coin;
      }
      setMessage(
        DEAD.includes(r.status)
          ? deadMessage(r.status, r.error)
          : r.error || "Still checking the original launch.",
      );
    } catch (e) {
      // 404: the server never stored this signed launch, so it never broadcast it.
      // After the review's deadline the server refuses to store it, so it is dead.
      if (
        (e as { status?: number }).status === 404 &&
        Date.now() > review.expiresAt + 120000
      ) {
        const saved = (await launchDraft("get", "mainnet:" + owner)) as Saved | undefined;
        if (saved?.signature === signature) {
          await retire(saved, "review");
          if (current.current?.account.address !== owner) return;
          setStage("review");
          setMessage(deadMessage("review"));
          return;
        }
      }
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const poll = useEffectEvent(() => {
    void check();
  });
  useEffect(() => {
    if (
      !signature ||
      !review ||
      [...DEAD, "confirmed"].includes(stage)
    )
      return;
    const timer = setInterval(() => poll(), 6000);
    return () => clearInterval(timer);
  }, [signature, review, stage]);
  const edit = () => {
    if (signature && !DEAD.includes(stage)) {
      setMessage(
        "This launch has a signed receipt. Resume the original transaction.",
      );
      return;
    }
    setReview(null);
    setSignature("");
    setStage("idle");
    setMessage("");
  };
  return {
    account: connected?.account.address || "",
    wallets,
    choosing,
    setChoosing,
    connect,
    busy,
    message,
    dismiss: () => setMessage(""),
    review,
    signature,
    stage,
    health,
    balance,
    refreshBalance,
    prepare,
    approve,
    check,
    edit,
    ended: !!signature && DEAD.includes(stage),
    confirmedCoin,
  };
}
