const { Readable } = require("stream");
const { parse } = require("csv-parse/sync");
const { google } = require("googleapis");
const { getAuthClient, stampBR, toNumber, withRetry } = require("../lib/google");
const shared = require("../shared-config.json");

const SEP = String.fromCharCode(1); // separador interno de chaves (evita colisao)

// ====== CONFIG ======
const CONFIG = {
  csvFolderId: "1sRQT_dhvbL5bl4yHvJazsD5GTeqFQoRD",      // pasta (shared drive) com os CSVs de origem
  bancoFolderId: "17Jyopo6qV7RDbD9QKEQSjx0TrjI5J-7b",    // pasta onde grava/atualiza o consolidado
  bancoFileName: "BANCO.csv",
  uploadBanco: true,
  spreadsheetId: shared.bdSpreadsheetId, // planilha de ligacao (alimenta o estagio 2)
  sheetName: shared.bdSheet,
  startRow: shared.startRow,
  timezone: shared.timezone,
  keepCols1Based: [30, 2, 37, 38, 40], // AD, B, AK, AL, AN
  // ===== guards anti-sobrescrita-cega (use FORCE=1 pra ignorar o de queda) =====
  allowPartial: false,   // se algum CSV falhar download/parse: false = aborta (nao publica parcial)
  minRows: 0,            // 0 = off. Se >0, aborta quando o consolidado tiver menos que isso.
  dropGuardRatio: 0.5,   // aborta se linhas novas < ratio * linhas atuais na BD...
  dropGuardFloor: 100,   // ...desde que a BD atual tenha pelo menos esse tanto (ignora base minuscula).
};

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

const COLUMNS = ["centro_servico", "cod_pep_obra", "des_atividade", "qtd_atividade", "valor_total"];

// Detecta delimitador olhando a 1a linha (;, , ou tab).
function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const counts = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Consolida linhas cruas: dedup de linha exata, descarta cod_pep_obra vazio,
// agrupa por (centro, cod, des) somando qtd e valor, ordena ordinal. Funcao pura.
function consolidar(rows, idx) {
  const seen = new Set();
  const grupos = new Map();
  for (const row of rows) {
    const dedupKey = row.join(SEP);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const centro = String(row[idx[0]] ?? "").trim();
    const cod = String(row[idx[1]] ?? "").trim().toUpperCase();
    if (!cod) continue;
    const des = String(row[idx[2]] ?? "").trim();

    const key = [centro, cod, des].join(SEP);
    let acc = grupos.get(key);
    if (!acc) { acc = { centro, cod, des, qtd: 0, valor: 0 }; grupos.set(key, acc); }
    acc.qtd += toNumber(row[idx[3]]);
    acc.valor += toNumber(row[idx[4]]);
  }
  return Array.from(grupos.values())
    .sort((a, b) =>
      a.centro < b.centro ? -1 : a.centro > b.centro ? 1 :
      a.cod < b.cod ? -1 : a.cod > b.cod ? 1 :
      a.des < b.des ? -1 : a.des > b.des ? 1 : 0
    )
    .map((r) => [r.centro, r.cod, r.des, r.qtd, r.valor]);
}

// Monta o CSV pt-BR (sep ;, decimal virgula, BOM utf-8-sig) — paridade com o BANCO.csv antigo.
function buildCsv(rows) {
  const esc = (v) => {
    const s = String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmtNum = (n) => n.toFixed(2).replace(".", ",");
  const lines = [COLUMNS.join(";")];
  for (const r of rows) {
    lines.push([esc(r[0]), esc(r[1]), esc(r[2]), fmtNum(r[3]), fmtNum(r[4])].join(";"));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// Lista todos os arquivos de uma pasta (shared drive, paginado).
async function listFiles(drive, folderId, driveId) {
  const files = [];
  let pageToken;
  do {
    const resp = await withRetry(
      () => drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        pageToken,
        pageSize: 1000,
        fields: "nextPageToken, files(id,name,mimeType)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "drive",
        driveId,
      }),
      { label: "drive.files.list" }
    );
    files.push(...(resp.data.files || []));
    pageToken = resp.data.nextPageToken;
  } while (pageToken);
  return files;
}

// Baixa um arquivo do Drive como Buffer (sem gravar em disco).
async function downloadBuffer(drive, fileId) {
  const resp = await withRetry(
    () => drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    ),
    { label: "drive.files.get(media)" }
  );
  return Buffer.from(resp.data);
}

// Cria ou atualiza o BANCO.csv na pasta destino (sem duplicar).
async function uploadBanco(drive, folderId, driveId, csvString) {
  const resp = await withRetry(
    () => drive.files.list({
      q: `'${folderId}' in parents and trashed = false and name = '${CONFIG.bancoFileName}'`,
      fields: "files(id,name)",
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId,
    }),
    { label: "drive.files.list(banco)" }
  );
  const existing = (resp.data.files || [])[0];
  if (existing) {
    await withRetry(
      () => drive.files.update({
        fileId: existing.id,
        media: { mimeType: "text/csv", body: Readable.from(csvString) },
        supportsAllDrives: true,
      }),
      { label: "drive.files.update" }
    );
    return "atualizado";
  }
  await withRetry(
    () => drive.files.create({
      requestBody: { name: CONFIG.bancoFileName, parents: [folderId] },
      media: { mimeType: "text/csv", body: Readable.from(csvString) },
      supportsAllDrives: true,
    }),
    { label: "drive.files.create" }
  );
  return "criado";
}

