import CryptoKit
import Foundation

/**
 * A node's Ed25519 signature under the strict rule (the lead's word of 27 November 2026), as core holds it
 * (`packages/core/src/crypto.ts` verifyEd25519Strict) and the Android app does: A and R are canonical encodings of points
 * of the prime-order subgroup, neither the identity; S < L; and [S]B = R + [k]A with k = SHA-512(R || A || M). The parity
 * vectors (RFC 8032's 5 and all 210 of Wycheproof's, each with core's answer) hold it to the same answers. Verify only, on
 * public data, so variable time is no leak.
 *
 * The rule's checks are made here, then CryptoKit checks the equation (`verify`). Measured on the vectors, CryptoKit
 * alone takes the 29 Wycheproof calls acceptable (its 8 small-order and 21 mixed-order keys), which the rule refuses;
 * after the checks it agrees with core on all 215. `verifyPure` checks the equation here too: the tests hold both to the
 * vectors, so nothing rests on how CryptoKit reads one.
 */
enum Ed25519Strict {
    /// Whether `signature` is the strict signature of `message` by `publicKey` (32 bytes): the rule's checks, then CryptoKit.
    static func verify(signature: Data, message: Data, publicKey: Data) -> Bool {
        guard signature.count == 64, publicKey.count == 32, isStrictPoint(publicKey), isStrictPoint(signature.prefix(32)),
              isBelowL([UInt8](signature.suffix(32))), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    /// The same, with the equation checked here (the tests' cross-check of CryptoKit).
    static func verifyPure(signature: Data, message: Data, publicKey: Data) -> Bool {
        guard signature.count == 64, publicKey.count == 32 else { return false }
        let sig = [UInt8](signature), key = [UInt8](publicKey)
        guard let a = strictPoint(key), let r = strictPoint(Array(sig[0..<32])) else { return false }
        let s = Array(sig[32..<64])
        guard isBelowL(s) else { return false }
        let k = [UInt8](SHA512.hash(data: Data(sig[0..<32]) + publicKey + message))
        // [S]B == R + [k]A. (A is in the prime-order subgroup, so [k]A is [k mod L]A: k needn't be reduced.)
        return Point.base.times(s).equals(r.plus(a.times(k)))
    }

    /// Whether 32 bytes are a point the rule takes for a key or a signature's R: canonical, of the prime-order subgroup,
    /// and not the identity (core's strictEd25519Point).
    static func isStrictPoint(_ bytes: Data) -> Bool { bytes.count == 32 && strictPoint([UInt8](bytes)) != nil }

    private static func strictPoint(_ bytes: [UInt8]) -> Point? {
        guard let point = Point.decode(bytes), !point.isIdentity, point.times(Self.l).isIdentity else { return nil }
        return point
    }

    /// L = 2^252 + 27742317777372353535851937790883648493, little-endian: the prime order of the base point.
    static let l: [UInt8] = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]

    /// Whether a 32-byte little-endian scalar is below L.
    static func isBelowL(_ s: [UInt8]) -> Bool {
        for i in stride(from: 31, through: 0, by: -1) where s[i] != l[i] { return s[i] < l[i] }
        return false
    }
}

/// An element of GF(2^255 - 19): four 64-bit limbs, least significant first, always reduced below p.
private struct Fe: Equatable {
    var w0: UInt64, w1: UInt64, w2: UInt64, w3: UInt64

    static let zero = Fe(w0: 0, w1: 0, w2: 0, w3: 0)
    static let one = Fe(w0: 1, w1: 0, w2: 0, w3: 0)
    /// p = 2^255 - 19, as limbs.
    static let pLimbs: (UInt64, UInt64, UInt64, UInt64) = (0xffff_ffff_ffff_ffed, 0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0x7fff_ffff_ffff_ffff)
    /// The exponents: p - 2 (an inverse), (p + 3)/8 = 2^252 - 2 (a square root's candidate), (p - 1)/4 = 2^253 - 5 (sqrt(-1)).
    static let inverseExponent: [UInt64] = [0xffff_ffff_ffff_ffeb, 0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0x7fff_ffff_ffff_ffff]
    static let rootExponent: [UInt64] = [0xffff_ffff_ffff_fffe, 0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0x0fff_ffff_ffff_ffff]
    static let quarterExponent: [UInt64] = [0xffff_ffff_ffff_fffb, 0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0x1fff_ffff_ffff_ffff]
    /// d = -121665/121666, and sqrt(-1) = 2^((p-1)/4): the curve's constant, and the root decoding needs.
    static let d = Fe.small(121_665).negated.times(Fe.small(121_666).inverse)
    static let d2 = d.plus(d)
    static let sqrtMinusOne = Fe.small(2).power(quarterExponent)

    static func small(_ n: UInt64) -> Fe { Fe(w0: n, w1: 0, w2: 0, w3: 0) }

