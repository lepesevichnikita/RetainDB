/**
 * The one definition of a repository-index grant token.
 *
 * The admin surface mints a token here and the repo-index router hashes the token it is shown
 * here; if those two ever compute different digests, every minted credential silently stops
 * working. Keeping both sides on this module is what makes the fixed-vector test meaningful.
 */
import { createHash, randomBytes } from "node:crypto";

/** Bytes of randomness behind a grant token: 16 bytes is the 128 bits this surface promises. */
const TOKEN_BYTES = 16;

export interface MintedGrantToken {
  token: string;
  tokenHash: string;
}

/** 128 random bits as hex, plus the digest of the plaintext. */
export function mintGrantToken(): MintedGrantToken {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  return { token, tokenHash: hashGrantToken(token) };
}

/** sha256 of the token's UTF-8 spelling as lowercase hex: the only form stored or looked up. */
export function hashGrantToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
