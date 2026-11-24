package ch.duartesantos.opengym

import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.view.Window
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SystemBars")
class SystemBarsPlugin : Plugin() {

    @Volatile
    private var lastIsLight: Boolean? = null

    @PluginMethod
    fun setStyle(call: PluginCall) {
        val theme = call.getString("theme")
        if (theme != "light" && theme != "dark") {
            call.reject("Invalid theme: expected 'light' or 'dark'")
            return
        }
        val isLight = theme == "light"
        lastIsLight = isLight

        val act = activity
        if (act == null || act.isFinishing || act.isDestroyed || act.window == null) {
            call.reject("Activity unavailable")
            return
        }

        act.runOnUiThread {
            val window = act.window
            if (act.isFinishing || act.isDestroyed || window == null) {
                call.reject("Activity unavailable")
                return@runOnUiThread
            }
            val controller = applySystemBars(window, isLight)
            val ret = JSObject().apply {
                put("theme", theme)
                put("isAppearanceLightStatusBars", controller.isAppearanceLightStatusBars)
                put("isAppearanceLightNavigationBars", controller.isAppearanceLightNavigationBars)
            }
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun getStyle(call: PluginCall) {
        val act = activity
        if (act == null || act.isFinishing || act.isDestroyed || act.window == null) {
            call.reject("Activity unavailable")
            return
        }

        act.runOnUiThread {
            val window = act.window
            if (act.isFinishing || act.isDestroyed || window == null) {
                call.reject("Activity unavailable")
                return@runOnUiThread
            }
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            val ret = JSObject().apply {
                put("isAppearanceLightStatusBars", controller.isAppearanceLightStatusBars)
                put("isAppearanceLightNavigationBars", controller.isAppearanceLightNavigationBars)
            }
            call.resolve(ret)
        }
    }

    override fun handleOnResume() {
        super.handleOnResume()
        reapplyLastStyle()
    }

    override fun handleOnConfigurationChanged(newConfig: Configuration) {
        super.handleOnConfigurationChanged(newConfig)
        reapplyLastStyle()
    }

    private fun reapplyLastStyle() {
        val isLight = lastIsLight ?: return
        val act = activity ?: return
        if (act.isFinishing || act.isDestroyed || act.window == null) return
        act.runOnUiThread {
            val window = act.window
            if (!act.isFinishing && !act.isDestroyed && window != null) {
                applySystemBars(window, isLight)
            }
        }
    }

    private fun applySystemBars(window: Window, isLight: Boolean): WindowInsetsControllerCompat {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            val color = Color.parseColor(if (isLight) "#F6F6F3" else "#111315")
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            @Suppress("DEPRECATION")
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS)
            @Suppress("DEPRECATION")
            window.statusBarColor = color
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                @Suppress("DEPRECATION")
                window.navigationBarColor = color
            }
        }
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = isLight
        controller.isAppearanceLightNavigationBars = isLight
        return controller
    }
}
