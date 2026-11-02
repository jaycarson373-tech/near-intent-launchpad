export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status, safe: true });
}
export const send = (res, status, value) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
};
export function origin() {
  const value =
    process.env.APP_ORIGIN ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL
      : "https://near-intent-launchpad.vercel.app");
  const u = new URL(value);
  if (
    (u.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && u.hostname === "127.0.0.1")) ||
    u.username ||
    u.password
  )
    fail("The public site URL needs configuration.", 503);
  return u.origin;
}
export function sameOrigin(req) {
  if (req.headers.origin !== origin())
    fail("Use the launch form on this site.", 403);
}
export async function body(req, max = 2800000) {
  let value = req.body;
  if (value === undefined) {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > max) fail("Request is too large.", 413);
    }
    value = text;
  }
  try {
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > max) fail("Request is too large.", 413);
      value = JSON.parse(value);
    } else if (Buffer.byteLength(JSON.stringify(value)) > max)
      fail("Request is too large.", 413);
  } catch (error) {
    if (error.safe) throw error;
    fail("The request must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("The request must contain a JSON object.");
  return value;
}

const requests = new Map();
export function limit(req, tag, max = 10) {
  const key =
      tag +
      ":" +
      (req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket?.remoteAddress ||
        "unknown"),
    now = Date.now();
  if (requests.size > 10000)
    for (const [k, v] of requests) if (v.until < now) requests.delete(k);
  let value = requests.get(key);
  if (!value || value.until < now) {
    value = { count: 0, until: now + 60000 };
    requests.set(key, value);
  }
  if (++value.count > max)
    fail("Too many requests. Wait a minute and retry.", 429);
}
// Server-side diagnostics for unexpected errors (users still get the generic message).
// URLs, api keys and long base58/base64 blobs are stripped so no RPC key, signed wire or secret reaches the logs.
export function redact(text) {
  return String(text ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/g, "<url>")
    .replace(/api[-_]?key[=:]\s*[^\s&"']+/gi, "api-key=<redacted>")
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "<blob>")
    .slice(0, 600);
}
export function handleError(res, error) {
  if (!error?.safe)
    console.error(
      JSON.stringify({
        service: "intent-pad-api",
        unexpected: true,
        name: redact(error?.name),
        code: redact(error?.code ?? error?.cause?.code),
        message: redact(error?.message),
        logs: Array.isArray(error?.logs) ? error.logs.slice(-12).map(redact) : undefined,
      }),
    );
  send(res, error.safe ? error.status : 503, {
    error: error.safe
      ? error.message
      : "The launch service is temporarily unavailable. Keep your saved receipt and retry.",
  });
}
