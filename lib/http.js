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
export function handleError(res, error) {
  send(res, error.safe ? error.status : 503, {
    error: error.safe
      ? error.message
      : "The launch service is temporarily unavailable. Keep your saved receipt and retry.",
  });
}
