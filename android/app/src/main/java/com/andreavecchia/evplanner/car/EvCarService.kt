package com.andreavecchia.evplanner.car

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

// Servizio per Android Auto. Per ora mostra un messaggio: la guida turn-by-turn sull'auto
// arriva nel prossimo passo, dopo la verifica del collegamento con il telefono.
class EvCarService : CarAppService() {

    override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(): Session = EvSession()
}
