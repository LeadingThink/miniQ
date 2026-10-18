// SHA-256 round constants from FIPS 180-4.
const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private pending = new Uint8Array(64);
  private pendingLength = 0;
  private length = 0;
  private words = new Uint32Array(64);
  update(bytes: Uint8Array) {
    this.length += bytes.length;
    let at = 0;
    if (this.pendingLength) {
      const take = Math.min(64 - this.pendingLength, bytes.length);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      at += take;
      if (this.pendingLength === 64) {
        this.block(this.pending);
        this.pendingLength = 0;
      }
      else
        return this;
    }
    while (at + 64 <= bytes.length) {
      this.block(bytes.subarray(at, at + 64));
      at += 64;
    }
    this.pending.set(bytes.subarray(at), 0);
    this.pendingLength = bytes.length - at;
    return this;
  }
  hex() {
    const pad = new Uint8Array(((this.pendingLength + 9 + 63) >> 6) << 6);
    pad.set(this.pending.subarray(0, this.pendingLength));
    pad[this.pendingLength] = 0x80;
    const bits = this.length * 8;
    new DataView(pad.buffer).setBigUint64(pad.byteLength - 8, BigInt(bits));
    for (let i = 0; i < pad.length; i += 64)
      this.block(pad.subarray(i, i + 64));
    return [...this.h].map(x => x.toString(16).padStart(8, "0")).join("");
  }
  private block(b: Uint8Array) {
    const w = this.words;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < 16; i++)
      w[i] = v.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 16] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10)) + w[i - 7]) >>> 0;
    }
    let [a, bb, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10), maj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + bb) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }
}
