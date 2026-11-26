import { chacha20 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, type Bytes, utf8 } from "./bytes.ts";

/*
 * An incremental hash of a set of strings (event ids): LtHash (Bellare and Micciancio),
 * with the parameters Lewi, Kim, Maykov and Weis (2019) analyse for 200+ bits of security,
 * 1024 lanes of 16 bits. Each element is expanded into 1024 pseudo-random lanes; a set's
 * hash is their lane-wise sum mod 2^16. So adding or removing one element costs one
 * expansion, whatever the set's size, and the result never depends on the order.
 *
 * Sync uses it to compare what two replicas hold of one device's log without either
 * re-reading that log (see MindStore.deviceDigests). Two different sets reaching the same
 * hash would let a forked device stay hidden, which is why this isn't a plain XOR or sum
 * of hashes: those collide under Gaussian elimination or Wagner's generalized birthday.
 *
 * Expansion: ChaCha20 keystream (a fixed nonce, domain-separated) keyed by SHA-256 of the
 * element. Lanes are little-endian, so every platform computes the same bytes.
 */

const LANES = 1024;
export const SET_HASH_BYTES = LANES * 2;
const NONCE = utf8("galahad/set1"); // 12 bytes
const ZEROS = new Uint8Array(SET_HASH_BYTES);
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function expand(element: string): Bytes {
  return chacha20(sha256(utf8(element)), NONCE, ZEROS);
}

export class SetHash {
  private constructor(private readonly state: Uint8Array) {}

  static empty(): SetHash {
    return new SetHash(new Uint8Array(SET_HASH_BYTES));
  }

  /** From stored bytes (copied, so the stored value is never changed in place). */
  static from(bytes: Bytes): SetHash {
    if (bytes.length !== SET_HASH_BYTES) throw new Error(`a set hash is ${SET_HASH_BYTES} bytes, not ${bytes.length}`);
    return new SetHash(Uint8Array.from(bytes));
  }

  static of(elements: Iterable<string>): SetHash {
    const hash = SetHash.empty();
    for (const element of elements) hash.add(element);
    return hash;
  }

  add(element: string): this {
    return this.mix(expand(element), 1);
  }

  remove(element: string): this {
    return this.mix(expand(element), -1);
  }

  /** Add every element of another hash (the hash of the two sets together, as multisets). */
  merge(other: SetHash): this {
    return this.mix(other.state, 1);
  }

  private mix(lanes: Bytes, sign: 1 | -1): this {
    const s = this.state;
    if (LITTLE_ENDIAN && s.byteOffset % 2 === 0 && lanes.byteOffset % 2 === 0) {
      // The same arithmetic, a lane at a time: a Uint16Array wraps mod 2^16 on its own.
      const a = new Uint16Array(s.buffer, s.byteOffset, LANES);
      const b = new Uint16Array(lanes.buffer, lanes.byteOffset, LANES);
      if (sign === 1) for (let i = 0; i < LANES; i++) a[i] = a[i]! + b[i]!;
      else for (let i = 0; i < LANES; i++) a[i] = a[i]! - b[i]!;
      return this;
    }
    for (let i = 0; i < SET_HASH_BYTES; i += 2) {
      const sum = (s[i]! | (s[i + 1]! << 8)) + sign * (lanes[i]! | (lanes[i + 1]! << 8));
      s[i] = sum & 0xff;
      s[i + 1] = (sum >>> 8) & 0xff;
    }
    return this;
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.state);
  }

  /** What two replicas compare: 32 bytes, base64url. */
  digest(): string {
    return b64u(sha256(this.state));
  }
}
