import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { get, put } from "@vercel/blob";
// Adapted from Penny's private SQLite/Blob journal and strong-ETag broadcast fence.
// This is a separate ledger, schema, signing context and storage namespace.
const digest = (b) => createHash("sha256").update(b).digest("hex");
const MAX = 24 * 1024 * 1024;
export class RewardJournal {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA foreign_keys=ON;CREATE TABLE IF NOT EXISTS coins(mint TEXT PRIMARY KEY,treasury TEXT NOT NULL,available TEXT NOT NULL DEFAULT '0',reserve TEXT NOT NULL DEFAULT '0',day TEXT NOT NULL DEFAULT '',opening TEXT NOT NULL DEFAULT '0',released TEXT NOT NULL DEFAULT '0',last_epoch INTEGER NOT NULL DEFAULT -1,last_claim INTEGER NOT NULL DEFAULT -1,last_payout INTEGER NOT NULL DEFAULT -1);CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,mint TEXT NOT NULL,kind TEXT NOT NULL,signature TEXT UNIQUE NOT NULL,wire TEXT NOT NULL,last_valid INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',plan TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS claims(signature TEXT PRIMARY KEY,mint TEXT NOT NULL,raw TEXT NOT NULL,holders TEXT NOT NULL,reserve TEXT NOT NULL,time INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS credits(mint TEXT NOT NULL,owner TEXT NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(mint,owner));CREATE TABLE IF NOT EXISTS epochs(mint TEXT NOT NULL,epoch INTEGER NOT NULL,slot INTEGER NOT NULL,root TEXT NOT NULL,budget TEXT NOT NULL,released TEXT NOT NULL,allocated TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(mint,epoch));CREATE TABLE IF NOT EXISTS payouts(signature TEXT NOT NULL,mint TEXT NOT NULL,owner TEXT NOT NULL,raw TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(signature,owner));CREATE TABLE IF NOT EXISTS volumes(mint TEXT NOT NULL,epoch INTEGER NOT NULL,cents TEXT,source TEXT,PRIMARY KEY(mint,epoch));`,
    );
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  coin(mint) {
    return this.db.prepare("SELECT * FROM coins WHERE mint=?").get(mint);
  }
  credit(mint, owner, raw) {
    const before =
        this.db
          .prepare("SELECT raw FROM credits WHERE mint=? AND owner=?")
          .get(mint, owner)?.raw || "0",
      next = BigInt(before) + BigInt(raw);
    if (next < 0n) throw Error("Negative holder credit.");
    this.db
      .prepare(
        "INSERT INTO credits(mint,owner,raw) VALUES(?,?,?) ON CONFLICT(mint,owner) DO UPDATE SET raw=excluded.raw",
      )
      .run(mint, owner, String(next));
  }
  pending() {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('pending','review') ORDER BY created LIMIT 1",
      )
      .get();
  }
  close() {
    this.db.close();
  }
}
export class CheckpointStore {
  constructor({ treasury, sdk = { get, put } }) {
    this.path = "intent-pad-solana-v1/rewards/ledgers/" + treasury + "/v1.json";
    this.sdk = sdk;
  }
  async read() {
    const r = await this.sdk.get(this.path, {
      access: "private",
      useCache: false,
      headers: { "accept-encoding": "identity" },
      abortSignal: AbortSignal.timeout(15000),
    });
    if (!r) return null;
    if (
      r.statusCode !== 200 ||
      !r.blob.etag ||
      r.blob.etag.startsWith("W/") ||
      r.blob.size > MAX
    )
      throw Error("Strong private journal storage is unavailable.");
    return {
      bytes: Buffer.from(await new Response(r.stream).arrayBuffer()),
      etag: r.blob.etag,
    };
  }
  async write(bytes, etag, initialize = false) {
    if (bytes.length > MAX || (!etag && !initialize))
      throw Error("Invalid journal commit.");
    const r = await this.sdk.put(this.path, bytes, {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: !initialize,
      cacheControlMaxAge: 60,
      ...(etag ? { ifMatch: etag } : {}),
      abortSignal: AbortSignal.timeout(15000),
    });
    if (!r.etag) throw Error("Missing journal commit acknowledgment.");
    return r.etag;
  }
}
export function envelope(database, context, revision) {
  const compressed = gzipSync(database),
    body = {
      version: 1,
      network: "mainnet",
      treasury: context.treasury,
      policyHash: context.policyHash,
      revision,
      sha256: digest(compressed),
      database: compressed.toString("base64"),
    };
  return Buffer.from(
    JSON.stringify({
      ...body,
      authentication: createHmac("sha256", context.secret)
        .update(JSON.stringify(body))
        .digest("hex"),
    }),
  );
}
export function decodeEnvelope(bytes, context) {
  if (bytes.length > MAX) throw Error("Journal exceeds size limit.");
  const { authentication, ...body } = JSON.parse(bytes.toString()),
    expected = createHmac("sha256", context.secret)
      .update(JSON.stringify(body))
      .digest("hex");
  if (
    !/^[a-f0-9]{64}$/.test(authentication || "") ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(authentication)) ||
    body.version !== 1 ||
    body.network !== "mainnet" ||
    body.treasury !== context.treasury ||
    body.policyHash !== context.policyHash ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 1
  )
    throw Error("Journal identity or authentication mismatch.");
  const compressed = Buffer.from(body.database, "base64");
  if (digest(compressed) !== body.sha256)
    throw Error("Journal checksum mismatch.");
  const database = gunzipSync(compressed, {
    maxOutputLength: 64 * 1024 * 1024,
  });
  if (database.subarray(0, 16).toString() !== "SQLite format 3\0")
    throw Error("Invalid journal database.");
  return { database, revision: body.revision };
}
export class JournalSession {
  static async open(store, context) {
    const dir = await mkdtemp(join(tmpdir(), "intent-rewards-"));
    let journal;
    try {
      let snapshot = await store.read();
      const path = join(dir, "ledger.sqlite");
      if (!snapshot) {
        journal = new RewardJournal(path);
        journal.close();
        journal = null;
        const bytes = envelope(await readFile(path), context, 1);
        try {
          await store.write(bytes, null, true);
        } catch {
          /* An initializing peer may have won the conditional create. */
        }
        snapshot = await store.read();
        if (!snapshot) throw Error("Journal initialization did not persist.");
      }
      const decoded = decodeEnvelope(snapshot.bytes, context);
      await writeFile(path, decoded.database, { mode: 0o600 });
      journal = new RewardJournal(path);
      if (journal.db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw Error("Journal integrity check failed.");
      return new this({
        store,
        context,
        dir,
        journal,
        etag: snapshot.etag,
        revision: decoded.revision,
      });
    } catch (e) {
      journal?.close();
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  constructor(value) {
    Object.assign(this, value);
    this.failed = false;
  }
  async commit() {
    if (this.failed) throw Error("Journal ownership was lost.");
    const path = join(this.dir, randomUUID() + ".sqlite");
    try {
      await backup(this.journal.db, path);
      this.etag = await this.store.write(
        envelope(await readFile(path), this.context, this.revision + 1),
        this.etag,
      );
      this.revision++;
    } catch (e) {
      this.failed = true;
      throw e;
    } finally {
      await rm(path, { force: true });
    }
  }
  async broadcast(rpc, job) {
    if (this.failed) throw Error("Journal ownership was lost.");
    const saved = this.journal.db
      .prepare("SELECT * FROM jobs WHERE id=? AND status='pending'")
      .get(job.id);
    if (!saved || saved.wire !== job.wire || saved.signature !== job.signature)
      throw Error("No exact durable outbox entry.");
    await this.commit();
    const signature = await rpc.sendRawTransaction(
      Buffer.from(job.wire, "base64"),
      { skipPreflight: false, maxRetries: 0 },
    );
    if (signature !== job.signature)
      throw Error("Broadcast returned a mismatched signature.");
  }
  async close() {
    this.journal.close();
    await rm(this.dir, { recursive: true, force: true });
  }
}
