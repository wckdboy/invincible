package sh.invincible.bot.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * This phone's device key: ECDSA P-256 in Android's Keystore, made in its secure hardware (StrongBox where the phone
 * has one, else the TEE) and never exportable, as the Apple app's lives in the Secure Enclave. Its public point is the
 * device's id. Nothing of it is backed up or carried to another phone (data_extraction.xml): a new phone pairs anew.
 */
class DeviceKey private constructor(private val key: PrivateKey, override val device: String) : Signer {
    override fun sign(message: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(message)
            EcdsaSignature.rawFromDer(sign())
        }

    companion object {
        const val ALIAS = "sh.invincible.bot.device-key"

        private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        /** The key this phone made before, if it did. */
        fun load(): DeviceKey? {
            val ks = store()
            val key = ks.getKey(ALIAS, null) as? PrivateKey ?: return null
            val public = ks.getCertificate(ALIAS)?.publicKey ?: return null
            return DeviceKey(key, RequestAuth.deviceOf(public.encoded))
        }

        fun loadOrCreate(): DeviceKey = load() ?: create()

        /** A fresh key (a phone that forgot its node makes another: the old id is no longer this phone's). */
        fun create(): DeviceKey {
            store().deleteEntry(ALIAS)
            return try {
                make(strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
                make(strongBox = false)
            }
        }

        fun forget() = store().deleteEntry(ALIAS)

        private fun make(strongBox: Boolean): DeviceKey {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setIsStrongBoxBacked(strongBox)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
                initialize(spec)
                generateKeyPair()
            }
            return requireNotNull(load()) { "the Keystore made no key" }
        }
    }
}
