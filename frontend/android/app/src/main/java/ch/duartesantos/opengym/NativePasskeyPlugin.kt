package ch.duartesantos.opengym

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
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.PluginMethod

@CapacitorPlugin(name = "NativePasskey")
class NativePasskeyPlugin : Plugin() {

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
