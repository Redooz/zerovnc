import { createCipheriv } from "node:crypto";

// VNC authentication (security type 2): encrypt the 16-byte server challenge
// with DES, using the password as the key. Each key byte has its bits reversed,
// and the key is zero-padded or truncated to 8 bytes.
export function vncAuthResponse(password: string, challenge: Uint8Array): Uint8Array {
  const key = new Uint8Array(8);
  for (let i = 0; i < Math.min(8, password.length); i++) {
    let byte = password.charCodeAt(i) & 0xff;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) {
      reversed = (reversed << 1) | (byte & 1);
      byte >>= 1;
    }
    key[i] = reversed;
  }
  const cipher = createCipheriv("des-ecb", key, null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(challenge), cipher.final()]));
}
