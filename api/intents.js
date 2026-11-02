import {
  send,
  body,
  handleError,
  sameOrigin,
  fail,
  limit,
} from "../lib/http.js";
import { fundingQuote, fundingStatus, fundingPlan } from "../lib/funding.js";
export default async function handler(req, res) {
  try {
    const q = new URL(req.url, "https://intentpad.local").searchParams;
    if (req.method === "GET" && q.get("id")) {
      limit(req, "funding-status", 30);
      return send(
        res,
        200,
        q.get("action") === "plan"
          ? await fundingPlan(q.get("id"), q.get("owner"))
          : await fundingStatus(q.get("id")),
      );
    }
    if (req.method !== "POST") fail("Method not allowed.", 405);
    sameOrigin(req);
    limit(req, "funding", 4);
    send(res, 200, await fundingQuote(await body(req, 4096)));
  } catch (error) {
    handleError(res, error);
  }
}
