import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import type { TranscriptRecord } from "../../src/types";

const FORMAT = "delulu-encrypted-history";
const MAX_BYTES = 64 * 1024 * 1024;
const AAD = Buffer.from(`${FORMAT}:1:scrypt-16384-8-1:aes-256-gcm`);

function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value, "utf8") > 1024)
    throw new Error("Use a passphrase of at least 12 characters and at most 1,024 UTF-8 bytes.");
  return value;
}
function keyFor(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validRecords(value: unknown): TranscriptRecord[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Backup must contain at most 500 saved history records.");
  const ids = new Set<string>();
  for (const record of value) {
    if (!object(record) || typeof record.id !== "string" || !record.id || record.id.length > 128 || ids.has(record.id) ||
        typeof record.text !== "string" || record.text.length > 500_000 ||
        typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) ||
        typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0 ||
        typeof record.model !== "string" || typeof record.language !== "string" ||
        !["dictation", "file"].includes(String(record.source)) ||
        (record.schemaVersion !== undefined && record.schemaVersion !== 1))
      throw new Error("Backup contains an invalid or unsupported transcript record.");
    for (const name of ["editedText", "personalizedText", "magicText"])
      if (record[name] != null && (typeof record[name] !== "string" || (record[name] as string).length > 500_000))
        throw new Error("Backup contains an invalid text variant.");
    ids.add(record.id);
  }
  return value as TranscriptRecord[];
}
function plainHistory(value: unknown): { format: "delulu-history-export"; version: 1; createdAt: string; records: TranscriptRecord[] } {
  if (!object(value) || value.format !== "delulu-history-export" || value.version !== 1 ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
    throw new Error("Unsupported history backup schema.");
  return { format: "delulu-history-export", version: 1, createdAt: value.createdAt, records: validRecords(value.records) };
}
function bytes(value: unknown, expected?: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("Invalid backup encoding.");
  const decoded = Buffer.from(value, "base64");
  if ((expected !== undefined && decoded.length !== expected) || decoded.length > MAX_BYTES)
    throw new Error("Invalid backup field size.");
  return decoded;
}

export async function encryptHistory(records: TranscriptRecord[], passphrase: unknown): Promise<string> {
  const secret = password(passphrase);
  const payload = Buffer.from(JSON.stringify(plainHistory({
    format: "delulu-history-export", version: 1, createdAt: new Date().toISOString(), records,
  })), "utf8");
  if (payload.length > MAX_BYTES) throw new Error("History exceeds the 64 MB encrypted-export limit.");
  const salt = randomBytes(24), iv = randomBytes(12);
  const key = await keyFor(secret, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return JSON.stringify({ format: FORMAT, version: 1, kdf: "scrypt-16384-8-1", cipher: "aes-256-gcm",
      salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64") });
  } finally { key.fill(0); payload.fill(0); }
}

export async function decryptHistory(encoded: string, passphrase: unknown): Promise<string> {
  const secret = password(passphrase);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES * 1.4)
    throw new Error("Encrypted backup exceeds the supported size.");
  const envelope: unknown = JSON.parse(encoded);
  if (!object(envelope) || envelope.format !== FORMAT || envelope.version !== 1 ||
      envelope.kdf !== "scrypt-16384-8-1" || envelope.cipher !== "aes-256-gcm")
    throw new Error("Unsupported encrypted backup format or version.");
  const salt = bytes(envelope.salt, 24), iv = bytes(envelope.iv, 12), tag = bytes(envelope.tag, 16);
  const ciphertext = bytes(envelope.ciphertext);
  const key = await keyFor(secret, salt);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
    catch { throw new Error("The passphrase is incorrect or the encrypted backup was changed. Nothing was restored."); }
    const history = plainHistory(JSON.parse(plaintext.toString("utf8")));
    return `${JSON.stringify(history, null, 2)}\n`;
  } finally { key.fill(0); plaintext?.fill(0); }
}
