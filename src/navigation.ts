import { useCallback, useEffect, useState } from "react";
export type Route = {
  page:
    | "home"
    | "explore"
    | "dashboard"
    | "launch"
    | "docs"
    | "coin"
    | "native";
  account?: string;
};
export function currentRoute(): Route {
  const legacy = new URLSearchParams(location.search).get("token");
  if (legacy) return { page: "native", account: legacy };
  const path = location.pathname.replace(/\/$/, "") || "/";
  if (path.startsWith("/coin/")) {
    try {
      return { page: "coin", account: decodeURIComponent(path.slice(6)) };
    } catch {
      return { page: "coin", account: "" };
    }
  }
  if (["/explore", "/dashboard", "/launch", "/docs"].includes(path))
    return { page: path.slice(1) as Route["page"] };
  return { page: "home" };
}
export function useRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((path: string) => {
    history.pushState(null, "", path);
    setRoute(currentRoute());
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  return { route, navigate };
}
export const coinPath = (account: string) =>
  "/coin/" + encodeURIComponent(account);
