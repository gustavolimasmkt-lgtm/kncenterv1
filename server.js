const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { processarPlanilha } = require('./importador');
const XLSX = require('xlsx');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
// link curto pra mandar pro cliente (sem .html) — mesma pagina publica do catalogo.
app.get('/catalogo', (_, res) => res.sendFile(path.join(__dirname, 'public', 'catalogo.html')));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'knbrik.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const UPLOADS_DIR = path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas imagens sao permitidas'));
  }
});

const uploadPlanilha = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Envie um arquivo .xlsx'));
  }
});

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- SCHEMA ----------
// Modelo: cada "produto" pode ser uma unidade única (ex: 1 iPhone) ou um lote de N unidades
// idênticas (ex: 5 carregadores). quantidade_total / quantidade_vendida controlam o estoque.
// O investimento de compra é dividido entre sócios em valores livres (produto_investimentos),
// mas o LUCRO de cada venda é sempre dividido em partes iguais entre os sócios que investiram
// no produto — replica a regra já usada manualmente na planilha da loja.
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    recovery_code_hash TEXT,
    is_admin INTEGER DEFAULT 0,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS socios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    nome TEXT NOT NULL,
    categoria TEXT DEFAULT 'Outro',
    condicao TEXT,
    bateria_pct INTEGER,
    tudo_original INTEGER DEFAULT 0,
    imei_serial TEXT,
    quantidade_total INTEGER NOT NULL DEFAULT 1,
    quantidade_vendida INTEGER NOT NULL DEFAULT 0,
    custo_total REAL NOT NULL DEFAULT 0,
    data_compra TEXT,
    preco_anuncio REAL,
    lucro_minimo REAL,
    status_manual TEXT,
    obs TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS produto_investimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    socio_id INTEGER NOT NULL REFERENCES socios(id),
    valor REAL NOT NULL DEFAULT 0,
    UNIQUE(produto_id, socio_id)
  );

  CREATE TABLE IF NOT EXISTS produto_fotos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    arquivo TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS produtos_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL,
    usuario_id INTEGER REFERENCES usuarios(id),
    acao TEXT NOT NULL,
    dados_antes TEXT,
    dados_depois TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade INTEGER NOT NULL DEFAULT 1,
    valor_vendido REAL NOT NULL DEFAULT 0,
    canal_venda TEXT,
    data_venda TEXT NOT NULL,
    obs TEXT,
    usuario_id INTEGER REFERENCES usuarios(id),
    eh_troca INTEGER DEFAULT 0,
    produto_destino_id INTEGER REFERENCES produtos(id),
    custo REAL,
    lucro REAL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lancamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL CHECK(tipo IN ('entrada','saida')),
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    socio_id INTEGER REFERENCES socios(id),
    data TEXT NOT NULL,
    usuario_id INTEGER REFERENCES usuarios(id),
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS metas_semanais (
    semana TEXT PRIMARY KEY,
    valor_por_socio REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cotacao_modelos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    base REAL NOT NULL DEFAULT 0,
    leves REAL NOT NULL DEFAULT 0,
    moderadas REAL NOT NULL DEFAULT 0,
    bateria REAL NOT NULL DEFAULT 0,
    tela REAL NOT NULL DEFAULT 0,
    traseira REAL NOT NULL DEFAULT 0,
    faceid REAL NOT NULL DEFAULT 0,
    doc_carga REAL NOT NULL DEFAULT 0,
    cam_traseira REAL NOT NULL DEFAULT 0,
    notif_camera REAL NOT NULL DEFAULT 0,
    notif_bateria REAL NOT NULL DEFAULT 0,
    notif_tela REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`);

// migracao leve: colunas novas em bancos que ja existiam antes dessa versao
for (const col of [
  "ALTER TABLE vendas ADD COLUMN eh_troca INTEGER DEFAULT 0",
  "ALTER TABLE vendas ADD COLUMN produto_destino_id INTEGER REFERENCES produtos(id)",
  "ALTER TABLE vendas ADD COLUMN custo REAL",
  "ALTER TABLE vendas ADD COLUMN lucro REAL",
  "ALTER TABLE vendas ADD COLUMN custo_transferido REAL DEFAULT 0",
  "ALTER TABLE vendas ADD COLUMN custo_transferido_split TEXT",
  "ALTER TABLE produtos ADD COLUMN bateria_pct INTEGER",
  "ALTER TABLE produtos ADD COLUMN tudo_original INTEGER DEFAULT 0",
]) {
  try { db.exec(col); } catch (e) { /* coluna ja existe, ignora */ }
}

// congela (uma vez so) o custo/lucro de vendas antigas que ainda nao tinham isso gravado.
// Antes, custo/lucro eram recalculados toda vez a partir do custo_total ATUAL do produto —
// isso fazia o lucro de vendas antigas mudar sozinho quando o custo do produto mudava depois.
// A partir de agora cada venda grava seu proprio custo/lucro na hora em que acontece, e nunca
// mais muda. Lucro = valor_vendido − custo sempre, troca ou nao (ver calcularVendaNova).
{
  const semSnapshot = db.prepare('SELECT * FROM vendas WHERE custo IS NULL OR lucro IS NULL').all();
  if (semSnapshot.length) {
    const upd = db.prepare('UPDATE vendas SET custo=?, lucro=? WHERE id=?');
    for (const v of semSnapshot) {
      const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(v.produto_id);
      if (!p) continue;
      const custoUnit = p.quantidade_total > 0 ? p.custo_total / p.quantidade_total : 0;
      const custo = custoUnit * v.quantidade;
      upd.run(custo, v.valor_vendido - custo, v.id);
    }
  }
}

// (Bloco antigo "Corrige o modelo antigo de troca" removido em 2026-08-26 — era pra rodar uma vez
// so, mas o gatilho dele (lucro != valor_vendido - custo) volta a ser verdadeiro pra QUALQUER
// troca com lucro=0, que e o estado CORRETO e permanente desde que o custo passou a ser
// transferido pro produto de destino (ver calcularVendaComTroca). Resultado: a cada reinicio do
// servidor ele achava que toda troca-com-destino-zerada era o modelo antigo bugado e revertia —
// duplicando o custo_total do produto de origem e zerando o do destino, de novo a cada boot. Isso
// corrompeu de verdade o custo de 4 produtos em producao. A migracao de reparo logo abaixo
// conserta o estrago; esse bloco foi apagado pra nunca mais rodar.

// seed: sócios padrão (extensível pela UI) e meta semanal padrão
if (db.prepare('SELECT COUNT(*) as n FROM socios').get().n === 0) {
  const ins = db.prepare('INSERT INTO socios (nome) VALUES (?)');
  ['Kauã', 'Gustavo'].forEach(n => ins.run(n));
}
if (!db.prepare("SELECT valor FROM config WHERE chave='meta_semanal_por_socio'").get()) {
  db.prepare("INSERT INTO config (chave, valor) VALUES ('meta_semanal_por_socio', '1000')").run();
}

// seed: tabela de precos da Cotacao iPhone (mesmos 55 modelos da calculadora avulsa) — so na
// primeira vez, se a tabela estiver vazia. Depois disso e tudo editavel pela aba Precos.
if (db.prepare('SELECT COUNT(*) as n FROM cotacao_modelos').get().n === 0) {
  const seedCotacao = [{"nome":"iPhone 8 Plus 64GB","base":300,"leves":100,"moderadas":250,"bateria":100,"tela":200,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":0,"notif_tela":0,"sort_order":0},{"nome":"iPhone 8 Plus 256GB","base":400,"leves":100,"moderadas":250,"bateria":100,"tela":200,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":0,"notif_tela":0,"sort_order":1},{"nome":"iPhone X 64GB","base":300,"leves":100,"moderadas":250,"bateria":100,"tela":200,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":0,"notif_tela":0,"sort_order":2},{"nome":"iPhone X 256GB","base":400,"leves":100,"moderadas":250,"bateria":100,"tela":200,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":0,"notif_tela":0,"sort_order":3},{"nome":"iPhone XR 64GB","base":400,"leves":100,"moderadas":250,"bateria":100,"tela":200,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":0,"sort_order":4},{"nome":"iPhone XR 128GB","base":500,"leves":100,"moderadas":250,"bateria":100,"tela":200,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":0,"sort_order":5},{"nome":"iPhone XS 64GB","base":300,"leves":100,"moderadas":250,"bateria":100,"tela":300,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":0,"sort_order":6},{"nome":"iPhone XS 256GB","base":400,"leves":100,"moderadas":250,"bateria":100,"tela":300,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":0,"sort_order":7},{"nome":"iPhone XS Max 64GB","base":400,"leves":100,"moderadas":250,"bateria":100,"tela":300,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":0,"sort_order":8},{"nome":"iPhone XS Max 256GB","base":500,"leves":100,"moderadas":250,"bateria":100,"tela":300,"traseira":100,"faceid":200,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":0,"sort_order":9},{"nome":"iPhone 11 64GB","base":440,"leves":101,"moderadas":300,"bateria":200,"tela":300,"traseira":114,"faceid":350,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":10},{"nome":"iPhone 11 128GB","base":640,"leves":115,"moderadas":300,"bateria":200,"tela":300,"traseira":134,"faceid":350,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":11},{"nome":"iPhone 11 256GB","base":740,"leves":122,"moderadas":300,"bateria":200,"tela":300,"traseira":144,"faceid":350,"doc_carga":150,"cam_traseira":300,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":12},{"nome":"iPhone 11 Pro 64GB","base":440,"leves":101,"moderadas":300,"bateria":200,"tela":350,"traseira":114,"faceid":350,"doc_carga":150,"cam_traseira":400,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":13},{"nome":"iPhone 11 Pro 256GB","base":540,"leves":108,"moderadas":300,"bateria":200,"tela":350,"traseira":124,"faceid":350,"doc_carga":150,"cam_traseira":400,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":14},{"nome":"iPhone 11 Pro Max 64GB","base":640,"leves":115,"moderadas":300,"bateria":200,"tela":350,"traseira":134,"faceid":350,"doc_carga":150,"cam_traseira":400,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":15},{"nome":"iPhone 11 Pro Max 256GB","base":740,"leves":122,"moderadas":300,"bateria":200,"tela":350,"traseira":144,"faceid":350,"doc_carga":150,"cam_traseira":400,"notif_camera":0,"notif_bateria":200,"notif_tela":300,"sort_order":16},{"nome":"iPhone 12 64GB","base":940,"leves":136,"moderadas":350,"bateria":200,"tela":350,"traseira":164,"faceid":450,"doc_carga":200,"cam_traseira":400,"notif_camera":296,"notif_bateria":188,"notif_tela":188,"sort_order":17},{"nome":"iPhone 12 128GB","base":1099,"leves":147,"moderadas":350,"bateria":200,"tela":350,"traseira":180,"faceid":450,"doc_carga":200,"cam_traseira":500,"notif_camera":376,"notif_bateria":220,"notif_tela":220,"sort_order":18},{"nome":"iPhone 12 256GB","base":1140,"leves":150,"moderadas":350,"bateria":200,"tela":350,"traseira":184,"faceid":450,"doc_carga":200,"cam_traseira":500,"notif_camera":440,"notif_bateria":228,"notif_tela":228,"sort_order":19},{"nome":"iPhone 12 Pro 128GB","base":1240,"leves":157,"moderadas":350,"bateria":250,"tela":350,"traseira":194,"faceid":450,"doc_carga":200,"cam_traseira":600,"notif_camera":456,"notif_bateria":248,"notif_tela":248,"sort_order":20},{"nome":"iPhone 12 Pro 256GB","base":1440,"leves":171,"moderadas":350,"bateria":250,"tela":350,"traseira":214,"faceid":450,"doc_carga":200,"cam_traseira":600,"notif_camera":496,"notif_bateria":288,"notif_tela":288,"sort_order":21},{"nome":"iPhone 12 Pro Max 128GB","base":1640,"leves":185,"moderadas":350,"bateria":250,"tela":500,"traseira":234,"faceid":450,"doc_carga":200,"cam_traseira":600,"notif_camera":576,"notif_bateria":328,"notif_tela":328,"sort_order":22},{"nome":"iPhone 12 Pro Max 256GB","base":1799,"leves":196,"moderadas":350,"bateria":250,"tela":500,"traseira":250,"faceid":450,"doc_carga":200,"cam_traseira":600,"notif_camera":656,"notif_bateria":360,"notif_tela":360,"sort_order":23},{"nome":"iPhone 13 128GB","base":1545,"leves":178,"moderadas":400,"bateria":250,"tela":350,"traseira":225,"faceid":450,"doc_carga":250,"cam_traseira":400,"notif_camera":720,"notif_bateria":309,"notif_tela":309,"sort_order":24},{"nome":"iPhone 13 256GB","base":1640,"leves":185,"moderadas":400,"bateria":250,"tela":350,"traseira":234,"faceid":450,"doc_carga":250,"cam_traseira":400,"notif_camera":618,"notif_bateria":328,"notif_tela":328,"sort_order":25},{"nome":"iPhone 13 Pro 128GB","base":1945,"leves":206,"moderadas":400,"bateria":250,"tela":400,"traseira":265,"faceid":600,"doc_carga":250,"cam_traseira":650,"notif_camera":656,"notif_bateria":389,"notif_tela":389,"sort_order":26},{"nome":"iPhone 13 Pro 256GB","base":2095,"leves":217,"moderadas":400,"bateria":250,"tela":400,"traseira":280,"faceid":600,"doc_carga":250,"cam_traseira":650,"notif_camera":778,"notif_bateria":419,"notif_tela":419,"sort_order":27},{"nome":"iPhone 13 Pro 512GB","base":2040,"leves":213,"moderadas":450,"bateria":250,"tela":400,"traseira":274,"faceid":600,"doc_carga":250,"cam_traseira":650,"notif_camera":838,"notif_bateria":408,"notif_tela":408,"sort_order":28},{"nome":"iPhone 13 Pro Max 128GB","base":2245,"leves":227,"moderadas":450,"bateria":250,"tela":900,"traseira":295,"faceid":600,"doc_carga":250,"cam_traseira":650,"notif_camera":816,"notif_bateria":449,"notif_tela":449,"sort_order":29},{"nome":"iPhone 13 Pro Max 256GB","base":2445,"leves":241,"moderadas":500,"bateria":250,"tela":900,"traseira":315,"faceid":600,"doc_carga":250,"cam_traseira":650,"notif_camera":898,"notif_bateria":489,"notif_tela":489,"sort_order":30},{"nome":"iPhone 14 128GB","base":1640,"leves":185,"moderadas":500,"bateria":250,"tela":500,"traseira":234,"faceid":600,"doc_carga":250,"cam_traseira":500,"notif_camera":978,"notif_bateria":328,"notif_tela":328,"sort_order":31},{"nome":"iPhone 14 256GB","base":1840,"leves":199,"moderadas":500,"bateria":250,"tela":500,"traseira":254,"faceid":600,"doc_carga":250,"cam_traseira":500,"notif_camera":656,"notif_bateria":368,"notif_tela":368,"sort_order":32},{"nome":"iPhone 14 512GB","base":2240,"leves":227,"moderadas":500,"bateria":250,"tela":500,"traseira":294,"faceid":600,"doc_carga":250,"cam_traseira":500,"notif_camera":736,"notif_bateria":448,"notif_tela":448,"sort_order":33},{"nome":"iPhone 14 Pro 128GB","base":2470,"leves":243,"moderadas":500,"bateria":350,"tela":700,"traseira":317,"faceid":750,"doc_carga":300,"cam_traseira":950,"notif_camera":896,"notif_bateria":494,"notif_tela":494,"sort_order":34},{"nome":"iPhone 14 Pro 256GB","base":2670,"leves":257,"moderadas":500,"bateria":350,"tela":700,"traseira":337,"faceid":750,"doc_carga":300,"cam_traseira":950,"notif_camera":988,"notif_bateria":534,"notif_tela":534,"sort_order":35},{"nome":"iPhone 14 Pro 512GB","base":2740,"leves":262,"moderadas":500,"bateria":350,"tela":700,"traseira":344,"faceid":750,"doc_carga":300,"cam_traseira":950,"notif_camera":1068,"notif_bateria":548,"notif_tela":548,"sort_order":36},{"nome":"iPhone 14 Pro Max 128GB","base":2870,"leves":271,"moderadas":500,"bateria":350,"tela":1200,"traseira":357,"faceid":750,"doc_carga":300,"cam_traseira":950,"notif_camera":1096,"notif_bateria":574,"notif_tela":574,"sort_order":37},{"nome":"iPhone 14 Pro Max 256GB","base":3029,"leves":282,"moderadas":500,"bateria":350,"tela":1200,"traseira":373,"faceid":750,"doc_carga":300,"cam_traseira":950,"notif_camera":1148,"notif_bateria":606,"notif_tela":606,"sort_order":38},{"nome":"iPhone 14 Pro Max 512GB","base":3040,"leves":283,"moderadas":500,"bateria":350,"tela":1200,"traseira":374,"faceid":750,"doc_carga":300,"cam_traseira":950,"notif_camera":1212,"notif_bateria":608,"notif_tela":608,"sort_order":39},{"nome":"iPhone 15 128GB","base":2245,"leves":227,"moderadas":600,"bateria":350,"tela":700,"traseira":295,"faceid":750,"doc_carga":600,"cam_traseira":600,"notif_camera":1216,"notif_bateria":449,"notif_tela":449,"sort_order":40},{"nome":"iPhone 15 256GB","base":2395,"leves":238,"moderadas":600,"bateria":350,"tela":700,"traseira":310,"faceid":750,"doc_carga":600,"cam_traseira":600,"notif_camera":898,"notif_bateria":479,"notif_tela":479,"sort_order":41},{"nome":"iPhone 15 Pro 128GB","base":2845,"leves":269,"moderadas":600,"bateria":450,"tela":1400,"traseira":355,"faceid":1000,"doc_carga":600,"cam_traseira":1200,"notif_camera":958,"notif_bateria":569,"notif_tela":569,"sort_order":42},{"nome":"iPhone 15 Pro 256GB","base":3145,"leves":290,"moderadas":600,"bateria":450,"tela":1400,"traseira":385,"faceid":1000,"doc_carga":600,"cam_traseira":1200,"notif_camera":1138,"notif_bateria":629,"notif_tela":629,"sort_order":43},{"nome":"iPhone 15 Pro Max 256GB","base":3745,"leves":332,"moderadas":600,"bateria":450,"tela":1600,"traseira":445,"faceid":1000,"doc_carga":600,"cam_traseira":1500,"notif_camera":1258,"notif_bateria":749,"notif_tela":749,"sort_order":44},{"nome":"iPhone 16 128GB","base":3245,"leves":297,"moderadas":600,"bateria":600,"tela":1400,"traseira":395,"faceid":1000,"doc_carga":800,"cam_traseira":1500,"notif_camera":1498,"notif_bateria":649,"notif_tela":649,"sort_order":45},{"nome":"iPhone 16 256GB","base":3440,"leves":311,"moderadas":600,"bateria":600,"tela":1400,"traseira":414,"faceid":1000,"doc_carga":800,"cam_traseira":1500,"notif_camera":1298,"notif_bateria":688,"notif_tela":688,"sort_order":46},{"nome":"iPhone 16 512GB","base":3540,"leves":318,"moderadas":600,"bateria":600,"tela":1400,"traseira":424,"faceid":1000,"doc_carga":800,"cam_traseira":1500,"notif_camera":1376,"notif_bateria":708,"notif_tela":708,"sort_order":47},{"nome":"iPhone 16 Pro 128GB","base":3740,"leves":332,"moderadas":600,"bateria":800,"tela":1900,"traseira":444,"faceid":1200,"doc_carga":800,"cam_traseira":1900,"notif_camera":1416,"notif_bateria":748,"notif_tela":748,"sort_order":48},{"nome":"iPhone 16 Pro 256GB","base":4070,"leves":355,"moderadas":600,"bateria":800,"tela":1900,"traseira":477,"faceid":1200,"doc_carga":800,"cam_traseira":1900,"notif_camera":1496,"notif_bateria":814,"notif_tela":814,"sort_order":49},{"nome":"iPhone 16 Pro 512GB","base":3840,"leves":339,"moderadas":600,"bateria":800,"tela":1900,"traseira":454,"faceid":1200,"doc_carga":800,"cam_traseira":1900,"notif_camera":1628,"notif_bateria":768,"notif_tela":768,"sort_order":50},{"nome":"iPhone 16 Pro 1TB","base":3940,"leves":346,"moderadas":600,"bateria":800,"tela":1900,"traseira":464,"faceid":1200,"doc_carga":800,"cam_traseira":1900,"notif_camera":1536,"notif_bateria":788,"notif_tela":788,"sort_order":51},{"nome":"iPhone 16 Pro Max 256GB","base":4540,"leves":388,"moderadas":600,"bateria":800,"tela":3000,"traseira":524,"faceid":1500,"doc_carga":800,"cam_traseira":1900,"notif_camera":1576,"notif_bateria":908,"notif_tela":908,"sort_order":52},{"nome":"iPhone 16 Pro Max 512GB","base":4440,"leves":381,"moderadas":600,"bateria":800,"tela":3000,"traseira":514,"faceid":1500,"doc_carga":800,"cam_traseira":1900,"notif_camera":1816,"notif_bateria":888,"notif_tela":888,"sort_order":53},{"nome":"iPhone 16 Pro Max 1TB","base":4640,"leves":395,"moderadas":600,"bateria":800,"tela":3000,"traseira":534,"faceid":1500,"doc_carga":800,"cam_traseira":1900,"notif_camera":1776,"notif_bateria":928,"notif_tela":928,"sort_order":54}];
  const insCotacao = db.prepare(`INSERT INTO cotacao_modelos
    (nome,base,leves,moderadas,bateria,tela,traseira,faceid,doc_carga,cam_traseira,notif_camera,notif_bateria,notif_tela,sort_order)
    VALUES (@nome,@base,@leves,@moderadas,@bateria,@tela,@traseira,@faceid,@doc_carga,@cam_traseira,@notif_camera,@notif_bateria,@notif_tela,@sort_order)`);
  const txCotacao = db.transaction((linhas) => linhas.forEach((l) => insCotacao.run(l)));
  txCotacao(seedCotacao);
}

// NOVO modelo de troca (pedido do dono): quando a troca nao tem dinheiro suficiente pra cobrir o
// custo do item que saiu (ex: troca direta sem grana, ou troca com "volta" pequena), o lucro
// dessa venda NUNCA fica negativo — o que falta de cobertura e transferido pro produto de DESTINO
// (o item que entrou no lugar), na mesma proporcao de investimento que os socios tinham no produto
// de origem. O custo nao vira prejuizo, ele "muda de produto": o item novo passa a carregar o
// custo que faltou cobrir. Se o valor recebido cobre o custo inteiro (ou nem e troca), funciona
// igual venda normal: lucro = valor − custo, sem transferir nada (calcularVendaComTroca).
// Roda uma vez, idempotente (custo_transferido so fica >0 depois de aplicada), pras trocas que ja
// existiam antes dessa mudanca e ainda estavam com lucro negativo.
//
// IMPORTANTE: as trocas que ja existiam no banco (cadastradas na mao pelo dono depois da
// reimportacao da planilha) tem o produto de DESTINO com o custo_total JA batendo com o valor da
// troca (confirmado com o dono: o custo do produto recebido ja É o valor do item trocado, nao e
// dinheiro separado). Por isso essa correcao retroativa so ZERA o lucro dessas vendas — NAO soma
// nada de novo no custo_total do destino, pra nao duplicar um valor que ja esta la. So a partir de
// agora (vendas novas, ou trocas com destino que ainda nao tem custo proprio) que o sistema faz a
// transferencia de verdade sozinho — ver calcularVendaComTroca.
{
  const trocasSemAjuste = db.prepare(`
    SELECT * FROM vendas
    WHERE eh_troca = 1 AND produto_destino_id IS NOT NULL
      AND (custo_transferido IS NULL OR custo_transferido = 0)
      AND custo IS NOT NULL AND (custo - valor_vendido) > 0.01
  `).all();
  for (const v of trocasSemAjuste) {
    const deficit = v.custo - v.valor_vendido;
    db.prepare('UPDATE vendas SET lucro=0, custo_transferido=? WHERE id=?').run(deficit, v.id);
    db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
      .run(v.produto_destino_id, null, 'lucro_troca_zerado_custo_ja_no_destino', JSON.stringify({ venda_id: v.id, deficit, aviso: 'custo do produto de destino ja incluia o valor da troca, nao foi somado de novo' }));
  }
}

// Reparo (uma vez, idempotente) do estrago causado pelo bug acima (bloco antigo removido): pra
// toda troca onde custo_transferido>0 mas o lucro nao esta zerado (sinal claro de que o bloco
// antigo reverteu essa venda num reinicio anterior do servidor), restaura o custo_total do
// produto de origem e do produto de destino usando a soma dos investimentos por socio de cada um
// como referencia — os investimentos NUNCA foram mexidos pela corrupcao, entao continuam sendo o
// valor certo — e zera o lucro da venda de novo.
{
  const corrompidas = db.prepare(`
    SELECT * FROM vendas WHERE eh_troca = 1 AND produto_destino_id IS NOT NULL
      AND custo_transferido > 0 AND lucro != 0
  `).all();
  for (const v of corrompidas) {
    const origem = db.prepare('SELECT * FROM produtos WHERE id=?').get(v.produto_id);
    const destino = db.prepare('SELECT * FROM produtos WHERE id=?').get(v.produto_destino_id);
    if (origem) {
      const somaOrigem = investimentosDoProduto(origem.id).reduce((s, i) => s + i.valor, 0);
      db.prepare('UPDATE produtos SET custo_total=? WHERE id=?').run(somaOrigem, origem.id);
    }
    if (destino) {
      const somaDestino = investimentosDoProduto(destino.id).reduce((s, i) => s + i.valor, 0);
      db.prepare('UPDATE produtos SET custo_total=? WHERE id=?').run(somaDestino, destino.id);
    }
    db.prepare('UPDATE vendas SET lucro=0 WHERE id=?').run(v.id);
    db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
      .run(v.produto_id, null, 'corrigido_bug_reversao_troca_no_restart', JSON.stringify({ venda_id: v.id }));
  }
}

const ok  = (res, data) => res.json({ ok: true, data });
const err = (res, msg, s = 400) => res.status(s).json({ ok: false, error: msg });

// ---------- AUTH ----------
function requireAuth(req, res, next) {
  const token = req.cookies.sessao;
  if (!token) return err(res, 'Nao autenticado', 401);
  const sess = db.prepare('SELECT * FROM sessoes WHERE token=?').get(token);
  if (!sess || new Date(sess.expira_em) < new Date()) return err(res, 'Sessao expirada', 401);
  const user = db.prepare('SELECT id, nome, email, is_admin FROM usuarios WHERE id=?').get(sess.usuario_id);
  if (!user) return err(res, 'Usuario nao encontrado', 401);
  user.is_admin = !!user.is_admin;
  req.user = user;
  next();
}

app.post('/api/auth/registrar', (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return err(res, 'Nome, email e senha obrigatorios');
  if (senha.length < 6) return err(res, 'Senha precisa de ao menos 6 caracteres');

  const totalUsuarios = db.prepare('SELECT COUNT(*) as n FROM usuarios').get().n;
  const ehPrimeiroUsuario = totalUsuarios === 0;
  if (!ehPrimeiroUsuario) {
    const token = req.cookies.sessao;
    const sess = token && db.prepare('SELECT * FROM sessoes WHERE token=?').get(token);
    const logado = sess && new Date(sess.expira_em) >= new Date();
    if (!logado) return err(res, 'Cadastro fechado. Peça para quem já tem acesso te cadastrar.', 403);
  }

  const existe = db.prepare('SELECT id FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (existe) return err(res, 'Email ja cadastrado');
  const hash = bcrypt.hashSync(senha, 10);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, is_admin) VALUES (?,?,?,?)')
    .run(nome, email.toLowerCase(), hash, ehPrimeiroUsuario ? 1 : 0);

  // ja loga direto (sem precisar preencher o formulario de login de novo logo em seguida) —
  // so acontece na tela de cadastro publica (deslogada), entao nao ha sessao de outra pessoa
  // sendo trocada por engano aqui.
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?,?,?)').run(token, r.lastInsertRowid, expira);
  res.cookie('sessao', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });

  ok(res, { id: r.lastInsertRowid, nome, email: email.toLowerCase() });
});

app.post('/api/auth/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return err(res, 'Email e senha obrigatorios');
  const user = db.prepare('SELECT * FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(senha, user.senha_hash)) return err(res, 'Credenciais invalidas', 401);
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?,?,?)').run(token, user.id, expira);
  res.cookie('sessao', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  ok(res, { id: user.id, nome: user.nome, email: user.email });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessoes WHERE token=?').run(req.cookies.sessao);
  res.clearCookie('sessao');
  ok(res, { msg: 'Deslogado' });
});

app.get('/api/auth/me', requireAuth, (req, res) => ok(res, req.user));

// tudo abaixo exige login
app.use('/api', requireAuth);

// ---------- USUARIOS (quem tem acesso ao sistema) ----------
app.get('/api/usuarios', (_, res) => {
  ok(res, db.prepare('SELECT id, nome, email, is_admin, criado_em FROM usuarios ORDER BY criado_em').all()
    .map(u => ({ ...u, is_admin: !!u.is_admin })));
});

app.post('/api/usuarios', (req, res) => {
  // mesma regra do cadastro publico (endpoint /api/auth/registrar), so que exposta dentro do
  // app pra quem ja esta logado nao precisar deslogar pra convidar outra pessoa.
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return err(res, 'Nome, email e senha obrigatorios');
  if (senha.length < 6) return err(res, 'Senha precisa de ao menos 6 caracteres');
  const existe = db.prepare('SELECT id FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (existe) return err(res, 'Email ja cadastrado');
  const hash = bcrypt.hashSync(senha, 10);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, is_admin) VALUES (?,?,?,0)')
    .run(nome, email.toLowerCase(), hash);
  ok(res, { id: r.lastInsertRowid, nome, email: email.toLowerCase() });
});

// Troca a senha de qualquer usuario direto pelo painel — sem precisar de codigo de recuperacao.
// Qualquer pessoa logada pode trocar a senha de qualquer conta (mesmo modelo de permissao
// simplificado do resto do app: 2 socios, confianca mutua, sem papeis granulares).
app.put('/api/usuarios/:id/senha', (req, res) => {
  const alvo = db.prepare('SELECT id FROM usuarios WHERE id=?').get(req.params.id);
  if (!alvo) return err(res, 'Usuario nao encontrado', 404);
  const { novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) return err(res, 'Senha precisa de ao menos 6 caracteres');
  const hash = bcrypt.hashSync(novaSenha, 10);
  db.prepare('UPDATE usuarios SET senha_hash=? WHERE id=?').run(hash, alvo.id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(alvo.id); // desloga a conta, precisa entrar com a senha nova
  ok(res, { id: alvo.id });
});

app.delete('/api/usuarios/:id', (req, res) => {
  const alvo = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
  if (!alvo) return err(res, 'Usuario nao encontrado', 404);
  if (alvo.id === req.user.id) return err(res, 'Voce nao pode excluir a propria conta por aqui.');
  const total = db.prepare('SELECT COUNT(*) as n FROM usuarios').get().n;
  if (total <= 1) return err(res, 'Precisa sobrar pelo menos um usuario com acesso.');
  db.prepare('DELETE FROM usuarios WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- SOCIOS ----------
app.get('/api/socios', (_, res) => ok(res, db.prepare('SELECT * FROM socios ORDER BY nome').all()));
app.post('/api/socios', (req, res) => {
  const { nome } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  try {
    const r = db.prepare('INSERT INTO socios (nome) VALUES (?)').run(nome.trim());
    ok(res, db.prepare('SELECT * FROM socios WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { err(res, 'Ja existe um socio com esse nome'); }
});
app.put('/api/socios/:id', (req, res) => {
  const { nome, ativo } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  db.prepare('UPDATE socios SET nome=?, ativo=? WHERE id=?').run(nome.trim(), ativo === false ? 0 : 1, req.params.id);
  ok(res, db.prepare('SELECT * FROM socios WHERE id=?').get(req.params.id));
});

// ---------- HELPERS DE CALCULO ----------
// custo_unitario: divide o custo total do produto/lote pela quantidade total de unidades.
function custoUnitario(produto) {
  return produto.quantidade_total > 0 ? produto.custo_total / produto.quantidade_total : 0;
}

// status derivado: se tem status manual definido (ex: "Troca (R$125 a receber)") ele prevalece;
// senao e calculado a partir do estoque restante.
function statusProduto(produto) {
  if (produto.status_manual && produto.status_manual.trim()) return produto.status_manual;
  const restante = produto.quantidade_total - produto.quantidade_vendida;
  if (restante <= 0) return produto.quantidade_total > 1 ? 'Esgotado' : 'Vendido';
  return 'Disponível';
}

function investimentosDoProduto(produtoId) {
  return db.prepare(`
    SELECT pi.*, s.nome as socio_nome FROM produto_investimentos pi
    JOIN socios s ON s.id = pi.socio_id
    WHERE pi.produto_id = ?
  `).all(produtoId);
}

function vendasDoProduto(produtoId) {
  return db.prepare('SELECT * FROM vendas WHERE produto_id=? ORDER BY data_venda').all(produtoId);
}

// Proporcao de investimento de cada socio num produto (pra saber como dividir um valor
// transferido pra outro produto). Se o produto nao tem investimento registrado (ou custo_total
// e 0 — ex: recebido so por troca, sem grana), divide igual entre os socios ativos.
function proporcoesInvestimento(produtoId) {
  const investimentos = investimentosDoProduto(produtoId);
  const total = investimentos.reduce((s, i) => s + i.valor, 0);
  if (total > 0) return investimentos.map(i => ({ socio_id: i.socio_id, proporcao: i.valor / total }));
  const socios = db.prepare('SELECT id FROM socios WHERE ativo=1').all();
  if (!socios.length) return [];
  return socios.map(s => ({ socio_id: s.id, proporcao: 1 / socios.length }));
}

// Move `valor` do custo pro produto de DESTINO de uma troca (soma no custo_total dele e no
// investimento de cada socio, na mesma proporcao que tinham no produto de origem). Devolve o
// split exato (quanto cada socio recebeu) pra dar pra desfazer com precisao depois, se a venda
// for editada ou excluida.
function aplicarTransferenciaCusto(destinoId, valor, proporcoes) {
  if (valor <= 0 || !proporcoes.length) return {};
  db.prepare('UPDATE produtos SET custo_total = custo_total + ? WHERE id=?').run(valor, destinoId);
  const upsert = db.prepare(`
    INSERT INTO produto_investimentos (produto_id, socio_id, valor) VALUES (?,?,?)
    ON CONFLICT(produto_id, socio_id) DO UPDATE SET valor = valor + excluded.valor
  `);
  const split = {};
  for (const p of proporcoes) {
    const parte = valor * p.proporcao;
    upsert.run(destinoId, p.socio_id, parte);
    split[p.socio_id] = parte;
  }
  return split;
}

// Desfaz uma transferencia anterior (edicao/exclusao de venda): tira do custo_total do destino e
// do investimento de cada socio exatamente o valor gravado no split (nao recalcula proporcao
// nova). Trava em 0 pra nao ficar negativo se o produto ja foi mexido manualmente depois.
function reverterTransferenciaCusto(destinoId, split) {
  if (!destinoId || !split) return;
  const destino = db.prepare('SELECT id FROM produtos WHERE id=?').get(destinoId);
  if (!destino) return; // produto de destino ja foi excluido — nao ha o que reverter
  const totalSplit = Object.values(split).reduce((s, v) => s + v, 0);
  db.prepare('UPDATE produtos SET custo_total = MAX(0, custo_total - ?) WHERE id=?').run(totalSplit, destinoId);
  const upd = db.prepare('UPDATE produto_investimentos SET valor = MAX(0, valor - ?) WHERE produto_id=? AND socio_id=?');
  for (const socioId of Object.keys(split)) upd.run(split[socioId], destinoId, Number(socioId));
}

// Calcula o custo/lucro de uma venda (usa o custo_total do produto no momento exato da venda) e,
// se for troca com destino e o dinheiro recebido nao cobrir o custo inteiro, transfere a
// diferenca pro produto de destino em vez de deixar a venda no prejuizo — o item que saiu virou o
// item que entrou, o custo so muda de produto, nao vira perda. O resultado e gravado nas colunas
// custo/lucro/custo_transferido da propria venda e nunca mais recalculado depois — se o custo do
// produto mudar no futuro, vendas ja registradas NAO mudam de valor retroativamente.
function calcularVendaComTroca(produto, destinoId, venda) {
  const custo = custoUnitario(produto) * venda.quantidade;
  const deficit = custo - venda.valor_vendido;
  if (destinoId && deficit > 0.01) {
    const proporcoes = proporcoesInvestimento(produto.id);
    const split = aplicarTransferenciaCusto(destinoId, deficit, proporcoes);
    return { custo, lucro: 0, transferido: deficit, split };
  }
  return { custo, lucro: venda.valor_vendido - custo, transferido: 0, split: null };
}

// Le o custo/lucro JA CONGELADO de uma venda existente (gravado na hora em que ela foi criada
// ou editada). Nunca recalcula a partir do produto — e assim que se evita o retrocalculo.
function lerVendaCongelada(venda) {
  return { custo: venda.custo ?? 0, lucro: venda.lucro ?? 0 };
}

// Farol de performance: classifica o retorno de uma venda (ou de um produto, agregando todas as
// vendas dele) com base no % de lucro sobre o custo. Troca sem dinheiro suficiente pra cobrir o
// custo (lucro sempre 0 por design — ver calcularVendaComTroca) NAO entra na cor: ganha um selo
// neutro "troca", porque nao houve retorno em dinheiro pra medir, e nao e justo marcar como Ruim.
// Prejuízo de verdade (retorno negativo, venda com dinheiro mesmo) entra junto no vermelho.
function classificarFarol(lucro, custo, ehTrocaSemDinheiro) {
  if (ehTrocaSemDinheiro) return { tipo: 'troca' };
  if (!(custo > 0)) return null; // sem base pra calcular retorno (produto de custo zero)
  const retorno = (lucro / custo) * 100;
  const cor = retorno >= 50 ? 'verde' : retorno >= 30 ? 'amarelo' : 'vermelho';
  return { tipo: 'cor', cor, retorno };
}

function retratoProduto(produto) {
  const investimentos = investimentosDoProduto(produto.id);
  const totalInvestido = investimentos.reduce((s, i) => s + i.valor, 0);
  const socioIds = investimentos.map(i => i.socio_id);
  const nSocios = socioIds.length || 1;
  const vendas = vendasDoProduto(produto.id);

  let lucroTotalRealizado = 0, arrecadadoTotal = 0, custoVendidoTotal = 0;
  let todasSaoTrocaSemDinheiro = vendas.length > 0;
  const vendasCalc = vendas.map(v => {
    const { custo, lucro } = lerVendaCongelada(v);
    const ehTrocaSemDinheiro = !!(v.eh_troca && v.custo_transferido > 0);
    if (!ehTrocaSemDinheiro) todasSaoTrocaSemDinheiro = false;
    lucroTotalRealizado += lucro;
    arrecadadoTotal += v.valor_vendido;
    custoVendidoTotal += custo;
    return { ...v, custo, lucro, farol: classificarFarol(lucro, custo, ehTrocaSemDinheiro) };
  });
  // farol do produto: agrega todas as vendas dele com a mesma regra (mesma cor pro mesmo caso em
  // qualquer tela). So troca se TODAS as vendas realizadas foram troca sem dinheiro — se teve
  // pelo menos uma venda com dinheiro de verdade, o retorno agregado entra na conta normal.
  const farolProduto = produto.quantidade_vendida > 0
    ? classificarFarol(lucroTotalRealizado, custoVendidoTotal, todasSaoTrocaSemDinheiro)
    : null;

  const restante = produto.quantidade_total - produto.quantidade_vendida;
  const custoUnit = custoUnitario(produto);
  const lucroMinEstimadoAberto = produto.lucro_minimo != null ? produto.lucro_minimo * Math.max(restante, 0) : null;
  const lucroMaxEstimadoAberto = (produto.preco_anuncio != null)
    ? (produto.preco_anuncio - custoUnit) * Math.max(restante, 0) : null;

  // retorno por socio = valor que ele investiu (proporcional ao que ja foi vendido) + sua fatia do lucro ja realizado
  const porSocio = investimentos.map(inv => {
    const fracaoInvestidaVendida = produto.quantidade_total > 0
      ? (inv.valor / produto.quantidade_total) * produto.quantidade_vendida : 0;
    const lucroDoSocio = lucroTotalRealizado / nSocios;
    return {
      socio_id: inv.socio_id,
      socio_nome: inv.socio_nome,
      investido: inv.valor,
      retorno: produto.quantidade_vendida > 0 ? fracaoInvestidaVendida + lucroDoSocio : 0,
      lucro: produto.quantidade_vendida > 0 ? lucroDoSocio : 0,
      em_aberto: restante > 0
    };
  });

  return {
    ...produto,
    status: statusProduto(produto),
    custo_unitario: custoUnit,
    quantidade_restante: restante,
    total_investido: totalInvestido,
    investimentos,
    vendas: vendasCalc,
    farol: farolProduto,
    arrecadado_total: arrecadadoTotal,
    lucro_total_realizado: lucroTotalRealizado,
    lucro_min_estimado_aberto: lucroMinEstimadoAberto,
    lucro_max_estimado_aberto: lucroMaxEstimadoAberto,
    por_socio: porSocio
  };
}

// ---------- PRODUTOS ----------
app.get('/api/produtos', (req, res) => {
  const produtos = db.prepare('SELECT * FROM produtos ORDER BY criado_em DESC').all();
  ok(res, produtos.map(retratoProduto));
});

app.get('/api/produtos/:id', (req, res) => {
  const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
  if (!produto) return err(res, 'Produto nao encontrado', 404);
  ok(res, retratoProduto(produto));
});

// ---------- IMPORTAR PLANILHA (.xlsx) ----------
// Sobe a planilha (mesmo layout da KNBRIK: aba "Produtos"), reconcilia os dados (quantidade
// vendida a partir do status, vendas so entram se o valor bater com o lucro real declarado) e
// grava direto no banco. SKUs que ja existem sao pulados (nao duplica se importar de novo).
app.post('/api/produtos/importar-planilha', (req, res) => {
  uploadPlanilha.single('planilha')(req, res, (uerr) => {
    if (uerr) return err(res, uerr.message);
    if (!req.file) return err(res, 'Nenhum arquivo enviado');
    let resultado;
    try {
      resultado = processarPlanilha(req.file.buffer);
    } catch (e) {
      return err(res, 'Erro ao ler a planilha: ' + e.message);
    }

    function socioId(nome) {
      let s = db.prepare('SELECT id FROM socios WHERE nome=?').get(nome);
      if (!s) {
        const r = db.prepare('INSERT INTO socios (nome) VALUES (?)').run(nome);
        s = { id: r.lastInsertRowid };
      }
      return s.id;
    }

    let criados = 0, pulados = 0, vendasCriadas = 0;
    try {
      const transacao = db.transaction((produtos) => {
        for (const p of produtos) {
          const existente = db.prepare('SELECT id FROM produtos WHERE sku=?').get(p.sku);
          if (existente) { pulados++; continue; }

          const r = db.prepare(`INSERT INTO produtos
            (sku,nome,categoria,condicao,quantidade_total,custo_total,data_compra,preco_anuncio,lucro_minimo,status_manual,obs,criado_por)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(p.sku, p.nome, p.categoria, p.condicao, p.quantidade_total, p.custo_total,
                 p.data_compra, p.preco_anuncio, p.lucro_minimo, p.status_manual, p.obs, req.user.id);
          const produtoId = r.lastInsertRowid;

          const insInv = db.prepare('INSERT INTO produto_investimentos (produto_id, socio_id, valor) VALUES (?,?,?)');
          for (const inv of p.investimentos) insInv.run(produtoId, socioId(inv.socio), inv.valor);

          if (p.venda) {
            // BUG corrigido: essa insercao nao gravava custo/lucro (colunas que existem pra
            // "congelar" o resultado da venda na hora em que ela acontece — ver calcularVendaNova).
            // Ficava NULL, e lerVendaCongelada le NULL como 0 — por isso o lucro por socio (mensal
            // e semanal) aparecia sempre zerado pra toda venda que entrou por importacao de planilha,
            // mesmo com "Arrecadado" certo (que vem direto de valor_vendido, sem passar por isso).
            const custoUnit = p.quantidade_total > 0 ? p.custo_total / p.quantidade_total : 0;
            const custoVenda = custoUnit * p.venda.quantidade;
            const lucroVenda = p.venda.valor_vendido - custoVenda;
            db.prepare(`INSERT INTO vendas (produto_id,quantidade,valor_vendido,canal_venda,data_venda,obs,usuario_id,custo,lucro)
              VALUES (?,?,?,?,?,?,?,?,?)`)
              .run(produtoId, p.venda.quantidade, p.venda.valor_vendido, p.venda.canal_venda, p.venda.data_venda, p.venda.obs, req.user.id, custoVenda, lucroVenda);
            db.prepare('UPDATE produtos SET quantidade_vendida = quantidade_vendida + ? WHERE id=?')
              .run(p.venda.quantidade, produtoId);
            vendasCriadas++;
          }

          db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
            .run(produtoId, req.user.id, 'importado_da_planilha', JSON.stringify(p));
          criados++;
        }
      });
      transacao(resultado.produtos);
    } catch (e) {
      return err(res, 'Erro ao gravar no banco: ' + e.message, 500);
    }

    ok(res, { criados, pulados, vendasCriadas, avisos: resultado.avisos, total: resultado.produtos.length });
  });
});

