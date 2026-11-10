package ch.duartesantos.opengym

import android.content.SharedPreferences
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.PluginMethod
import org.json.JSONObject

@CapacitorPlugin(name = "NativePasskey")
class NativePasskeyPlugin : Plugin() {

    private var encryptedPrefs: SharedPreferences? = null

    @Synchronized
    private fun getEncryptedPrefs(): SharedPreferences {
        encryptedPrefs?.let { return it }
        val ctx = context ?: activity?.applicationContext ?: throw IllegalStateException("Context unavailable")
        val masterKey = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        val prefs = EncryptedSharedPreferences.create(
            ctx,
            "opengym_secure_tokens",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        encryptedPrefs = prefs
        return prefs
    }

    @PluginMethod
    fun setToken(call: PluginCall) {
        val token = call.getString("token") ?: call.getString("value")
        val key = call.getString("key") ?: "auth_token"
        if (token == null) {
            call.reject("Token is required", "INVALID_ARGUMENT")
            return
        }
        try {
            getEncryptedPrefs().edit().putString(key, token).apply()
            val ret = JSObject()
            ret.put("success", true)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Failed to set token: ${e.message}", "STORAGE_ERROR", e)
        }
    }

    @PluginMethod
    fun getToken(call: PluginCall) {
        val key = call.getString("key") ?: "auth_token"
        try {
            val token = getEncryptedPrefs().getString(key, null)
            val ret = JSObject()
            if (token != null) {
                ret.put("token", token)
                ret.put("value", token)
            } else {
                ret.put("token", JSONObject.NULL)
                ret.put("value", JSONObject.NULL)
            }
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Failed to get token: ${e.message}", "STORAGE_ERROR", e)
        }
    }

    @PluginMethod
    fun clearToken(call: PluginCall) {
        val key = call.getString("key") ?: "auth_token"
        try {
            getEncryptedPrefs().edit().remove(key).apply()
            val ret = JSObject()
            ret.put("success", true)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Failed to clear token: ${e.message}", "STORAGE_ERROR", e)
        }
    }

    @PluginMethod
    fun register(call: PluginCall) {
        executeCreateCredential(call)
    }

    @PluginMethod
    fun create(call: PluginCall) {
        executeCreateCredential(call)
    }

    @PluginMethod
    fun createCredential(call: PluginCall) {
        executeCreateCredential(call)
    }

    @PluginMethod
    fun login(call: PluginCall) {
        executeGetCredential(call)
    }

    @PluginMethod
    fun getCredential(call: PluginCall) {
        executeGetCredential(call)
    }

    @PluginMethod
    fun get(call: PluginCall) {
        executeGetCredential(call)
    }

    @PluginMethod
    fun signIn(call: PluginCall) {
        executeGetCredential(call)
    }

    private fun executeCreateCredential(call: PluginCall) {
        val currentActivity = activity ?: run {
            call.reject("Activity unavailable", "ACTIVITY_UNAVAILABLE")
            return
        }

        val requestJson = extractRequestJson(call) ?: run {
            call.reject("Missing registration options JSON", "INVALID_OPTIONS")
            return
        }

        val credentialManager = CredentialManager.create(currentActivity)
        val createPublicKeyCredentialRequest = CreatePublicKeyCredentialRequest(requestJson)

        credentialManager.createCredentialAsync(
            currentActivity,
            createPublicKeyCredentialRequest,
            null,
            ContextCompat.getMainExecutor(currentActivity),
            object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                override fun onResult(result: CreateCredentialResponse) {
                    if (result is CreatePublicKeyCredentialResponse) {
                        resolveCredentialJson(call, result.registrationResponseJson)
                    } else {
                        call.reject("Unexpected credential type: ${result::class.java.name}", "UNEXPECTED_CREDENTIAL_TYPE")
                    }
                }

                override fun onError(e: CreateCredentialException) {
                    when (e) {
                        is CreateCredentialCancellationException -> {
                            call.reject("USER_CANCELLED", "USER_CANCELLED", e)
                        }
                        else -> {
                            call.reject(e.message ?: "Passkey registration failed", "CREATE_CREDENTIAL_FAILED", e)
                        }
                    }
                }
            }
        )
    }

    private fun executeGetCredential(call: PluginCall) {
        val currentActivity = activity ?: run {
            call.reject("Activity unavailable", "ACTIVITY_UNAVAILABLE")
            return
        }

        val requestJson = extractRequestJson(call) ?: run {
            call.reject("Missing login options JSON", "INVALID_OPTIONS")
            return
        }

        val credentialManager = CredentialManager.create(currentActivity)
        val getPublicKeyCredentialOption = GetPublicKeyCredentialOption(requestJson)
        val getCredRequest = GetCredentialRequest.Builder()
            .addCredentialOption(getPublicKeyCredentialOption)
            .build()

        credentialManager.getCredentialAsync(
            currentActivity,
            getCredRequest,
            null,
            ContextCompat.getMainExecutor(currentActivity),
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val credential = result.credential
                    if (credential is PublicKeyCredential) {
                        resolveCredentialJson(call, credential.authenticationResponseJson)
                    } else {
                        call.reject("Unexpected credential type: ${credential::class.java.name}", "UNEXPECTED_CREDENTIAL_TYPE")
                    }
                }

                override fun onError(e: GetCredentialException) {
                    when (e) {
                        is GetCredentialCancellationException -> {
                            call.reject("USER_CANCELLED", "USER_CANCELLED", e)
                        }
                        is NoCredentialException -> {
                            call.reject("NO_CREDENTIAL", "NO_CREDENTIAL", e)
                        }
                        else -> {
                            call.reject(e.message ?: "Passkey authentication failed", "GET_CREDENTIAL_FAILED", e)
                        }
                    }
                }
            }
        )
    }

    private fun resolveCredentialJson(call: PluginCall, responseJson: String) {
        try {
            val credObj = JSObject(responseJson)
            val ret = JSObject()
            ret.put("credential", credObj)
            ret.put("responseJson", responseJson)
            val keys = credObj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                ret.put(key, credObj.get(key))
            }
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Failed to parse credential response: ${e.message}", "PARSE_ERROR", e)
        }
    }

    private fun extractRequestJson(call: PluginCall): String? {
        val optObj = try { call.getObject("options") } catch (_: Exception) { null }
        if (optObj != null && optObj.length() > 0) {
            return optObj.toString()
        }
        val optStr = try { call.getString("options") } catch (_: Exception) { null }
        if (!optStr.isNullOrBlank()) {
            return optStr
        }
        val reqJson = try { call.getString("requestJson") } catch (_: Exception) { null }
        if (!reqJson.isNullOrBlank()) {
            return reqJson
        }
        val data = call.data
        if (data != null && data.length() > 0) {
            return data.toString()
        }
        return null
    }
}
