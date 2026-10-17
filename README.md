# EV Planner

Pianificatore personale di viaggi elettrici con soste di ricarica. Web app statica
(HTML/CSS/JS senza build) pensata per uso personale.

## Avvio

Servi la cartella con un server statico (il modulo ES non funziona da `file://`):

    npx serve .
    # oppure
    python3 -m http.server 8080

Poi apri la pagina dal browser del telefono o del PC.

## Test

    npm test

## Come funziona

- **Percorso**: geocodifica con Nominatim, percorso stradale con OSRM (server demo pubblico).
- **Colonnine**: OpenChargeMap (chiave gratuita consigliata, facoltativa).
- **Consumo**: parte dal consumo misurato sulla tua auto (Wh/km), con correzioni euristiche
  per temperatura e velocità media. Le costanti sono in `MODEL` in `planner.js`.
- **Soste**: algoritmo greedy. Quando la riserva non basta per arrivare alla destinazione,
  sceglie la colonnina con potenza maggiore raggiungibile e ricarica fino alla soglia impostata.

## Limiti noti

- Il dislivello non è considerato nel consumo.
- La potenza media di ricarica è stimata come frazione del picco (`averageChargeFactor`).
- OSRM demo e Nominatim hanno limiti d'uso: va bene per uso personale, non per un servizio pubblico.
- Le colonnine vengono da OpenChargeMap e possono essere incomplete o non aggiornate.

## Idee per estendere

- Profilo del veicolo salvato in più versioni (es. inverno/estate).
- Dati di dislivello per correggere il consumo in salita e discesa.
- Service worker per uso offline e icona da installare sulla schermata home.