function gerarSku(db) {
  const ultimo = db.prepare("SELECT sku FROM produtos WHERE sku LIKE 'KNB%' ORDER BY id DESC LIMIT 1").get();
  let n = 1;
  if (ultimo && /^KNB(\d+)$/.test(ultimo.sku)) n = parseInt(ultimo.sku.slice(3), 10) + 1;
  return 'KNB' + String(n).padStart(3, '0');
}

function salvarInvestimentos(produtoId, investimentos, custoTotal) {
  db.prepare('DELETE FROM produto_investimentos WHERE produto_id=?').run(produtoId);
  const soma = (investimentos || []).reduce((s, i) => s + (Number(i.valor) || 0), 0);
  if (Math.abs(soma - custoTotal) > 0.01) {
    throw new Error(`A soma dos valores pagos por socio (R$${soma.toFixed(2)}) precisa bater com o custo total (R$${custoTotal.toFixed(2)}).`);
  }
  const ins = db.prepare('INSERT INTO produto_investimentos (produto_id, socio_id, valor) VALUES (?,?,?)');
  for (const inv of (investimentos || [])) {
    if (inv.socio_id && Number(inv.valor) > 0) ins.run(produtoId, inv.socio_id, Number(inv.valor));
  }
}

app.post('/api/produtos', (req, res) => {
  const b = req.body;
  try {
    if (!b.nome) return err(res, 'Nome obrigatorio');
    if (b.custo_total === undefined || b.custo_total === null || b.custo_total === '' || Number(b.custo_total) < 0)
      return err(res, 'Custo total obrigatorio (pode ser 0 se o produto foi recebido só por troca, sem gastar dinheiro ainda)');
    const qtd = Math.max(1, parseInt(b.quantidade_total, 10) || 1);
    if (b.imei_serial && b.imei_serial.trim()) {
      const dup = db.prepare('SELECT id, nome FROM produtos WHERE UPPER(imei_serial) = UPPER(?)').get(b.imei_serial.trim());
      if (dup) return err(res, `IMEI/serial ja cadastrado no produto "${dup.nome}" (id ${dup.id}).`);
    }
    const sku = (b.sku && b.sku.trim()) || gerarSku(db);
    const bateriaPct = (b.bateria_pct !== undefined && b.bateria_pct !== null && b.bateria_pct !== '')
      ? Math.max(0, Math.min(100, parseInt(b.bateria_pct, 10))) : null;
    const r = db.prepare(`INSERT INTO produtos
      (sku,nome,categoria,condicao,bateria_pct,tudo_original,imei_serial,quantidade_total,custo_total,data_compra,preco_anuncio,lucro_minimo,status_manual,obs,criado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sku, b.nome, b.categoria || 'Outro', b.condicao || '', bateriaPct, b.tudo_original ? 1 : 0, b.imei_serial || '', qtd,
           Number(b.custo_total), b.data_compra || new Date().toISOString().slice(0, 10),
           b.preco_anuncio || null, b.lucro_minimo || null, b.status_manual || null, b.obs || '', req.user.id);
    const produtoId = r.lastInsertRowid;
    salvarInvestimentos(produtoId, b.investimentos, Number(b.custo_total));
    const novo = db.prepare('SELECT * FROM produtos WHERE id=?').get(produtoId);
    db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
      .run(produtoId, req.user.id, 'criado', JSON.stringify(novo));
    ok(res, retratoProduto(novo));
  } catch (e) {
    err(res, e.message, 400);
  }
});

app.put('/api/produtos/:id', (req, res) => {
  const b = req.body;
  try {
    const antes = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!antes) return err(res, 'Produto nao encontrado', 404);
    if (!b.nome) return err(res, 'Nome obrigatorio');
    if (b.custo_total === undefined || b.custo_total === null || b.custo_total === '' || Number(b.custo_total) < 0)
      return err(res, 'Custo total obrigatorio (pode ser 0 se o produto foi recebido só por troca, sem gastar dinheiro ainda)');
    const qtd = Math.max(antes.quantidade_vendida, parseInt(b.quantidade_total, 10) || 1);
    if (b.imei_serial && b.imei_serial.trim()) {
      const dup = db.prepare('SELECT id, nome FROM produtos WHERE UPPER(imei_serial) = UPPER(?) AND id != ?').get(b.imei_serial.trim(), req.params.id);
      if (dup) return err(res, `IMEI/serial ja cadastrado no produto "${dup.nome}" (id ${dup.id}).`);
    }
    const bateriaPct = (b.bateria_pct !== undefined && b.bateria_pct !== null && b.bateria_pct !== '')
      ? Math.max(0, Math.min(100, parseInt(b.bateria_pct, 10))) : null;
    db.prepare(`UPDATE produtos SET nome=?,categoria=?,condicao=?,bateria_pct=?,tudo_original=?,imei_serial=?,quantidade_total=?,custo_total=?,
      data_compra=?,preco_anuncio=?,lucro_minimo=?,status_manual=?,obs=? WHERE id=?`)
      .run(b.nome, b.categoria || 'Outro', b.condicao || '', bateriaPct, b.tudo_original ? 1 : 0, b.imei_serial || '', qtd, Number(b.custo_total),
           b.data_compra || antes.data_compra, b.preco_anuncio || null, b.lucro_minimo || null,
           b.status_manual || null, b.obs || '', req.params.id);
    if (b.investimentos !== undefined) salvarInvestimentos(req.params.id, b.investimentos, Number(b.custo_total));
    const depois = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_antes,dados_depois) VALUES (?,?,?,?,?)')
      .run(req.params.id, req.user.id, 'editado', JSON.stringify(antes), JSON.stringify(depois));
    ok(res, retratoProduto(depois));
  } catch (e) {
    err(res, e.message, 400);
  }
});

// Exclui o produto e tudo que depende dele (fotos em disco, linhas de investimento, linhas de
// foto) — o SQLite aqui nao roda com PRAGMA foreign_keys ligado, entao ON DELETE CASCADE do
// schema nao e aplicado sozinho; precisa limpar na mao pra nao deixar linha orfa no banco.
// Se forcarComVendas, apaga tambem as vendas desse produto (historico de vendas some junto —
// os totais de lucro mensal/semanal ja fechados vao mudar) e desvincula qualquer venda de OUTRO
// produto que tenha esse aqui como destino de troca (fica sem destino, mas nao quebra).
function excluirProdutoDb(produto, usuarioId, forcarComVendas) {
  if (forcarComVendas) {
    // antes de apagar as vendas desse produto, desfaz qualquer transferencia de custo que elas
    // tinham mandado pra um produto de destino (troca sem dinheiro suficiente) — senao o destino
    // fica com custo a mais que ninguem mais sabe de onde veio.
    const vendasComTransferencia = db.prepare('SELECT * FROM vendas WHERE produto_id=? AND custo_transferido > 0').all(produto.id);
    for (const v of vendasComTransferencia) {
      if (v.custo_transferido_split) reverterTransferenciaCusto(v.produto_destino_id, JSON.parse(v.custo_transferido_split));
    }
    db.prepare('DELETE FROM vendas WHERE produto_id=?').run(produto.id);
    // se esse produto era o DESTINO de alguma troca de outro produto, so desvincula a referencia —
    // o custo que foi transferido pra ele fica perdido junto (caso raro: excluir forcado um
    // produto logo depois de receber troca, antes de qualquer outra edicao).
    db.prepare('UPDATE vendas SET produto_destino_id=NULL WHERE produto_destino_id=?').run(produto.id);
  }
  const fotos = db.prepare('SELECT arquivo FROM produto_fotos WHERE produto_id=?').all(produto.id);
  for (const f of fotos) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.arquivo)); } catch (e) {} }
  db.prepare('DELETE FROM produto_fotos WHERE produto_id=?').run(produto.id);
  db.prepare('DELETE FROM produto_investimentos WHERE produto_id=?').run(produto.id);
  db.prepare('DELETE FROM produtos WHERE id=?').run(produto.id);
  db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_antes) VALUES (?,?,?,?)')
    .run(produto.id, usuarioId, forcarComVendas ? 'excluido_forcado_com_vendas' : 'excluido', JSON.stringify(produto));
}

app.delete('/api/produtos/:id', (req, res) => {
  const antes = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
  if (!antes) return err(res, 'Produto nao encontrado', 404);
  const forcar = !!(req.body && req.body.forcar);
  if (antes.quantidade_vendida > 0 && !forcar)
    return err(res, 'Produto tem vendas registradas. Marque a opcao de apagar mesmo com vendas pra excluir junto com o historico.');
  excluirProdutoDb(antes, req.user.id, forcar);
  ok(res, { id: req.params.id });
});

// ---------- ACOES EM MASSA (selecionar varios produtos na tela e exportar/excluir de uma vez) ----------
app.post('/api/produtos/exportar', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return err(res, 'Nenhum produto selecionado');
    const placeholders = ids.map(() => '?').join(',');
    const produtos = db.prepare(`SELECT * FROM produtos WHERE id IN (${placeholders})`).all(...ids);
    if (!produtos.length) return err(res, 'Nenhum produto encontrado pra esses ids');

    const linhas = produtos.map(p => {
      const investimentos = investimentosDoProduto(p.id);
      const investStr = investimentos.map(i => `${i.socio_nome}: R$ ${i.valor.toFixed(2)}`).join(' | ');
      return {
        SKU: p.sku || '',
        Nome: p.nome,
        Categoria: p.categoria,
        Condicao: p.condicao || '',
        'IMEI/Serial': p.imei_serial || '',
        'Qtd Total': p.quantidade_total,
        'Qtd Vendida': p.quantidade_vendida,
        'Qtd Restante': p.quantidade_total - p.quantidade_vendida,
        'Data Compra': p.data_compra || '',
        'Custo Total': p.custo_total,
        'Custo Unitario': custoUnitario(p),
        'Preco Anuncio': p.preco_anuncio ?? '',
        'Lucro Minimo': p.lucro_minimo ?? '',
        Status: statusProduto(p),
        'Investido por socio': investStr,
        Observacoes: p.obs || ''
      };
    });

    const ws = XLSX.utils.json_to_sheet(linhas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="kn-center-produtos.xlsx"`);
    res.send(buf);
  } catch (e) {
    err(res, e.message, 400);
  }
});

