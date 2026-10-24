package com.andreavecchia.evplanner

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

// Sincronizza i viaggi ogni 8 ore, anche con l'app chiusa (lo pianifica il sistema Android).
class TripWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        TripLog.sync(applicationContext)
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "trip-sync"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<TripWorker>(8, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
