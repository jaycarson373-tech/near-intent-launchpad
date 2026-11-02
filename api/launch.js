import {
  body,
  send,
  handleError,
  sameOrigin,
  limit,
  fail,
} from "../lib/http.js";
import {
  health,
  prepare,
  submit,
  status,
  walletBalance,
} from "../server/pump-launch.js";
export default async function handler(req, res) {
  try {
    const q = new URL(req.url, "https://intentpad.local").searchParams,
      action = q.get("action");
    if (req.method === "GET") {
      if (action === "balance") {
        limit(req, "balance", 12);
        return send(res, 200, await walletBalance(q.get("address")));
      }
      if (action === "health") return send(res, 200, await health());
      if (action === "status") {
        limit(req, "status", 30);
        return send(res, 200, await status(q.get("id"), q.get("signature")));
      }
      fail("Unknown launch operation.", 404);
    }
    if (req.method !== "POST") fail("Method not allowed.", 405);
    sameOrigin(req);
    limit(req, "launch", 6);
    const input = await body(req);
    if (action === "prepare") return send(res, 200, await prepare(input));
    if (action === "submit") return send(res, 200, await submit(input));
    fail("Unknown launch operation.", 404);
  } catch (error) {
    handleError(res, error);
  }
}
