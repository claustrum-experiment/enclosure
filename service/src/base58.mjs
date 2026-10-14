// Bitcoin/Solana base58, no dependencies.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decode(str) {
  if (typeof str !== "string" || str.length === 0) throw new Error("base58: empty input");
  const bytes = [0];
  for (const ch of str) {
    const v = MAP.get(ch);
    if (v === undefined) throw new Error(`base58: invalid character "${ch}"`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

export function encode(buf) {
  const bytes = [...buf];
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return bytes.every((b) => b === 0) ? "1".repeat(bytes.length) : out;
}

/** A Solana address: base58 that decodes to exactly 32 bytes, not all zero. */
export function isPubkey(str) {
  try {
    const b = decode(str);
    return b.length === 32 && b.some((x) => x !== 0);
  } catch {
    return false;
  }
}
