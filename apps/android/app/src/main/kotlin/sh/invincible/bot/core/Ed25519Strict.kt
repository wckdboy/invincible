package sh.invincible.bot.core

import java.math.BigInteger
import java.security.MessageDigest

/**
 * A node's Ed25519 signature under the strict rule (the lead's word of 27 November 2026), as core holds it
 * (packages/core/src/crypto.ts verifyEd25519Strict) and the Apple app does: A and R are canonical encodings of points of
 * the prime-order subgroup, neither the identity; S < L; and [S]B = R + [k]A with k = SHA-512(R ‖ A ‖ M). In Kotlin
 * alone, verify only, and the same on every Android version: the platform has Ed25519 from API 33 only, and isn't used
 * there either, so every phone answers alike, with no new dependency. The parity vectors (RFC 8032's 5 and all 210 of
 * Wycheproof's, each with core's answer) hold it to core's answers. On public data, so variable time is no leak.
 */
object Ed25519Strict {
    private val TWO = BigInteger.valueOf(2)
    private val P: BigInteger = TWO.pow(255) - BigInteger.valueOf(19)
    /** The base point's prime order: 2^252 + 27742317777372353535851937790883648493. */
    private val L: BigInteger = TWO.pow(252) + BigInteger("27742317777372353535851937790883648493")
    private val D: BigInteger = (BigInteger.valueOf(-121665) * BigInteger.valueOf(121666).modInverse(P)).mod(P)
    private val D2: BigInteger = (D * TWO).mod(P)
    private val SQRT_M1: BigInteger = TWO.modPow((P - BigInteger.ONE) / BigInteger.valueOf(4), P)

    /** A point in extended coordinates (X:Y:Z:T), x = X/Z, y = Y/Z, xy = T/Z (RFC 8032 §5.1.4). */
    private class Point(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger) {
        val isIdentity: Boolean get() = x.mod(P).signum() == 0 && y.mod(P) == z.mod(P)

        fun sameAs(q: Point): Boolean = (x * q.z - q.x * z).mod(P).signum() == 0 && (y * q.z - q.y * z).mod(P).signum() == 0

        operator fun plus(q: Point): Point {
            val a = ((y - x) * (q.y - q.x)).mod(P)
            val b = ((y + x) * (q.y + q.x)).mod(P)
            val c = (t * D2 % P * q.t).mod(P)
            val d = (z * TWO * q.z).mod(P)
            val e = (b - a).mod(P)
            val f = (d - c).mod(P)
            val g = (d + c).mod(P)
            val h = (b + a).mod(P)
            return Point((e * f).mod(P), (g * h).mod(P), (f * g).mod(P), (e * h).mod(P))
        }

        fun times(n: BigInteger): Point {
            var result = IDENTITY
            for (i in n.bitLength() - 1 downTo 0) {
                result += result
                if (n.testBit(i)) result += this
            }
            return result
        }
    }

    private val IDENTITY = Point(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
    /** The base point B: y = 4/5, x even (RFC 8032 §5.1). */
    private val BASE: Point = decode(ByteArray(32) { if (it == 0) 0x58 else 0x66 })!!

    private fun littleEndian(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

    /** RFC 8032 §5.1.3, strictly: y below p, x recovered, and never x = 0 with x's sign bit set. */
    private fun decode(bytes: ByteArray): Point? {
        if (bytes.size != 32) return null
        val sign = (bytes[31].toInt() shr 7) and 1
        val y = littleEndian(bytes.copyOf().also { it[31] = (it[31].toInt() and 0x7f).toByte() })
        if (y >= P) return null
        val yy = (y * y).mod(P)
        val u = (yy - BigInteger.ONE).mod(P)
        val v = (D * yy + BigInteger.ONE).mod(P)
        // x = u v^3 (u v^7)^((p-5)/8); then v x^2 is u, or -u (and x times sqrt(-1) is the root), or there is no x.
        val v3 = v.modPow(BigInteger.valueOf(3), P)
        val v7 = v.modPow(BigInteger.valueOf(7), P)
        var x = (u * v3 % P * (u * v7 % P).modPow((P - BigInteger.valueOf(5)) / BigInteger.valueOf(8), P)).mod(P)
        val vxx = (v * x % P * x).mod(P)
        when (vxx) {
            u -> {}
            (P - u).mod(P) -> x = (x * SQRT_M1).mod(P)
            else -> return null
        }
        if (x.signum() == 0 && sign == 1) return null
        if (x.testBit(0) != (sign == 1)) x = (P - x).mod(P)
        return Point(x, y, BigInteger.ONE, (x * y).mod(P))
    }

    private fun strictPoint(bytes: ByteArray): Point? {
        val point = decode(bytes) ?: return null
        return if (!point.isIdentity && point.times(L).isIdentity) point else null
    }

    /** Whether 32 bytes are a point the rule takes for a key or a signature's R (core's strictEd25519Point). */
    fun isStrictPoint(bytes: ByteArray): Boolean = bytes.size == 32 && strictPoint(bytes) != null

    /** Whether [signature] is the strict signature of [message] by [publicKey]. */
    fun verify(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean {
        if (signature.size != 64 || publicKey.size != 32) return false
        val a = strictPoint(publicKey) ?: return false
        val r = strictPoint(signature.copyOfRange(0, 32)) ?: return false
        val s = littleEndian(signature.copyOfRange(32, 64))
        if (s >= L) return false
        val h = MessageDigest.getInstance("SHA-512").run {
            update(signature, 0, 32)
            update(publicKey)
            update(message)
            digest()
        }
        val k = littleEndian(h).mod(L)
        return BASE.times(s).sameAs(r + a.times(k))
    }
}
