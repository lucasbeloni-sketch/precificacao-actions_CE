const test = require("node:test");
const assert = require("node:assert/strict");

const { toNumber } = require("../lib/google");
const { sniffDelimiter, consolidar, buildCsv } = require("../stage1-gpm/compilar-gpm");
const { compilar } = require("../stage2-unidades/compile");

test("toNumber: formatos pt-BR, en e bordas", () => {
  assert.equal(toNumber("1.234,56"), 1234.56);
  assert.equal(toNumber("1234,56"), 1234.56);
  assert.equal(toNumber("1234.56"), 1234.56);
  assert.equal(toNumber("1.000"), 1);        // só ponto = tratado como decimal (paridade com Python to_number_ptbr)
  assert.equal(toNumber(""), 0);
  assert.equal(toNumber("   "), 0);
  assert.equal(toNumber(null), 0);
  assert.equal(toNumber(undefined), 0);
  assert.equal(toNumber("abc"), 0);
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber("  2.500,75  "), 2500.75);
});

test("sniffDelimiter: detecta ; , tab e ignora dentro de aspas", () => {
  assert.equal(sniffDelimiter("a;b;c"), ";");
  assert.equal(sniffDelimiter("a,b,c"), ",");
  assert.equal(sniffDelimiter("a\tb\tc"), "\t");
  assert.equal(sniffDelimiter('"a;b;c",d'), ","); // ; dentro de aspas não conta
  assert.equal(sniffDelimiter("x;y\nz,w"), ";");  // só olha a 1a linha
});

test("consolidar: filtra B-, agrupa, soma, dedup e ordena", () => {
  const idx = [0, 1, 2, 3, 4];
  const rows = [
    ["CT1", "B-100", "Atividade A", "10,00", "100,00"],
    ["CT1", "B-100", "Atividade A", "5,00", "50,00"],   // mesmo grupo -> soma
    ["CT1", "C-200", "Atividade X", "9,00", "9,00"],     // não B- -> fora
    ["CT0", "B-100", "Atividade A", "1,00", "1,00"],     // centro diferente -> outro grupo
  ];
  const out = consolidar(rows, idx);
  // ordena por centro (CT0 antes de CT1)
  assert.deepEqual(out, [
    ["CT0", "B-100", "Atividade A", 1, 1],
    ["CT1", "B-100", "Atividade A", 15, 150],
  ]);
});

test("consolidar: dedup de linha exata (não soma duplicata idêntica)", () => {
  const idx = [0, 1, 2, 3, 4];
  const rows = [
    ["CT1", "B-1", "A", "10", "10"],
    ["CT1", "B-1", "A", "10", "10"], // linha 100% idêntica -> descartada
  ];
  const out = consolidar(rows, idx);
  assert.deepEqual(out, [["CT1", "B-1", "A", 10, 10]]);
});

test("consolidar: separador evita colisão de concatenação", () => {
  const idx = [0, 1, 2, 3, 4];
  const rows = [
    ["CT", "B-1", "bc", "1", "1"],
    ["CT", "B-1b", "c", "2", "2"], // "B-1"+"bc" vs "B-1b"+"c" colidiriam sem separador
  ];
  const out = consolidar(rows, idx);
  assert.equal(out.length, 2); // grupos distintos
});

test("buildCsv: BOM, header, decimal vírgula e escape", () => {
  const csv = buildCsv([["CT1", "B-1", "desc; com ponto-e-vírgula", 1234.5, 9.1]]);
  assert.ok(csv.startsWith("﻿"), "tem BOM");
  const linhas = csv.replace("﻿", "").trim().split("\r\n");
  assert.equal(linhas[0], "centro_servico;cod_pep_obra;des_atividade;qtd_atividade;valor_total");
  assert.equal(linhas[1], 'CT1;B-1;"desc; com ponto-e-vírgula";1234,50;9,10');
});

test("compilar (stage2): filtra col A, agrupa por C+B[0..9], soma e ordena", () => {
  const values = [
    ["BAR - CCM", "123456789XYZ", "Serv A", "10", "100"], // B truncado p/ 9 = "123456789"
    ["BAR - CCM", "123456789ABC", "Serv A", "5", "50"],   // mesmo b9 + mesmo C -> soma
    ["OUTRO",     "999999999", "Serv A", "1", "1"],        // col A fora do filtro -> ignora
    ["BARREIRAS - STC", "111111111", "Serv B", "2", "2"],
  ];
  const out = compilar(values, ["BAR - CCM", "BARREIRAS - STC"]);
  assert.deepEqual(out, [
    ["BARREIRAS - STC", "111111111", "Serv B", 2, 2],   // ordena por b||c -> "111..." antes; col A = original
    ["BAR - CCM", "123456789", "Serv A", 15, 150],
  ]);
});
