// Storico viaggi EV Planner su Google Sheets.
//
// Installazione (una volta sola):
// 1. Usa il foglio Google "EV Planner - Viaggi" nella tua Drive (intestazioni già presenti).
// 2. Estensioni → Apps Script, incolla questo file e salva.
// 3. Impostazioni progetto → Proprietà dello script: aggiungi SECRET con una parola segreta a tua scelta.
// 4. Implementa → Nuova implementazione → tipo "App web": Esegui come "Me", Accesso "Chiunque".
// 5. Copia l'URL dell'app web e incollalo nella pagina di EV Planner, con la stessa parola segreta.

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  const body = JSON.parse(e.postData.contents);
  if (!secret || body.secret !== secret) return reply({ ok: false, error: 'forbidden' });

  // Primo foglio del file: nel foglio "EV Planner - Viaggi" sono già scritte le intestazioni.
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const headers = Object.keys(body.row);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  sheet.appendRow(headers.map((h) => body.row[h]));
  return reply({ ok: true });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
