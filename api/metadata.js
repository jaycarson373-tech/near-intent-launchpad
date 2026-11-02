import { read } from "../lib/store.js";
import { send, handleError, fail, origin } from "../lib/http.js";
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") fail("Method not allowed.", 405);
    const q = new URL(req.url, "https://intentpad.local").searchParams,
      id = q.get("id");
    if (!/^[a-f0-9-]{36}$/.test(id || "")) fail("Metadata not found.", 404);
    const d = await read("drafts/" + id + ".json");
    if (!d || d.phase==="conversion") fail("Metadata not found.", 404);
    if (q.has("image")) {
      res.setHeader("Content-Type", d.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public,max-age=31536000,immutable");
      res.end(Buffer.from(d.image.split(",")[1], "base64"));
      return;
    }
    return send(res, 200, {
      name: d.name,
      symbol: d.symbol,
      description: d.description,
      image: d.imageUrl,
      external_url: origin() + "/coin/" + d.mint,
      website: origin() + "/coin/" + d.mint,
      twitter: d.twitter || undefined,
      extensions: { website: d.website || undefined },
    });
  } catch (error) {
    handleError(res, error);
  }
}
