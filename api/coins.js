import { send, handleError, fail } from "../lib/http.js";
import { listCoins } from "../server/pump-launch.js";
import { configured } from "../lib/store.js";
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") fail("Method not allowed.", 405);
    if (!configured())
      return send(res, 503, {
        error: "The launch directory is awaiting storage configuration.",
      });
    send(res, 200, { coins: await listCoins() });
  } catch (error) {
    handleError(res, error);
  }
}
