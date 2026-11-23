package ch.duartesantos.opengym

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class BackgroundLocationService : Service(), LocationListener {

    companion object {
        const val CHANNEL_ID = "opengym_cardio_tracking"
        const val NOTIFICATION_ID = 4201
        var onLocationUpdate: ((Location) -> Unit)? = null
        var onLocationError: ((String) -> Unit)? = null
    }

    private var locationManager: LocationManager? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "opengym:cardio_gps").apply {
            setReferenceCounted(false)
        }
    }

    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        wakeLock?.let {
            if (!it.isHeld) it.acquire(4 * 60 * 60 * 1000L) // max 4h safety cap
        }

        try {
            if (locationManager == null) {
                locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            }
            locationManager?.removeUpdates(this)
            val provider = when {
                locationManager?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true -> LocationManager.GPS_PROVIDER
                locationManager?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true -> LocationManager.NETWORK_PROVIDER
                else -> LocationManager.GPS_PROVIDER
            }
            locationManager?.requestLocationUpdates(
                provider,
                1000L,
                0f,
                this,
                Looper.getMainLooper()
            )
        } catch (e: SecurityException) {
            onLocationError?.invoke("Location permission denied")
            stopSelf()
        } catch (e: Exception) {
            onLocationError?.invoke(e.message ?: "Failed to start GPS")
        }

        return START_STICKY
    }

    override fun onLocationChanged(location: Location) {
        onLocationUpdate?.invoke(location)
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}

    override fun onProviderDisabled(provider: String) {
        onLocationError?.invoke("GPS provider disabled")
    }

    override fun onDestroy() {
        try {
            locationManager?.removeUpdates(this)
        } catch (_: Exception) {}
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Cardio GPS Tracking",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps GPS tracking active while recording a run or ride"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("openGym")
            .setContentText("Recording GPS cardio session")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .apply { pendingIntent?.let { setContentIntent(it) } }
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
