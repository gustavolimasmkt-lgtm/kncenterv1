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
`);

// migracao leve: colunas novas em bancos que ja existiam antes dessa versao
for (const col of [
  "ALTER TABLE vendas ADD COLUMN eh_troca INTEGER DEFAULT 0",
  "ALTER TABLE vendas ADD COLUMN produto_destino_id INTEGER REFERENCES produtos(id)",
  "ALTER TABLE vendas ADD COLUMN custo REAL",
  "ALTER TABLE vendas ADD COLUMN lucro REAL",
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

// Corrige (uma vez, idempotente) o modelo antigo de troca: ate aqui, uma troca com produto de
// destino escolhido NAO descontava o custo do lucro (ficava lucro = valor_vendido inteiro) E
// transferia fisicamente o custo (e os investimentos por socio) pro produto de destino. O dono
// da loja pediu pra mudar: o custo tem que descontar NA HORA da troca, igual venda normal — sem
// transferir nada. Entao aqui: (1) devolve o custo_total que tinha sido tirado do produto de
// origem, (2) corrige o lucro dessa venda pra valor_vendido − custo. NAO mexe nos investimentos
// por socio do produto de destino (a soma pode ficar descasada do custo_total dele depois dessa
// correcao) — o proprio formulario de Produtos ja trava a edicao se a soma nao bater, entao isso
// forca uma conferencia manual em vez de tentar adivinhar a divisao por socio automaticamente.
{
  const trocasComDestino = db.prepare(`
    SELECT * FROM vendas
    WHERE eh_troca = 1 AND produto_destino_id IS NOT NULL AND custo IS NOT NULL
      AND lucro != (valor_vendido - custo)
  `).all();
  for (const v of trocasComDestino) {
    const origem = db.prepare('SELECT * FROM produtos WHERE id=?').get(v.produto_id);
    if (origem) {
      db.prepare('UPDATE produtos SET custo_total = custo_total + ? WHERE id=?').run(v.custo, origem.id);
      db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
        .run(origem.id, null, 'custo_devolvido_troca_simplificada', JSON.stringify({ venda_id: v.id, valor_devolvido: v.custo }));
    }
    const destino = db.prepare('SELECT * FROM produtos WHERE id=?').get(v.produto_destino_id);
    if (destino) {
      db.prepare('UPDATE produtos SET custo_total = MAX(0, custo_total - ?) WHERE id=?').run(v.custo, destino.id);
      db.prepare('INSERT INTO produtos_auditoria (produto_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
        .run(destino.id, null, 'custo_removido_troca_simplificada', JSON.stringify({ venda_id: v.id, valor_removido: v.custo, aviso: 'confira a divisao por socio desse produto — pode estar descasada do custo_total agora' }));
    }
    db.prepare('UPDATE vendas SET lucro = ? WHERE id=?').run(v.valor_vendido - v.custo, v.id);
  }
}

// seed: sócios padrão (extensível pela UI) e meta semanal padrão
if (db.prepare('SELECT COUNT(*) as n FROM socios').get().n === 0) {
  const ins = db.prepare('INSERT INTO socios (nome) VALUES (?)');
  ['Kauã', 'Gustavo'].forEach(n => ins.run(n));
}
if (!db.prepare("SELECT valor FROM config WHERE chave='meta_semanal_por_socio'").get()) {
  db.prepare("INSERT INTO config (chave, valor) VALUES ('meta_semanal_por_socio', '1000')").run();
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

// Calcula o custo/lucro de uma venda NOVA (usa o custo_total do produto no momento exato da
// venda). O resultado e gravado nas colunas custo/lucro da propria venda e nunca mais recalculado
// depois — se o custo do produto mudar no futuro (edicao manual, etc.), vendas ja registradas NAO
// mudam de valor retroativamente. So o produto/venda novos usam o custo novo. Isso evita o bug de
// lucro de mes/semana passados mudando sozinho.
// Troca ou venda normal usam a MESMA conta: lucro = valor recebido − custo do item que saiu.
// produto_destino_id (quando marcado "eh_troca") e so um link de referencia pra saber o que
// entrou no lugar — nao muda o custo de nenhum produto, e nao adia o desconto do custo pra
// depois. O custo do item trocado e descontado JA, na hora da troca, igual qualquer venda.
function calcularVendaNova(produto, venda) {
  const custo = custoUnitario(produto) * venda.quantidade;
  const lucro = venda.valor_vendido - custo;
  return { custo, lucro };
}

// Le o custo/lucro JA CONGELADO de uma venda existente (gravado na hora em que ela foi criada
// ou editada). Nunca recalcula a partir do produto — e assim que se evita o retrocalculo.
function lerVendaCongelada(venda) {
  return { custo: venda.custo ?? 0, lucro: venda.lucro ?? 0 };
}

function retratoProduto(produto) {
  const investimentos = investimentosDoProduto(produto.id);
  const totalInvestido = investimentos.reduce((s, i) => s + i.valor, 0);
  const socioIds = investimentos.map(i => i.socio_id);
  const nSocios = socioIds.length || 1;
  const vendas = vendasDoProduto(produto.id);

  let lucroTotalRealizado = 0, arrecadadoTotal = 0;
  const vendasCalc = vendas.map(v => {
    const { custo, lucro } = lerVendaCongelada(v);
    lucroTotalRealizado += lucro;
    arrecadadoTotal += v.valor_vendido;
    return { ...v, custo, lucro };
  });

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
    const r = db.prepare(`INSERT INTO produtos
      (sku,nome,categoria,condicao,imei_serial,quantidade_total,custo_total,data_compra,preco_anuncio,lucro_minimo,status_manual,obs,criado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sku, b.nome, b.categoria || 'Outro', b.condicao || '', b.imei_serial || '', qtd,
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
    db.prepare(`UPDATE produtos SET nome=?,categoria=?,condicao=?,imei_serial=?,quantidade_total=?,custo_total=?,
      data_compra=?,preco_anuncio=?,lucro_minimo=?,status_manual=?,obs=? WHERE id=?`)
      .run(b.nome, b.categoria || 'Outro', b.condicao || '', b.imei_serial || '', qtd, Number(b.custo_total),
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
    db.prepare('DELETE FROM vendas WHERE produto_id=?').run(produto.id);
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
// dinheiro que entrou junto, ou zero numa troca direta). O lucro sempre desconta o custo do
// produto que saiu NA HORA, troca ou nao — nao existe mais transferencia de custo pro produto
// recebido. produto_destino_id (quando marcado "eh_troca") e so um link de referencia, pra saber
// o que entrou no lugar; nao mexe no custo_total nem nos investimentos de nenhum produto.
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
    // custo/lucro sao calculados AGORA, com o custo_total do produto AGORA, e gravados —
    // nao mudam depois mesmo que o custo do produto mude (edicao manual, etc).
    const { custo, lucro } = calcularVendaNova(produto, { quantidade, valor_vendido: valorVendido });

    const r = db.prepare(`INSERT INTO vendas (produto_id,quantidade,valor_vendido,canal_venda,data_venda,obs,usuario_id,eh_troca,produto_destino_id,custo,lucro)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(produto.id, quantidade, valorVendido, b.canal_venda || (ehTroca ? 'Troca' : ''), b.data_venda, b.obs || '',
           req.user.id, ehTroca ? 1 : 0, produtoDestino ? produtoDestino.id : null, custo, lucro);
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
  ok(res, linhas.map(v => ({ ...v, ...lerVendaCongelada(v) })));
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
    const { custo, lucro } = calcularVendaNova(produto, { quantidade: novaQuantidade, valor_vendido: valorVendido });

    db.prepare('UPDATE vendas SET quantidade=?, valor_vendido=?, canal_venda=?, data_venda=?, obs=?, eh_troca=?, custo=?, lucro=? WHERE id=?')
      .run(novaQuantidade, valorVendido, b.canal_venda || '', b.data_venda, b.obs || '', ehTroca ? 1 : 0, custo, lucro, venda.id);
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
app.delete('/api/lancamentos/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Lancamento nao encontrado', 404);
  db.prepare('DELETE FROM lancamentos WHERE id=?').run(req.params.id);
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

  const lista = Object.entries(semanas).sort((a, b) => a[0].localeCompare(b[0])).map(([chave, s]) => ({
    semana: chave, inicio: s.inicio, fim: s.fim, lucro_total: s.lucro_total,
    meta_total: metaPorSocio * (Object.keys(s.por_socio).length || 1),
    por_socio: Object.values(s.por_socio),
    meta_atingida: s.lucro_total >= metaPorSocio * (Object.keys(s.por_socio).length || 1)
  }));

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
