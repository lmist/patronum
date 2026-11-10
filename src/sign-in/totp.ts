import crypto from "node:crypto";

/**
 * RFC 6238 TOTP (same algorithm as Google Authenticator / Authy).
 * TOTP helper for Instagram authenticator 2FA (optional).
 */
export function generateTOTP(secret: string, window = 0): string {
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  let hex = "";

  secret = secret.toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");

  for (let i = 0; i < secret.length; i++) {
    const val = base32chars.indexOf(secret.charAt(i));
    if (val === -1) throw new Error("Invalid base32 character in TOTP secret");
    bits += val.toString(2).padStart(5, "0");
  }

  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const chunk = bits.substr(i, 4);
    hex += parseInt(chunk, 2).toString(16);
  }

  const secretBuffer = Buffer.from(hex, "hex");
  const time = Math.floor(Date.now() / 1000 / 30) + window;
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time));

  const hmac = crypto.createHmac("sha1", secretBuffer);
  hmac.update(timeBuffer);
  const hmacResult = hmac.digest();

  const offset = hmacResult[hmacResult.length - 1]! & 0xf;
  const code =
    ((hmacResult[offset]! & 0x7f) << 24) |
    ((hmacResult[offset + 1]! & 0xff) << 16) |
    ((hmacResult[offset + 2]! & 0xff) << 8) |
    (hmacResult[offset + 3]! & 0xff);

  return (code % 1_000_000).toString().padStart(6, "0");
}

/** Seconds remaining in the current 30s TOTP window. */
export function totpSecondsLeft(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}
