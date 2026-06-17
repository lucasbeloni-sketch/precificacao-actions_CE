const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getAuthClient, stampBR, toNumber, withRetry } = require("../lib/google");
const shared = require("../shared-config.json");

// Agrupa por (C + B[0..9]) somando D e E. Ordena por B||C. Funcao pura.
function compilar(values, filtros) {
  const map = new Map();
  for (const row of values) {
    const [colA, colB, colC, colD, colE] = row;
    if (!filtros.includes(String(colA).trim())) continue;

    const b9 = String(colB ?? "").trim().substring(0, 9);
    const cKey = String(colC ?? "").trim();
    if (!b9 || !cKey) continue;

    const key = `${cKey}||${b9}`;
    if (!map.has(key)) map.set(key, { a: colA, b: b9, c: cKey, sumD: 0, sumE: 0 });
    const acc = map.get(key);
    acc.sumD += toNumber(colD);
    acc.sumE += toNumber(colE);
  }
  return Array.from(map.values())
    .sort((r1, r2) => (r1.b + "||" + r1.c).localeCompare(r2.b + "||" + r2.c))
    .map((r) => [r.a, r.b, r.c, r.sumD, r.sumE]);
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const client = await getAuthClient(["https://www.googleapis.com/auth/spreadsheets"]);
  const sheets = google.sheets({ version: "v4", auth: client });

  // Le origem (BD_Precificacao) 1x, reusa para todos os alvos.
  const res = await withRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId: shared.bdSpreadsheetId,
      range: `${shared.bdSheet}!A${shared.startRow}:E`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    { label: "sheets.values.get(origem)" }
  );
  const values = res.data.values || [];
  if (!values.length) {
    console.log("[stage2] Origem vazia. Nada a fazer.");
    return;
  }

  for (const alvo of cfg.alvos) {
    try {
      const output = compilar(values, alvo.filtros);
      const aba = cfg.abaDestino;

      await withRetry(
        () => sheets.spreadsheets.values.clear({
          spreadsheetId: alvo.destinoSpreadsheetId,
          range: `${aba}!A${shared.startRow}:E`,
        }),
        { label: `clear ${alvo.nome}` }
      );

      if (output.length) {
        await withRetry(
          () => sheets.spreadsheets.values.update({
            spreadsheetId: alvo.destinoSpreadsheetId,
            range: `${aba}!A${shared.startRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: output },
          }),
          { label: `update ${alvo.nome}` }
        );
      }

      await withRetry(
        () => sheets.spreadsheets.values.update({
          spreadsheetId: alvo.destinoSpreadsheetId,
          range: `${aba}!B1`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[stampBR(shared.timezone)]] },
        }),
        { label: `stamp ${alvo.nome}` }
      );

      console.log(`[stage2] OK ${alvo.nome}: ${output.length} linhas.`);
    } catch (e) {
      console.error(`[stage2] FALHA ${alvo.nome}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { compilar };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
