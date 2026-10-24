// Storico viaggi EV Planner su Google Sheets.
//
// Installazione (una volta sola):
// 1. Crea un foglio Google nella tua Drive (es. "EV Planner - Viaggi").
// 2. Estensioni → Apps Script, incolla questo file e salva.
// 3. Impostazioni progetto → Proprietà dello script: aggiungi SECRET con una parola segreta a tua scelta.
// 4. Implementa → Nuova implementazione → tipo "App web": Esegui come "Me", Accesso "Chiunque".
// 5. Copia l'URL dell'app web e incollalo nella pagina di EV Planner, con la stessa parola segreta.

const SHEET_NAME = 'Viaggi';

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  const body = JSON.parse(e.postData.contents);
  if (!secret || body.secret !== secret) return reply({ ok: false, error: 'forbidden' });

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  const headers = Object.keys(body.row);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  sheet.appendRow(headers.map((h) => body.row[h]));
  return reply({ ok: true });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
