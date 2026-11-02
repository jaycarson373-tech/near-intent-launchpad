import { useEffect, useState } from "react";
import { api } from "./use-solana-launch";
export type Pulse = {
  market: {
    usd: number;
    change24h: number | null;
    asOf: number;
    source: string;
    url: string;
    status: string;
  } | null;
  activity: {
    status: string;
    totalDistributedRaw: string | null;
    updatedAt?: number;
    events: {
      id: string;
      kind: "claim" | "airdrop";
      mint: string;
      signature: string;
      raw: string;
      at: number;
      recipients?: number;
    }[];
  };
};
export function usePulse() {
  const [pulse, setPulse] = useState<Pulse | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<Pulse>("/api/pulse")
        .then((d) => {
          if (active) setPulse(d);
        })
        .catch(() => {
          if (active) setPulse(null);
        });
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 45000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return pulse;
}
