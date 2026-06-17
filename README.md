# Pipeline Precificacao — automacao via GitHub Actions

Pipeline de 2 estagios, tudo em Node, num workflow encadeado. Substitui o
Apps Script (10 scripts) **e** o `compilador_precificacao_GPM` (Python).

## Estagios

```
CSVs no Drive ──[stage1]──> BD_Precificacao + BANCO.csv ──[stage2]──> 10 planilhas por unidade
```

- **stage1** (`stage1-gpm/compilar-gpm.js`) — le os CSVs de uma pasta do Drive,
  consolida (mantem AD/B/AK/AL/AN, filtra `cod_pep_obra` "B-", agrupa e soma),
  cola em `BD_Precificacao!A3:E` e grava/atualiza `BANCO.csv` no Drive.
- **stage2** (`stage2-unidades/compile.js`) — le `BD_Precificacao`, compila por
  unidade (filtros da coluna A em `config.json`) e cola nas 10 planilhas destino.
- `lib/google.js` — auth da service account + helpers (timestamp, parse numerico, `withRetry`).
- `shared-config.json` — config comum aos 2 estagios (id da BD, aba, startRow, timezone).
- `.github/workflows/pipeline.yml` — cron a cada 6h + botao manual. stage2 so roda
  se o stage1 passar.

## Permissoes da service account (1 SA pra tudo)

A mesma SA (`GOOGLE_CREDENTIALS`) precisa de:

| Recurso | Acesso |
|---|---|
| Pasta Drive dos CSVs (`Exporta_Obras`) | Leitor / membro do shared drive |
| Pasta Drive do BANCO.csv | Editor / gestor de conteudo |
| Planilha `BD_Precificacao` (origem/ligacao) | **Editor** (stage1 escreve, stage2 le) |
| 10 planilhas destino | Editor |

## Secret

GitHub repo -> Settings -> Secrets and variables -> Actions:
- Nome: `GOOGLE_CREDENTIALS`
- Valor: conteudo **inteiro** do JSON da key da service account

## Rodar local (teste)

```powershell
cd C:\Users\sirte\precificacao-actions
npm install
$env:GOOGLE_CREDENTIALS = Get-Content credentials.json -Raw
npm run pipeline      # stage1 + stage2
# ou: npm run stage1   /   npm run stage2
```

(`credentials.json` esta no `.gitignore` — nunca commitar.)

## Guards do stage1 (anti-sobrescrita-cega)

stage1 aborta (falha o run, nao toca na BD) se:
- pasta de origem sem CSV;
- algum CSV falhar download/parse (`allowPartial=false`) — nao publica parcial;
- nenhum registro `cod_pep_obra` "B-";
- consolidado abaixo de `minRows` (off por padrao);
- queda suspeita: linhas novas < 50% das linhas atuais da BD (`dropGuardRatio`),
  quando a BD ja tem >= `dropGuardFloor` linhas.

Queda legitima (ex: fim de contrato)? Rode forcando:

```powershell
$env:FORCE = "1"; npm run stage1
```

Ajusta os limites no `CONFIG` de `stage1-gpm/compilar-gpm.js`.

## Notificacao de falha

Se o workflow falhar, o job `notify` abre (ou comenta, mantendo 1 issue rolante)
uma issue com label `pipeline-falha` e o link do run. Sem secret extra — usa o
`GITHUB_TOKEN`. Pra receber email, basta estar "watching" o repo.

## Retry

Chamadas a Drive/Sheets passam por `withRetry` (`lib/google.js`): em erro
transiente (429/5xx, reset/timeout de rede) retenta com backoff exponencial +
jitter (5 tentativas). Erro nao-transiente sobe na hora.

## Testes

Funcoes puras (parse numerico, sniff de delimitador, consolidacao, compilacao,
geracao de CSV) tem testes com o runner nativo do Node:

```powershell
npm test
```

Rodam tambem no CI antes dos estagios — build quebrado falha sem tocar nas planilhas.

## Cron

`0 */6 * * *` = a cada 6h (UTC). Edita em `.github/workflows/pipeline.yml`.
