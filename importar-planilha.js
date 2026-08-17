// Importa o historico real da planilha KNBRIK (import-produtos.json) pro banco do sistema.
// Rode UMA VEZ, localmente, depois de `npm install` e antes (ou logo depois) do primeiro deploy:
//   node importar-planilha.js
//
// E idempotente: produtos cujo SKU ja existe no banco sao pulados (nao duplica se rodar de novo).
//
// IMPORTANTE: alguns produtos vieram com a divisao de investimento entre socios incompleta na
// planilha original (a soma paga por Kaua+Gustavo nao bate com o custo total declarado — ver
// import-avisos.txt). Esses produtos SAO importados assim mesmo, com a divisao como estava na
// planilha, mas o app vai continuar exigindo que a soma bata em qualquer edicao futura pela
// tela de Produtos. Corrija esses casos pela interface depois de importar.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'knbrik.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`Banco nao encontrado em ${DB_PATH}. Rode "npm start" pelo menos uma vez (pra criar o schema) e pare o servidor antes de importar.`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const dados = JSON.parse(fs.readFileSync(path.join(__dirname, 'import-produtos.json'), 'utf-8'));

function socioId(nome) {
  let s = db.prepare('SELECT id FROM socios WHERE nome=?').get(nome);
  if (!s) {
    const r = db.prepare('INSERT INTO socios (nome) VALUES (?)').run(nome);
    s = { id: r.lastInsertRowid };
  }
  return s.id;
}

let criados = 0, pulados = 0, vendasCriadas = 0;

const transacao = db.transaction((produtos) => {
  for (const p of produtos) {
    const existente = db.prepare('SELECT id FROM produtos WHERE sku=?').get(p.sku);
    if (existente) { pulados++; continue; }

    const r = db.prepare(`INSERT INTO produtos
      (sku,nome,categoria,condicao,quantidade_total,custo_total,data_compra,preco_anuncio,lucro_minimo,status_manual,obs)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.sku, p.nome, p.categoria, p.condicao, p.quantidade_total, p.custo_total,
           p.data_compra, p.preco_anuncio, p.lucro_minimo, p.status_manual, p.obs);
    const produtoId = r.lastInsertRowid;

    const insInv = db.prepare('INSERT INTO produto_investimentos (produto_id, socio_id, valor) VALUES (?,?,?)');
    for (const inv of p.investimentos) {
      insInv.run(produtoId, socioId(inv.socio), inv.valor);
    }

    if (p.venda) {
      db.prepare(`INSERT INTO vendas (produto_id,quantidade,valor_vendido,canal_venda,data_venda,obs)
        VALUES (?,?,?,?,?,?)`)
        .run(produtoId, p.venda.quantidade, p.venda.valor_vendido, p.venda.canal_venda, p.venda.data_venda, p.venda.obs);
      db.prepare('UPDATE produtos SET quantidade_vendida = quantidade_vendida + ? WHERE id=?')
        .run(p.venda.quantidade, produtoId);
      vendasCriadas++;
    }

    db.prepare('INSERT INTO produtos_auditoria (produto_id,acao,dados_depois) VALUES (?,?,?)')
      .run(produtoId, 'importado_da_planilha', JSON.stringify(p));

    criados++;
  }
});

transacao(dados);

console.log(`Importacao concluida: ${criados} produto(s) criado(s), ${pulados} pulado(s) (SKU ja existia), ${vendasCriadas} venda(s) registrada(s).`);
console.log('Leia import-avisos.txt para ver os casos que precisam de conferencia manual.');
