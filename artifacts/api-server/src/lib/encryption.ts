import crypto from "crypto";

// Use JWT_SECRET to derive a 256-bit key for AES-256 encryption.
const ENCRYPTION_KEY = process.env.JWT_SECRET
  ? crypto.createHash("sha256").update(process.env.JWT_SECRET).digest()
  : Buffer.from("super-secret-key-32-bytes-long-fallback!", "utf-8"); // 32 bytes key

const IV_LENGTH = 16; // For AES, this is always 16

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text: string): string {
  const textParts = text.split(":");
  const ivStr = textParts.shift();
  if (!ivStr) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(ivStr, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}
