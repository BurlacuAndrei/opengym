package ch.duartesantos.opengym

import android.Manifest
import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "BackgroundLocation",
    permissions = [
        Permission(
            alias = "location",
            strings = [
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ]
        )
    ]
)
class BackgroundLocationPlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermsCallback")
            return
        }
        startLocationService()
        call.resolve()
    }

    @PermissionCallback
    private fun locationPermsCallback(call: PluginCall) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            startLocationService()
            call.resolve()
        } else {
            call.reject("Location permission denied")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        BackgroundLocationService.onLocationUpdate = null
        BackgroundLocationService.onLocationError = null
        val intent = Intent(context, BackgroundLocationService::class.java)
        context.stopService(intent)
        call.resolve()
    }

    private fun startLocationService() {
        BackgroundLocationService.onLocationUpdate = { loc ->
            val data = JSObject().apply {
                put("latitude", loc.latitude)
                put("longitude", loc.longitude)
                put("accuracy", loc.accuracy.toDouble())
                put("altitude", if (loc.hasAltitude()) loc.altitude else null)
                put("speed", if (loc.hasSpeed()) loc.speed.toDouble() else 0.0)
                put("heading", if (loc.hasBearing()) loc.bearing.toDouble() else null)
                put("timestamp", loc.time)
            }
            notifyListeners("location", data)
        }
        BackgroundLocationService.onLocationError = { msg ->
            val data = JSObject().apply {
                put("message", msg)
            }
            notifyListeners("locationError", data)
        }

        val intent = Intent(context, BackgroundLocationService::class.java)
        ContextCompat.startForegroundService(context, intent)
    }
}
