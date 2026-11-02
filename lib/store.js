import { put, get, list, del } from "@vercel/blob";
export const PREFIX = "intent-pad-solana-v1/";
export function configured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}
export async function read(key) {
  const result = await get(PREFIX + key, {
    access: "private",
    useCache: false,
  });
  if (!result) return null;
  return JSON.parse(await new Response(result.stream).text());
}
export async function create(key, value) {
  return put(PREFIX + key, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}
export async function createOnce(key, value, identity) {
  try {
    await create(key, value);
    return value;
  } catch (error) {
    const prior = await read(key);
    if (prior && identity(prior, value)) return prior;
    throw error;
  }
}
export async function records(prefix, limit = 40) {
  const found = await list({ prefix: PREFIX + prefix, limit });
  return (
    await Promise.all(
      found.blobs.map((blob) => read(blob.pathname.slice(PREFIX.length))),
    )
  ).filter(Boolean);
}

export async function removePointer(key) {
  if (!key.startsWith("pending/"))
    throw Error("Only pending index pointers can be removed.");
  await del(PREFIX + key);
}