async function main() {
  const client = await getAuthClient(SCOPES);
  const drive = google.drive({ version: "v3", auth: client });
  const sheets = google.sheets({ version: "v4", auth: client });

  // descobre o driveId da pasta (shared drive)
  const folderMeta = await withRetry(
    () => drive.files.get({ fileId: CONFIG.csvFolderId, fields: "id,name,driveId", supportsAllDrives: true }),
    { label: "drive.files.get(folder)" }
  );
  const driveId = folderMeta.data.driveId;
  console.log(`[stage1] Pasta: ${folderMeta.data.name}`);

  const all = await listFiles(drive, CONFIG.csvFolderId, driveId);
  const csvFiles = all.filter(
    (f) => f.name.toLowerCase().endsWith(".csv") && f.name !== CONFIG.bancoFileName
  );
  console.log(`[stage1] CSVs encontrados: ${csvFiles.length}`);

  // guard: pasta vazia -> nao toca na BD
  if (!csvFiles.length) {
    throw new Error("Nenhum CSV na pasta de origem. Abortando para nao sobrescrever a BD.");
  }

  // baixa + parseia todos, juntando as linhas cruas
  let failed = 0;
  const allRows = [];
  for (const f of csvFiles) {
    let buf;
    try {
      buf = await downloadBuffer(drive, f.id);
    } catch (e) {
      console.error(`[stage1] ERRO download ${f.name}: ${e.message}`);
      failed++;
      continue;
    }
    try {
      const records = parse(buf.toString("utf8"), {
        bom: true,
        delimiter: sniffDelimiter(buf.toString("utf8")),
        relax_column_count: true,
        skip_empty_lines: true,
      });
      allRows.push(...records);
    } catch (e) {
      console.error(`[stage1] ERRO parse ${f.name}: ${e.message}`);
      failed++;
    }
  }

  // guard: algum CSV falhou -> nao publica dado parcial (a menos que allowPartial)
  if (failed && !CONFIG.allowPartial) {
    throw new Error(`${failed} CSV(s) falharam. Abortando para nao publicar dado parcial (allowPartial=false).`);
  }

  const idx = CONFIG.keepCols1Based.map((p) => p - 1);
  const rows = consolidar(allRows, idx);

  // guard: zero registros validos -> nao zera a BD
  if (!rows.length) {
    throw new Error("Nenhum registro valido (cod_pep_obra vazio). Abortando para nao zerar a BD.");
  }
  console.log(`[stage1] Linhas consolidadas: ${rows.length}`);

  // guard: minimo absoluto configuravel
  if (CONFIG.minRows && rows.length < CONFIG.minRows) {
    throw new Error(`Consolidado ${rows.length} < minRows ${CONFIG.minRows}. Abortando.`);
  }

  // guard de queda: compara com o que ja esta na BD (estado anterior = a propria planilha).
  // Use FORCE=1 pra forcar uma queda legitima (ex: fim de contrato).
  if (process.env.FORCE !== "1") {
    const cur = await withRetry(
      () => sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.spreadsheetId,
        range: `${CONFIG.sheetName}!A${CONFIG.startRow}:A`,
      }),
      { label: "sheets.values.get(atual)" }
    );
    const atual = (cur.data.values || []).length;
    if (atual >= CONFIG.dropGuardFloor && rows.length < atual * CONFIG.dropGuardRatio) {
      throw new Error(
        `Queda suspeita: ${rows.length} novas vs ${atual} atuais na BD ` +
        `(< ${Math.round(CONFIG.dropGuardRatio * 100)}%). Rode com FORCE=1 se for esperado.`
      );
    }
  }

  // cola na planilha de ligacao (A{startRow}:E) + timestamp B1
  await withRetry(
    () => sheets.spreadsheets.values.clear({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `${CONFIG.sheetName}!A${CONFIG.startRow}:E`,
    }),
    { label: "sheets.values.clear" }
  );
  await withRetry(
    () => sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `${CONFIG.sheetName}!A${CONFIG.startRow}`,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    }),
    { label: "sheets.values.update(dados)" }
  );
  await withRetry(
    () => sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `${CONFIG.sheetName}!B1`,
      valueInputOption: "RAW",
      requestBody: { values: [[stampBR(CONFIG.timezone)]] },
    }),
    { label: "sheets.values.update(stamp)" }
  );
  console.log("[stage1] BD_Precificacao atualizada.");

  // grava/atualiza BANCO.csv no Drive
  if (CONFIG.uploadBanco) {
    const action = await uploadBanco(drive, CONFIG.bancoFolderId, driveId, buildCsv(rows));
    console.log(`[stage1] BANCO.csv ${action} no Drive.`);
  }

  console.log("[stage1] OK.");
}

module.exports = { sniffDelimiter, consolidar, buildCsv };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
