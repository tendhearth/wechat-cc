import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { makeInputJournal } from '../state/input-journal'

/** Same existing Keychain service/access policy; no extra native dependency or plaintext file. */
export const inputJournal = makeInputJournal(SecureStore, text => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text), {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
})