    /// 32 little-endian bytes as they are (nil: not below p, a value written past it: never taken).
    static func canonical(_ b: [UInt8]) -> Fe? {
        func limb(_ i: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { $0 | (UInt64(b[i * 8 + $1]) << (8 * UInt64($1))) } }
        let x = Fe(w0: limb(0), w1: limb(1), w2: limb(2), w3: limb(3))
        return below(x.w0, x.w1, x.w2, x.w3) ? x : nil
    }

    /// Whether a 256-bit value is below p.
    private static func below(_ a0: UInt64, _ a1: UInt64, _ a2: UInt64, _ a3: UInt64) -> Bool {
        if a3 != pLimbs.3 { return a3 < pLimbs.3 }
        if a2 != pLimbs.2 { return a2 < pLimbs.2 }
        if a1 != pLimbs.1 { return a1 < pLimbs.1 }
        return a0 < pLimbs.0
    }

    var isOdd: Bool { w0 & 1 == 1 }
    var isZero: Bool { self == .zero }

    /// A value below 2^256, reduced below p: 2^255 is 19 mod p, and what is left is below 2p.
    private static func reduced(_ a0: UInt64, _ a1: UInt64, _ a2: UInt64, _ a3: UInt64) -> Fe {
        var (r0, r1, r2, r3) = (a0, a1, a2, a3 & 0x7fff_ffff_ffff_ffff)
        var o = false
        (r0, o) = r0.addingReportingOverflow((a3 >> 63) * 19)
        if o { (r1, o) = r1.addingReportingOverflow(1) }
        if o { (r2, o) = r2.addingReportingOverflow(1) }
        if o { r3 &+= 1 }
        if below(r0, r1, r2, r3) { return Fe(w0: r0, w1: r1, w2: r2, w3: r3) }
        // Below 2p: once p less is below p.
        var borrow: UInt64 = 0
        (r0, borrow) = sub(r0, pLimbs.0, 0)
        (r1, borrow) = sub(r1, pLimbs.1, borrow)
        (r2, borrow) = sub(r2, pLimbs.2, borrow)
        (r3, _) = sub(r3, pLimbs.3, borrow)
        return Fe(w0: r0, w1: r1, w2: r2, w3: r3)
    }

    /// x + y + carry, and the carry out.
    @inline(__always) private static func add(_ x: UInt64, _ y: UInt64, _ carry: UInt64) -> (UInt64, UInt64) {
        let (s1, o1) = x.addingReportingOverflow(y)
        let (s2, o2) = s1.addingReportingOverflow(carry)
        return (s2, (o1 ? 1 : 0) + (o2 ? 1 : 0))
    }

    /// x - y - borrow, and the borrow out.
    @inline(__always) private static func sub(_ x: UInt64, _ y: UInt64, _ borrow: UInt64) -> (UInt64, UInt64) {
        let (d1, o1) = x.subtractingReportingOverflow(y)
        let (d2, o2) = d1.subtractingReportingOverflow(borrow)
        return (d2, (o1 ? 1 : 0) + (o2 ? 1 : 0))
    }

    func plus(_ y: Fe) -> Fe {
        // Both below p < 2^255: the sum is below 2^256, with no carry out.
        var c: UInt64 = 0, r0: UInt64, r1: UInt64, r2: UInt64, r3: UInt64
        (r0, c) = Fe.add(w0, y.w0, 0)
        (r1, c) = Fe.add(w1, y.w1, c)
        (r2, c) = Fe.add(w2, y.w2, c)
        (r3, _) = Fe.add(w3, y.w3, c)
        return Fe.reduced(r0, r1, r2, r3)
    }

    func minus(_ y: Fe) -> Fe {
        var b: UInt64 = 0, r0: UInt64, r1: UInt64, r2: UInt64, r3: UInt64
        (r0, b) = Fe.sub(w0, y.w0, 0)
        (r1, b) = Fe.sub(w1, y.w1, b)
        (r2, b) = Fe.sub(w2, y.w2, b)
        (r3, b) = Fe.sub(w3, y.w3, b)
        guard b != 0 else { return Fe(w0: r0, w1: r1, w2: r2, w3: r3) }
        // Below zero, and above -p: p more is below p.
        var c: UInt64 = 0
        (r0, c) = Fe.add(r0, Fe.pLimbs.0, 0)
        (r1, c) = Fe.add(r1, Fe.pLimbs.1, c)
        (r2, c) = Fe.add(r2, Fe.pLimbs.2, c)
        (r3, _) = Fe.add(r3, Fe.pLimbs.3, c)
        return Fe(w0: r0, w1: r1, w2: r2, w3: r3)
    }

    var negated: Fe { Fe.zero.minus(self) }

