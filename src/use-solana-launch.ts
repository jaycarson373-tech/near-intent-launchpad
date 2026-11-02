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
  mint: string;
  wire: string;
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
  signed?: Uint8Array;
  signature?: string;
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
    throw Error(
      data.error || "Request unavailable. Keep the original receipt and retry.",
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
        setStage(saved.signed ? "submitted" : "review");
        setMessage(
          saved.signed
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
    try {
      let saved = (await launchDraft("get", key)) as Saved | undefined;
      if (saved?.signed) {
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
      } else saved.details = details;
      await launchDraft("put", key, saved);
      const result = await api<Review>("/api/launch?action=prepare", {
        ...details,
        creator,
        mint: saved.publicKey,
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
        "Simulation passed. Review the costs before approving in your wallet.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function follow(saved: Saved) {
    const r = await api<{ status: string; coin?: Coin; error?: string }>(
      "/api/launch?action=submit",
      { id: saved.review!.id, wire: to64(saved.signed!) },
    );
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
    if (current.current?.account.address !== saved.creator) return;
    setStage(r.status);
    if (r.error) setMessage(r.error);
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
      if (!saved.signed) {
        if (Date.now() > saved.review.expiresAt)
          throw Error(
            "This review expired. Edit the details and prepare a fresh review; no transaction was submitted.",
          );
        const signer = connected.wallet.features["solana:signTransaction"] as {
          signTransaction: (x: {
            account: Account;
            transaction: Uint8Array;
            chain: string;
          }) => Promise<{ signedTransaction: Uint8Array }[]>;
        };
        if (!signer)
          throw Error("This wallet cannot sign Solana transactions.");
        setStage("wallet");
        setMessage("Review coin creation in your Solana wallet.");
        const signed = await signer.signTransaction({
          account: connected.account,
          transaction: from64(saved.review.wire),
          chain: "solana:mainnet",
        });
        if (!signed[0]?.signedTransaction)
          throw Error("The wallet did not return a signed transaction.");
        const decoded = getTransactionDecoder().decode(
          signed[0].signedTransaction,
        );
        const mintSignature = new Uint8Array(
          await crypto.subtle.sign(
            { name: "Ed25519" },
            saved.privateKey,
            new Uint8Array(decoded.messageBytes),
          ),
        );
        const wire = new Uint8Array(
          getTransactionEncoder().encode({
            ...decoded,
            signatures: {
              ...decoded.signatures,
              [saved.publicKey]: mintSignature,
            },
          }),
        );
        walletSignedLaunchMatches(from64(saved.review.wire), wire);
        saved.signed = wire;
        saved.signature = cloutPaymentSignature(wire);
        await launchDraft("put", key, saved);
        if (current.current?.account.address === owner)
          setSignature(saved.signature);
      }
      if (current.current?.account.address !== owner)
        throw Error(
          "Reconnect the original signing wallet to resume its saved launch.",
        );
      setStage("submitted");
      setMessage("Submitting and confirming the saved transaction.");
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
      const r = await api<{ status: string; coin?: Coin; error?: string }>(
        "/api/launch?action=status&id=" + review.id + "&signature=" + signature,
      );
      if (current.current?.account.address !== owner) return;
      setStage(r.status);
      if (r.status === "confirmed" && r.coin) {
        await launchDraft("delete", "mainnet:" + connected.account.address);
        setReview(null);
        setConfirmedCoin(r.coin);
        setMessage("Coin creation is finalized.");
        return r.coin;
      }
      setMessage(r.error || "Still checking the original launch transaction.");
    } catch (e) {
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
      ["failed", "review", "confirmed"].includes(stage)
    )
      return;
    const timer = setInterval(() => poll(), 6000);
    return () => clearInterval(timer);
  }, [signature, review, stage]);
  const edit = () => {
    if (signature) {
      setMessage(
        "This launch has a signed receipt. Resume the original transaction.",
      );
      return;
    }
    setReview(null);
    setStage("idle");
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
    confirmedCoin,
  };
}