app.post('/api/produtos/excluir-em-massa', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return err(res, 'Nenhum produto selecionado');
    const forcar = !!req.body.forcar;

    let excluidos = 0;
    const bloqueados = [];
    for (const id of ids) {
      const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
      if (!produto) continue;
      if (produto.quantidade_vendida > 0 && !forcar) { bloqueados.push({ id: produto.id, label: produto.sku || produto.nome }); continue; }
      excluirProdutoDb(produto, req.user.id, forcar);
      excluidos++;
    }
    ok(res, { excluidos, bloqueados });
  } catch (e) {
    err(res, e.message, 400);
  }
});

app.get('/api/produtos/:id/historico', (req, res) => {
  ok(res, db.prepare(`
    SELECT h.*, u.nome as usuario_nome FROM produtos_auditoria h
    LEFT JOIN usuarios u ON u.id = h.usuario_id
    WHERE h.produto_id=? ORDER BY h.criado_em DESC
  `).all(req.params.id));
});

// ---------- FOTOS ----------
app.get('/api/produtos/:id/fotos', (req, res) => {
  ok(res, db.prepare('SELECT * FROM produto_fotos WHERE produto_id=? ORDER BY criado_em').all(req.params.id));
});
app.post('/api/produtos/:id/fotos', (req, res) => {
  upload.array('fotos', 10)(req, res, (uerr) => {
    if (uerr) return err(res, uerr.message);
    const produto = db.prepare('SELECT id FROM produtos WHERE id=?').get(req.params.id);
    if (!produto) return err(res, 'Produto nao encontrado', 404);
    const ins = db.prepare('INSERT INTO produto_fotos (produto_id, arquivo) VALUES (?,?)');
    const salvas = (req.files || []).map(f => {
      const r = ins.run(req.params.id, f.filename);
      return { id: r.lastInsertRowid, produto_id: parseInt(req.params.id), arquivo: f.filename };
    });
    ok(res, salvas);
  });
});
app.delete('/api/fotos/:id', (req, res) => {
  const foto = db.prepare('SELECT * FROM produto_fotos WHERE id=?').get(req.params.id);
  if (!foto) return err(res, 'Foto nao encontrada', 404);
  try { fs.unlinkSync(path.join(UPLOADS_DIR, foto.arquivo)); } catch (e) {}
  db.prepare('DELETE FROM produto_fotos WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- VENDAS ----------
// Registrar uma venda normal (com valor em dinheiro) ou uma troca (valor opcional — pode ser so
// dinheiro que entrou junto, ou zero numa troca direta). O lucro desconta o custo do produto que
// saiu NA HORA, troca ou nao. Se for troca com produto de destino selecionado E o dinheiro
// recebido nao cobrir o custo inteiro, a diferenca e transferida pro custo_total do destino (e
// pro investimento de cada socio, na mesma proporcao que tinham no produto de origem) — assim o
// lucro dessa venda nunca fica negativo, e o custo "muda de produto" em vez de virar prejuizo
// (ver calcularVendaComTroca). Sem destino selecionado, nao ha pra onde transferir.
app.post('/api/produtos/:id/vender', (req, res) => {
  try {
    const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!produto) return err(res, 'Produto nao encontrado', 404);
    const b = req.body;
    const quantidade = Math.max(1, parseInt(b.quantidade, 10) || 1);
    const restante = produto.quantidade_total - produto.quantidade_vendida;
    if (quantidade > restante) return err(res, `So restam ${restante} unidade(s) em estoque desse produto.`);
    const ehTroca = !!b.eh_troca;
    if (!ehTroca && (!b.valor_vendido || Number(b.valor_vendido) <= 0)) return err(res, 'Valor vendido obrigatorio');
    if (!b.data_venda) return err(res, 'Data da venda obrigatoria');

    let produtoDestino = null;
    if (ehTroca && b.produto_destino_id) {
      produtoDestino = db.prepare('SELECT * FROM produtos WHERE id=?').get(b.produto_destino_id);
      if (!produtoDestino) return err(res, 'Produto de destino nao encontrado');
      if (produtoDestino.id === produto.id) return err(res, 'O produto de destino precisa ser diferente do produto trocado');
    }

    const valorVendido = ehTroca ? (Number(b.valor_vendido) || 0) : Number(b.valor_vendido);
    const destinoId = produtoDestino ? produtoDestino.id : null;
    // custo/lucro sao calculados AGORA, com o custo_total do produto AGORA, e gravados —
    // nao mudam depois mesmo que o custo do produto mude (edicao manual, etc). Se for troca sem
    // dinheiro suficiente pra cobrir o custo, a diferenca e transferida pro produto de destino
    // (ver calcularVendaComTroca) — o lucro dessa venda nunca fica negativo.
    const { custo, lucro, transferido, split } = calcularVendaComTroca(produto, destinoId, { quantidade, valor_vendido: valorVendido });

    const r = db.prepare(`INSERT INTO vendas (produto_id,quantidade,valor_vendido,canal_venda,data_venda,obs,usuario_id,eh_troca,produto_destino_id,custo,lucro,custo_transferido,custo_transferido_split)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(produto.id, quantidade, valorVendido, b.canal_venda || (ehTroca ? 'Troca' : ''), b.data_venda, b.obs || '',
           req.user.id, ehTroca ? 1 : 0, destinoId, custo, lucro, transferido, split ? JSON.stringify(split) : null);
    db.prepare('UPDATE produtos SET quantidade_vendida = quantidade_vendida + ? WHERE id=?').run(quantidade, produto.id);

    const depois = db.prepare('SELECT * FROM produtos WHERE id=?').get(produto.id);
    db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_antes,dados_depois) VALUES (?,?,?,?,?)')
      .run(produto.id, req.user.id, ehTroca ? 'troca_registrada' : 'venda_registrada', JSON.stringify(produto), JSON.stringify({ venda_id: r.lastInsertRowid, ...b }));

    ok(res, retratoProduto(depois));
  } catch (e) {
    err(res, e.message, 400);
  }
});

// ---------- VENDAS (modulo global, todas as vendas de todos os produtos) ----------
// Lista todas as vendas, mais recentes primeiro, com nome/sku do produto vendido e do produto
// de destino (quando for troca). Filtro de data e o resto (busca, canal, troca) fica por conta
// do front — mesmo padrao usado em Produtos e Lancamentos (cacheia tudo, filtra no cliente).
app.get('/api/vendas', (_, res) => {
  const linhas = db.prepare(`
    SELECT v.*, p.nome AS produto_nome, p.sku AS produto_sku,
           d.nome AS produto_destino_nome, d.sku AS produto_destino_sku
    FROM vendas v
    JOIN produtos p ON p.id = v.produto_id
    LEFT JOIN produtos d ON d.id = v.produto_destino_id
    ORDER BY v.data_venda DESC, v.id DESC
  `).all();
  ok(res, linhas.map(v => {
    const { custo, lucro } = lerVendaCongelada(v);
    const farol = classificarFarol(lucro, custo, !!(v.eh_troca && v.custo_transferido > 0));
    return { ...v, custo, lucro, farol };
  }));
});

// Editar uma venda ja registrada. Troca ou venda normal — mesma regra, sem trava especial
// (nao existe mais transferencia de custo pra desfazer/refazer).
app.put('/api/vendas/:id', (req, res) => {
  try {
    const venda = db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id);
    if (!venda) return err(res, 'Venda nao encontrada', 404);
    const b = req.body;

    const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(venda.produto_id);
    if (!produto) return err(res, 'Produto da venda nao encontrado', 404);
    const novaQuantidade = Math.max(1, parseInt(b.quantidade, 10) || venda.quantidade);
    const restanteSemEssaVenda = produto.quantidade_total - produto.quantidade_vendida + venda.quantidade;
    if (novaQuantidade > restanteSemEssaVenda) return err(res, `So ha ${restanteSemEssaVenda} unidade(s) disponiveis pra essa venda.`);
    const ehTroca = b.eh_troca !== undefined ? !!b.eh_troca : !!venda.eh_troca;
    if (!ehTroca && (!b.valor_vendido || Number(b.valor_vendido) <= 0)) return err(res, 'Valor vendido obrigatorio');
    if (!b.data_venda) return err(res, 'Data da venda obrigatoria');

    const valorVendido = ehTroca ? (Number(b.valor_vendido) || 0) : Number(b.valor_vendido);
    // o formulario de edicao nao deixa trocar o produto de destino depois de criada — so
    // desfaz/refaz a transferencia com o MESMO destino, se ainda existia um.
    const destinoId = venda.produto_destino_id || null;
    if (venda.custo_transferido > 0 && venda.custo_transferido_split) {
      reverterTransferenciaCusto(venda.produto_destino_id, JSON.parse(venda.custo_transferido_split));
    }
    const { custo, lucro, transferido, split } = calcularVendaComTroca(produto, ehTroca ? destinoId : null, { quantidade: novaQuantidade, valor_vendido: valorVendido });

    db.prepare('UPDATE vendas SET quantidade=?, valor_vendido=?, canal_venda=?, data_venda=?, obs=?, eh_troca=?, custo=?, lucro=?, custo_transferido=?, custo_transferido_split=? WHERE id=?')
      .run(novaQuantidade, valorVendido, b.canal_venda || '', b.data_venda, b.obs || '', ehTroca ? 1 : 0, custo, lucro, transferido, split ? JSON.stringify(split) : null, venda.id);
    db.prepare('UPDATE produtos SET quantidade_vendida = quantidade_vendida + ? WHERE id=?')
      .run(novaQuantidade - venda.quantidade, produto.id);

    db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_antes,dados_depois) VALUES (?,?,?,?,?)')
      .run(produto.id, req.user.id, 'venda_editada', JSON.stringify(venda), JSON.stringify(b));

    ok(res, retratoProduto(db.prepare('SELECT * FROM produtos WHERE id=?').get(produto.id)));
  } catch (e) {
    err(res, e.message, 400);
  }
});

app.delete('/api/vendas/:id', (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id);
  if (!venda) return err(res, 'Venda nao encontrada', 404);
  if (venda.custo_transferido > 0 && venda.custo_transferido_split) {
    reverterTransferenciaCusto(venda.produto_destino_id, JSON.parse(venda.custo_transferido_split));
  }
  db.prepare('UPDATE produtos SET quantidade_vendida = quantidade_vendida - ? WHERE id=?').run(venda.quantidade, venda.produto_id);
  db.prepare('DELETE FROM vendas WHERE id=?').run(req.params.id);
  db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_antes) VALUES (?,?,?,?)')
    .run(venda.produto_id, req.user.id, 'venda_excluida', JSON.stringify(venda));
  ok(res, { id: req.params.id });
});

// ---------- LANCAMENTOS (despesas/receitas gerais, nao ligadas a um produto) ----------
app.get('/api/lancamentos', (_, res) => {
  ok(res, db.prepare(`
    SELECT l.*, s.nome as socio_nome FROM lancamentos l
    LEFT JOIN socios s ON s.id = l.socio_id
    ORDER BY l.data DESC, l.criado_em DESC
  `).all());
});
app.post('/api/lancamentos', (req, res) => {
  const b = req.body;
  if (!b.descricao || !b.valor || !b.data || !b.tipo) return err(res, 'Descricao, valor, data e tipo obrigatorios');
  const r = db.prepare('INSERT INTO lancamentos (tipo,descricao,valor,socio_id,data,usuario_id) VALUES (?,?,?,?,?,?)')
    .run(b.tipo, b.descricao, Number(b.valor), b.socio_id || null, b.data, req.user.id);
  ok(res, db.prepare('SELECT * FROM lancamentos WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/lancamentos/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Lancamento nao encontrado', 404);
  const b = req.body;
  if (!b.descricao || !b.valor || !b.data || !b.tipo) return err(res, 'Descricao, valor, data e tipo obrigatorios');
  db.prepare('UPDATE lancamentos SET tipo=?, descricao=?, valor=?, socio_id=?, data=? WHERE id=?')
    .run(b.tipo, b.descricao, Number(b.valor), b.socio_id || null, b.data, req.params.id);
  ok(res, db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id));
});

app.delete('/api/lancamentos/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Lancamento nao encontrado', 404);
  db.prepare('DELETE FROM lancamentos WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- COTACAO IPHONE (tabela de precos editavel por modelo) ----------
const COTACAO_CAMPOS = ['nome', 'base', 'leves', 'moderadas', 'bateria', 'tela', 'traseira',
  'faceid', 'doc_carga', 'cam_traseira', 'notif_camera', 'notif_bateria', 'notif_tela'];

app.get('/api/cotacao/modelos', (_, res) => {
  ok(res, db.prepare('SELECT * FROM cotacao_modelos ORDER BY sort_order, id').all());
});

app.post('/api/cotacao/modelos', (req, res) => {
  const b = req.body;
  if (!b.nome || !b.nome.trim()) return err(res, 'Nome do modelo obrigatorio');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as o FROM cotacao_modelos').get().o;
  const valores = { nome: b.nome.trim(), sort_order: maxOrder + 1 };
  COTACAO_CAMPOS.slice(1).forEach(c => valores[c] = Number(b[c]) || 0);
  const r = db.prepare(`INSERT INTO cotacao_modelos
    (nome,base,leves,moderadas,bateria,tela,traseira,faceid,doc_carga,cam_traseira,notif_camera,notif_bateria,notif_tela,sort_order)
    VALUES (@nome,@base,@leves,@moderadas,@bateria,@tela,@traseira,@faceid,@doc_carga,@cam_traseira,@notif_camera,@notif_bateria,@notif_tela,@sort_order)`)
    .run(valores);
  ok(res, db.prepare('SELECT * FROM cotacao_modelos WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/cotacao/modelos/:id', (req, res) => {
  const modelo = db.prepare('SELECT id FROM cotacao_modelos WHERE id=?').get(req.params.id);
  if (!modelo) return err(res, 'Modelo nao encontrado', 404);
  const b = req.body;
  if (!b.nome || !b.nome.trim()) return err(res, 'Nome do modelo obrigatorio');
  const valores = { nome: b.nome.trim(), id: req.params.id };
  COTACAO_CAMPOS.slice(1).forEach(c => valores[c] = Number(b[c]) || 0);
  db.prepare(`UPDATE cotacao_modelos SET
    nome=@nome, base=@base, leves=@leves, moderadas=@moderadas, bateria=@bateria, tela=@tela,
    traseira=@traseira, faceid=@faceid, doc_carga=@doc_carga, cam_traseira=@cam_traseira,
    notif_camera=@notif_camera, notif_bateria=@notif_bateria, notif_tela=@notif_tela
    WHERE id=@id`).run(valores);
  ok(res, db.prepare('SELECT * FROM cotacao_modelos WHERE id=?').get(req.params.id));
});

app.delete('/api/cotacao/modelos/:id', (req, res) => {
  const modelo = db.prepare('SELECT id FROM cotacao_modelos WHERE id=?').get(req.params.id);
  if (!modelo) return err(res, 'Modelo nao encontrado', 404);
  db.prepare('DELETE FROM cotacao_modelos WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- CONFIG ----------
app.get('/api/config/meta-semanal', (_, res) => {
  const row = db.prepare("SELECT valor FROM config WHERE chave='meta_semanal_por_socio'").get();
  ok(res, { meta_semanal_por_socio: Number(row ? row.valor : 1000) });
});
app.put('/api/config/meta-semanal', (req, res) => {
  const v = Number(req.body.meta_semanal_por_socio);
  if (!v || v <= 0) return err(res, 'Valor de meta invalido');
  db.prepare("INSERT INTO config (chave, valor) VALUES ('meta_semanal_por_socio', ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(String(v));
  ok(res, { meta_semanal_por_socio: v });
});

// Meta especifica de UMA semana (por socio), que sobrescreve a meta padrao so naquela semana.
// :semana e a segunda-feira daquela semana, no formato AAAA-MM-DD (mesma chave que o dashboard
// semanal usa pra agrupar as vendas — ver chaveSemana).
app.put('/api/config/meta-semanal/:semana', (req, res) => {
  const v = Number(req.body.valor_por_socio);
  if (!v || v <= 0) return err(res, 'Valor de meta invalido');
  db.prepare(`INSERT INTO metas_semanais (semana, valor_por_socio) VALUES (?,?)
    ON CONFLICT(semana) DO UPDATE SET valor_por_socio=excluded.valor_por_socio`).run(req.params.semana, v);
  ok(res, { semana: req.params.semana, valor_por_socio: v });
});
// Remove a meta especifica dessa semana — volta a usar a meta padrao.
app.delete('/api/config/meta-semanal/:semana', (req, res) => {
  db.prepare('DELETE FROM metas_semanais WHERE semana=?').run(req.params.semana);
  ok(res, { semana: req.params.semana });
});

// ---------- DASHBOARDS ----------
function todosProdutosComRetrato() {
  return db.prepare('SELECT * FROM produtos').all().map(retratoProduto);
}

// Resumo aceita ?de=YYYY-MM-DD&ate=YYYY-MM-DD (opcional, os dois independentes).
// Estoque/investido/estimativas em aberto sempre refletem o estado ATUAL (nao faz sentido
// filtrar por data — sao uma fotografia de agora). Ja o que e "fluxo" (vendas realizadas,
// lucro, arrecadado, lancamentos) e filtrado pelo periodo escolhido.
app.get('/api/dashboard/resumo', (req, res) => {
  const { de, ate } = req.query;
  const dentroPeriodo = (data) => (!de || data >= de) && (!ate || data <= ate);

  const produtos = todosProdutosComRetrato();
  const socios = db.prepare('SELECT * FROM socios WHERE ativo=1 ORDER BY nome').all();

  const totalInvestido = produtos.reduce((s, p) => s + p.total_investido, 0);
  const produtosEmAberto = produtos.filter(p => p.quantidade_restante > 0).length;
  const produtosEsgotados = produtos.filter(p => p.quantidade_restante <= 0).length;
  const lucroMinAberto = produtos.reduce((s, p) => s + (p.lucro_min_estimado_aberto || 0), 0);
  const lucroMaxAberto = produtos.reduce((s, p) => s + (p.lucro_max_estimado_aberto || 0), 0);

  const porSocioMap = {};
  socios.forEach(s => porSocioMap[s.id] = { socio_id: s.id, socio_nome: s.nome, investido: 0, lucro: 0 });

  let totalArrecadado = 0, lucroRealTotal = 0;
  produtos.forEach(p => {
    p.por_socio.forEach(linha => {
      if (porSocioMap[linha.socio_id]) porSocioMap[linha.socio_id].investido += linha.investido;
    });
    const investimentos = investimentosDoProduto(p.id);
    const nSocios = investimentos.length || 1;
    p.vendas.forEach(v => {
      if (!dentroPeriodo(v.data_venda)) return;
      totalArrecadado += v.valor_vendido;
      lucroRealTotal += v.lucro;
      investimentos.forEach(inv => {
        if (porSocioMap[inv.socio_id]) porSocioMap[inv.socio_id].lucro += v.lucro / nSocios;
      });
    });
  });

  const lancamentos = db.prepare('SELECT * FROM lancamentos').all().filter(l => dentroPeriodo(l.data));
  const saldoLancamentos = lancamentos.reduce((s, l) => s + (l.tipo === 'entrada' ? l.valor : -l.valor), 0);

  ok(res, {
    periodo_filtrado: !!(de || ate),
    total_investido: totalInvestido,
    produtos_em_aberto: produtosEmAberto,
    produtos_esgotados: produtosEsgotados,
    total_arrecadado: totalArrecadado,
    lucro_real_total: lucroRealTotal,
    lucro_min_estimado_aberto: lucroMinAberto,
    lucro_max_estimado_aberto: lucroMaxAberto,
    saldo_lancamentos_gerais: saldoLancamentos,
    por_socio: Object.values(porSocioMap)
  });
});

app.get('/api/dashboard/disponiveis', (_, res) => {
  const produtos = todosProdutosComRetrato().filter(p => p.quantidade_restante > 0);
  ok(res, produtos.map(p => ({
    id: p.id, sku: p.sku, nome: p.nome, quantidade_restante: p.quantidade_restante,
    data_compra: p.data_compra, custo_total_restante: p.custo_unitario * p.quantidade_restante,
    preco_anuncio: p.preco_anuncio, lucro_minimo: p.lucro_minimo,
    margem_anuncio: p.preco_anuncio != null ? p.preco_anuncio - p.custo_unitario : null,
    margem_minima: p.lucro_minimo
  })));
});

// ---------- CATALOGO PUBLICO (sem login — link pra mandar pro cliente) ----------
// Fora do prefixo /api de proposito, pra nunca cair sob o requireAuth (ver app.use('/api', ...)
// mais abaixo) nem por engano numa edicao futura. So os campos seguros de mostrar pra fora: nome,
// categoria, condicao, preco de anuncio e fotos. NUNCA custo, investimento por socio, lucro
// minimo, IMEI/serial, observacoes internas ou quantidade exata em estoque — lista feita a mao
// (SELECT explicito), nao reaproveita retratoProduto() de proposito, pra nao arriscar vazar campo
// novo que outra rota venha a adicionar la no futuro sem querer.
app.get('/publico/catalogo', (_, res) => {
  const produtos = db.prepare(`
    SELECT id, nome, categoria, condicao, bateria_pct, tudo_original, preco_anuncio, quantidade_total, quantidade_vendida
    FROM produtos ORDER BY criado_em DESC
  `).all().filter(p => (p.quantidade_total - p.quantidade_vendida) > 0);
  const fotosStmt = db.prepare('SELECT arquivo FROM produto_fotos WHERE produto_id=? ORDER BY criado_em');
  ok(res, produtos.map(p => ({
    id: p.id,
    nome: p.nome,
    categoria: p.categoria,
    condicao: p.condicao || '',
    bateria_pct: p.bateria_pct != null ? p.bateria_pct : null,
    tudo_original: !!p.tudo_original,
    preco_anuncio: p.preco_anuncio,
    fotos: fotosStmt.all(p.id).map(f => '/uploads/' + f.arquivo)
  })));
});

function chaveSemana(data) {
  const d = new Date(data + 'T12:00:00');
  const diaSemana = (d.getDay() + 6) % 7; // segunda=0 ... domingo=6
  const segunda = new Date(d); segunda.setDate(d.getDate() - diaSemana);
  const domingo = new Date(segunda); domingo.setDate(segunda.getDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { chave: fmt(segunda), inicio: fmt(segunda), fim: fmt(domingo) };
}

app.get('/api/dashboard/semanal', (_, res) => {
  const produtos = db.prepare('SELECT * FROM produtos').all();
  const produtosPorId = Object.fromEntries(produtos.map(p => [p.id, p]));
  const vendas = db.prepare('SELECT * FROM vendas ORDER BY data_venda').all();
  const socios = db.prepare('SELECT * FROM socios WHERE ativo=1 ORDER BY nome').all();
  const metaRow = db.prepare("SELECT valor FROM config WHERE chave='meta_semanal_por_socio'").get();
  const metaPorSocio = Number(metaRow ? metaRow.valor : 1000);
  const metasEspecificas = Object.fromEntries(
    db.prepare('SELECT semana, valor_por_socio FROM metas_semanais').all().map(m => [m.semana, m.valor_por_socio])
  );

  const semanas = {};
  for (const v of vendas) {
    const produto = produtosPorId[v.produto_id];
    if (!produto) continue;
    const { chave, inicio, fim } = chaveSemana(v.data_venda);
    const { lucro } = lerVendaCongelada(v);
    const investimentos = investimentosDoProduto(produto.id);
    const nSocios = investimentos.length || 1;
    if (!semanas[chave]) {
      semanas[chave] = { inicio, fim, lucro_total: 0, por_socio: {} };
      socios.forEach(s => semanas[chave].por_socio[s.id] = { socio_nome: s.nome, lucro: 0 });
    }
    semanas[chave].lucro_total += lucro;
    investimentos.forEach(inv => {
      if (!semanas[chave].por_socio[inv.socio_id]) {
        const s = socios.find(x => x.id === inv.socio_id);
        semanas[chave].por_socio[inv.socio_id] = { socio_nome: s ? s.nome : '?', lucro: 0 };
      }
      semanas[chave].por_socio[inv.socio_id].lucro += lucro / nSocios;
    });
  }

  // semana com meta propria definida mas ainda sem nenhuma venda (ex: meta da semana que vem,
  // definida com antecedencia) tambem entra na lista, senao ela nao apareceria pra editar/ver.
  for (const chave of Object.keys(metasEspecificas)) {
    if (!semanas[chave]) {
      const { inicio, fim } = chaveSemana(chave);
      semanas[chave] = { inicio, fim, lucro_total: 0, por_socio: {} };
      socios.forEach(s => semanas[chave].por_socio[s.id] = { socio_nome: s.nome, lucro: 0 });
    }
  }

  const lista = Object.entries(semanas).sort((a, b) => a[0].localeCompare(b[0])).map(([chave, s]) => {
    const metaSemana = metasEspecificas[chave] != null ? metasEspecificas[chave] : metaPorSocio;
    const nSociosSemana = Object.keys(s.por_socio).length || 1;
    return {
      semana: chave, inicio: s.inicio, fim: s.fim, lucro_total: s.lucro_total,
      meta_por_socio: metaSemana,
      meta_customizada: metasEspecificas[chave] != null,
      meta_total: metaSemana * nSociosSemana,
      por_socio: Object.values(s.por_socio),
      meta_atingida: s.lucro_total >= metaSemana * nSociosSemana
    };
  });

  ok(res, { meta_semanal_por_socio: metaPorSocio, semanas: lista });
});

app.get('/api/dashboard/mensal', (_, res) => {
  const produtos = db.prepare('SELECT * FROM produtos').all();
  const produtosPorId = Object.fromEntries(produtos.map(p => [p.id, p]));
  const vendas = db.prepare('SELECT * FROM vendas ORDER BY data_venda').all();
  const socios = db.prepare('SELECT * FROM socios WHERE ativo=1 ORDER BY nome').all();

  const meses = {};
  for (const v of vendas) {
    const produto = produtosPorId[v.produto_id];
    if (!produto) continue;
    const chave = v.data_venda.slice(0, 7); // YYYY-MM
    const { lucro } = lerVendaCongelada(v);
    const investimentos = investimentosDoProduto(produto.id);
    const nSocios = investimentos.length || 1;
    if (!meses[chave]) {
      meses[chave] = { lucro_total: 0, arrecadado: 0, por_socio: {} };
      socios.forEach(s => meses[chave].por_socio[s.id] = { socio_nome: s.nome, lucro: 0 });
    }
    meses[chave].lucro_total += lucro;
    meses[chave].arrecadado += v.valor_vendido;
    investimentos.forEach(inv => {
      if (!meses[chave].por_socio[inv.socio_id]) {
        const s = socios.find(x => x.id === inv.socio_id);
        meses[chave].por_socio[inv.socio_id] = { socio_nome: s ? s.nome : '?', lucro: 0 };
      }
      meses[chave].por_socio[inv.socio_id].lucro += lucro / nSocios;
    });
  }

  const lista = Object.entries(meses).sort((a, b) => a[0].localeCompare(b[0])).map(([chave, m]) => ({
    mes: chave, lucro_total: m.lucro_total, arrecadado: m.arrecadado, por_socio: Object.values(m.por_socio)
  }));
  ok(res, lista);
});

app.get('/api/dashboard/extrato-socios', (_, res) => {
  const socios = db.prepare('SELECT * FROM socios ORDER BY nome').all();
  const produtos = todosProdutosComRetrato();
  ok(res, socios.map(s => ({
    socio_id: s.id,
    socio_nome: s.nome,
    produtos: produtos.filter(p => p.por_socio.some(x => x.socio_id === s.id)).map(p => {
      const linha = p.por_socio.find(x => x.socio_id === s.id);
      return {
        produto_id: p.id, sku: p.sku, nome: p.nome, status: p.status,
        investido: linha.investido,
        retorno: p.quantidade_restante > 0 && p.quantidade_vendida === 0 ? 'Em aberto' : linha.retorno,
        lucro: p.quantidade_vendida === 0 ? 'Em aberto' : linha.lucro,
        parcial: p.quantidade_vendida > 0 && p.quantidade_restante > 0
      };
    })
  })));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return err(res, 'Rota nao encontrada', 404);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KN Center rodando na porta ${PORT}`));