    func times(_ y: Fe) -> Fe {
        let a = (w0, w1, w2, w3), b = (y.w0, y.w1, y.w2, y.w3)
        var t = (UInt64(0), UInt64(0), UInt64(0), UInt64(0), UInt64(0), UInt64(0), UInt64(0), UInt64(0))
        withUnsafeMutableBytes(of: &t) { raw in
            let t = raw.bindMemory(to: UInt64.self)
            let x = [a.0, a.1, a.2, a.3], z = [b.0, b.1, b.2, b.3]
            for i in 0..<4 {
                var carry: UInt64 = 0
                for j in 0..<4 {
                    let (hi, lo) = x[i].multipliedFullWidth(by: z[j])
                    let (s1, o1) = t[i + j].addingReportingOverflow(lo)
                    let (s2, o2) = s1.addingReportingOverflow(carry)
                    t[i + j] = s2
                    carry = hi &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
                }
                t[i + 4] = carry
            }
        }
        // 2^256 is 38 mod p: the high half, times 38, folds into the low half; what that carries folds again.
        var r = (t.0, t.1, t.2, t.3), carry: UInt64 = 0
        func fold(_ low: UInt64, _ high: UInt64, _ carry: inout UInt64) -> UInt64 {
            let (hi, lo) = high.multipliedFullWidth(by: 38)
            let (s1, o1) = low.addingReportingOverflow(lo)
            let (s2, o2) = s1.addingReportingOverflow(carry)
            carry = hi &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
            return s2
        }
        r.0 = fold(r.0, t.4, &carry)
        r.1 = fold(r.1, t.5, &carry)
        r.2 = fold(r.2, t.6, &carry)
        r.3 = fold(r.3, t.7, &carry)
        var extra = carry &* 38
        while extra != 0 {
            var c: UInt64 = 0
            (r.0, c) = Fe.add(r.0, extra, 0)
            (r.1, c) = Fe.add(r.1, 0, c)
            (r.2, c) = Fe.add(r.2, 0, c)
            (r.3, c) = Fe.add(r.3, 0, c)
            extra = c &* 38
        }
        return Fe.reduced(r.0, r.1, r.2, r.3)
    }

    var squared: Fe { times(self) }

    /// self^e, e as little-endian 64-bit limbs.
    func power(_ e: [UInt64]) -> Fe {
        var result = Fe.one
        for limb in e.reversed() {
            for bit in stride(from: 63, through: 0, by: -1) {
                result = result.squared
                if (limb >> UInt64(bit)) & 1 == 1 { result = result.times(self) }
            }
        }
        return result
    }

    var inverse: Fe { power(Fe.inverseExponent) }
}

/// A point of the curve, in extended coordinates (X:Y:Z:T), x = X/Z, y = Y/Z, xy = T/Z (RFC 8032 §5.1.4).
private struct Point {
    let x: Fe, y: Fe, z: Fe, t: Fe

    static let identity = Point(x: .zero, y: .one, z: .one, t: .zero)
    /// The base point B: y = 4/5, x even (RFC 8032 §5.1).
    static let base = Point.decode([0x58] + [UInt8](repeating: 0x66, count: 31))!

    /// RFC 8032 §5.1.3, strictly: y below p, x recovered, and never x = 0 with x's sign bit set.
    static func decode(_ bytes: [UInt8]) -> Point? {
        guard bytes.count == 32 else { return nil }
        var b = bytes
        let sign = b[31] >> 7
        b[31] &= 0x7f
        guard let y = Fe.canonical(b) else { return nil }
        let yy = y.squared
        let u = yy.minus(.one), v = Fe.d.times(yy).plus(.one)
        // x = (u/v)^((p+3)/8), then x^2 v is u, or -u (then times sqrt(-1)), or there is no x.
        let candidate = u.times(v.inverse).power(Fe.rootExponent)
        let vxx = v.times(candidate.squared)
        var x: Fe
        if vxx == u {
            x = candidate
        } else if vxx == u.negated {
            x = candidate.times(.sqrtMinusOne)
        } else {
            return nil
        }
        if x.isZero && sign == 1 { return nil }
        if (x.isOdd ? 1 : 0) != sign { x = x.negated }
        return Point(x: x, y: y, z: .one, t: x.times(y))
    }

    var isIdentity: Bool { x.isZero && y == z }

    func equals(_ q: Point) -> Bool { x.times(q.z) == q.x.times(z) && y.times(q.z) == q.y.times(z) }

    func plus(_ q: Point) -> Point {
        let a = y.minus(x).times(q.y.minus(q.x))
        let b = y.plus(x).times(q.y.plus(q.x))
        let c = t.times(Fe.d2).times(q.t)
        let d = z.plus(z).times(q.z)
        let e = b.minus(a), f = d.minus(c), g = d.plus(c), h = b.plus(a)
        return Point(x: e.times(f), y: g.times(h), z: f.times(g), t: e.times(h))
    }

    /// [n]self, n a little-endian scalar of any length.
    func times(_ n: [UInt8]) -> Point {
        var result = Point.identity
        for byte in n.reversed() {
            for bit in stride(from: 7, through: 0, by: -1) {
                result = result.plus(result)
                if (byte >> UInt8(bit)) & 1 == 1 { result = result.plus(self) }
            }
        }
        return result
    }
}
