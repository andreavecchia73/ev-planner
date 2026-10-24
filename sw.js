// Service worker minimo: serve a rendere la pagina installabile. Nessuna cache: i dati restano sempre aggiornati.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
