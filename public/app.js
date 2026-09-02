// ---------- Utils ----------
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || n === '' ? '—' : 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function api(metodo, url, body) {
  const opts = { method: metodo, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'Erro desconhecido');
  return data.data;
}

let SOCIOS = [];
let USUARIO = null;

function mostrar(id) {
  ['form-login', 'form-cadastro'].forEach(f => $(f).classList.add('oculto'));
  $(id).classList.remove('oculto');
}

// ---------- Auth ----------
async function checarSessao() {
  try {
    USUARIO = await api('GET', '/api/auth/me');
    await entrarNoApp();
  } catch (e) {
    $('tela-auth').classList.remove('oculto');
    $('app').classList.add('oculto');
  }
}

async function fazerLogin() {
  $('login-erro').textContent = '';
  try {
    USUARIO = await api('POST', '/api/auth/login', { email: $('login-email').value, senha: $('login-senha').value });
    await entrarNoApp();
  } catch (e) { $('login-erro').textContent = e.message; }
}

async function fazerCadastro() {
  $('cad-erro').textContent = '';
  try {
    const r = await api('POST', '/api/auth/registrar', {
      nome: $('cad-nome').value, email: $('cad-email').value, senha: $('cad-senha').value
    });
    USUARIO = r;
    await entrarNoApp();
  } catch (e) { $('cad-erro').textContent = e.message; }
}

async function fazerLogout() {
  await api('POST', '/api/auth/logout');
  location.reload();
}

async function entrarNoApp() {
  $('tela-auth').classList.add('oculto');
  $('app').classList.remove('oculto');
  $('user-nome').textContent = USUARIO.nome;
  SOCIOS = await api('GET', '/api/socios');
  preencherSelectSocios();
  await irPara('resumo');
}

function preencherSelectSocios() {
  const sel = $('lanc-socio');
  sel.innerHTML = '<option value="">Loja (geral)</option>' + SOCIOS.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
}

// ---------- Navegação ----------
async function irPara(aba) {
  document.querySelectorAll('.aba-btn, .tab-bar-btn').forEach(b => b.classList.toggle('ativa', b.dataset.aba === aba));
  // a barra de baixo (mobile) so tem espaco pra 4 abas + "Mais" — acende o "Mais" quando a aba
  // atual e uma das que ficaram escondidas dentro dele, pra sempre ter algum item aceso.
  const abasNoMais = ['mensal', 'semanal', 'extrato', 'lancamentos', 'usuarios', 'simulador'];
  $('tab-bar-mais-btn').classList.toggle('ativa', abasNoMais.includes(aba));
  document.querySelectorAll('.aba').forEach(s => s.classList.add('oculto'));
  $('aba-' + aba).classList.remove('oculto');
  if (aba === 'resumo') await carregarResumo();
  if (aba === 'produtos') await carregarProdutos();
  if (aba === 'vendas') {
    // sempre entra na aba com o filtro de data limpo — evita o navegador reaproveitar (autofill)
    // uma data digitada numa visita anterior e esconder tudo sem deixar claro o motivo.
    $('vendas-de').value = '';
    $('vendas-ate').value = '';
    await carregarVendas();
  }
  if (aba === 'disponiveis') await carregarDisponiveis();
  if (aba === 'mensal') await carregarMensal();
  if (aba === 'semanal') await carregarSemanal();
  if (aba === 'extrato') await carregarExtrato();
  if (aba === 'lancamentos') await carregarLancamentos();
  if (aba === 'usuarios') await carregarUsuarios();
  if (aba === 'simulador') {
    $('sim-custo').value = '';
    $('sim-valor').value = '';
    $('sim-eh-troca').checked = false;
    calcularSimulador();
  }
}

// ---------- Barra "Mais" (mobile) ----------
function abrirMaisMenu() { $('modal-mais').classList.remove('oculto'); }

async function irParaEFecharMais(aba) {
  fecharModal('modal-mais');
  await irPara(aba);
}

// ---------- Resumo ----------
async function carregarResumo() {
  const de = $('resumo-de').value, ate = $('resumo-ate').value;
  const qs = new URLSearchParams();
  if (de) qs.set('de', de);
  if (ate) qs.set('ate', ate);
  const r = await api('GET', '/api/dashboard/resumo' + (qs.toString() ? '?' + qs.toString() : ''));

  $('resumo-aviso-periodo').classList.toggle('oculto', !r.periodo_filtrado);

  const cards = [
    ['💰 Total Investido (atual)', fmt(r.total_investido), ''],
    ['📦 Produtos em Aberto (atual)', r.produtos_em_aberto, ''],
    ['✅ Produtos Esgotados/Vendidos (atual)', r.produtos_esgotados, ''],
    ['💵 Total Arrecadado', fmt(r.total_arrecadado), ''],
    ['📈 Lucro Real Total', fmt(r.lucro_real_total), r.lucro_real_total >= 0 ? 'pos' : 'neg'],
    ['📉 Lucro Mín. Estimado (Em Aberto)', fmt(r.lucro_min_estimado_aberto), ''],
    ['🎯 Lucro Máx. Estimado (Em Aberto)', fmt(r.lucro_max_estimado_aberto), ''],
    ['🧾 Saldo Lançamentos Gerais', fmt(r.saldo_lancamentos_gerais), r.saldo_lancamentos_gerais >= 0 ? 'pos' : 'neg'],
  ];
  r.por_socio.forEach(s => cards.push([`👤 Lucro — ${s.socio_nome}`, fmt(s.lucro), s.lucro >= 0 ? 'pos' : 'neg']));
  $('cards-resumo').innerHTML = cards.map(([l, v, cls]) =>
    `<div class="card"><div class="label">${l}</div><div class="valor ${cls}">${v}</div></div>`).join('');
}

function limparFiltroResumo() {
  $('resumo-de').value = '';
  $('resumo-ate').value = '';
  carregarResumo();
}

// ---------- Produtos ----------
let PRODUTOS_CACHE = [];
let PRODUTOS_SELECIONADOS = new Set();
let PRODUTOS_FILTRADOS_ATUAL = [];

function tagClasseStatus(status) {
  return status === 'Disponível' ? 'disp' : (status.toLowerCase().includes('vendido') || status === 'Esgotado' ? 'vendido' : 'outro');
}

// Farol de performance: bolinha colorida (verde/amarelo/vermelho) com o % de retorno no title, ou
// selo neutro "Troca" quando foi troca sem dinheiro suficiente pra medir retorno. Mesma regra e
// mesmo HTML em todo lugar que mostra farol (Vendas, lista de produtos, vendas dentro do produto).
function renderFarol(farol) {
  if (!farol) return '';
  if (farol.tipo === 'troca') return `<span class="farol-troca">Troca</span>`;
  return `<span class="farol"><span class="farol-bolinha ${farol.cor}"></span>${farol.retorno.toFixed(1)}%</span>`;
}

// ---------- Simulador ----------
// Mesma conta do backend (calcularVendaComTroca + classificarFarol), só que sem gravar nada — pra
// ver antes de vender de verdade. Troca sem dinheiro suficiente pra cobrir o custo: lucro fica 0
// e a diferença "vai" pro produto que entrar na troca, igual funciona pra venda de verdade.
function calcularSimulador() {
  const custo = Number($('sim-custo').value) || 0;
  const valor = Number($('sim-valor').value) || 0;
  const ehTroca = $('sim-eh-troca').checked;
  $('sim-valor-label').textContent = ehTroca
    ? 'Entrou dinheiro junto com a troca? (R$) — opcional, deixe em branco se foi troca direta'
    : 'Valor vendido (R$)';

  const deficit = custo - valor;
  let lucro, transferido = 0, farol;
  if (ehTroca && deficit > 0.01) {
    lucro = 0;
    transferido = deficit;
    farol = { tipo: 'troca' };
  } else {
    lucro = valor - custo;
    if (custo > 0) {
      const retorno = (lucro / custo) * 100;
      const cor = retorno >= 50 ? 'verde' : retorno >= 30 ? 'amarelo' : 'vermelho';
      farol = { tipo: 'cor', cor, retorno };
    } else {
      farol = null;
    }
  }

  const cards = [
    ['💰 Lucro projetado', fmt(lucro), lucro >= 0 ? 'pos' : 'neg'],
  ];
  $('sim-resultado').innerHTML = cards.map(([l, v, cls]) =>
    `<div class="card"><div class="label">${l}</div><div class="valor ${cls}">${v}</div></div>`
  ).join('') +
  `<div class="card"><div class="label">📈 Margem</div><div class="valor">${farol ? renderFarol(farol) : '—'}</div></div>` +
  (transferido > 0 ? `<div class="card"><div class="label">↪️ Vai pro custo do produto da troca</div><div class="valor">${fmt(transferido)}</div></div>` : '');
}

async function carregarProdutos() {
  PRODUTOS_CACHE = await api('GET', '/api/produtos');
  // tira da selecao produtos que sumiram (ex: excluidos por outra aba)
  const idsAtuais = new Set(PRODUTOS_CACHE.map(p => p.id));
  PRODUTOS_SELECIONADOS.forEach(id => { if (!idsAtuais.has(id)) PRODUTOS_SELECIONADOS.delete(id); });
  renderProdutos();
}

function renderProdutos() {
  const busca = ($('filtro-produtos-busca').value || '').trim().toLowerCase();
  const categoria = $('filtro-produtos-categoria').value;
  const statusFiltro = $('filtro-produtos-status').value;

  const filtrados = PRODUTOS_CACHE.filter(p => {
    if (busca && !(p.nome.toLowerCase().includes(busca) || (p.sku || '').toLowerCase().includes(busca))) return false;
    if (categoria && p.categoria !== categoria) return false;
    if (statusFiltro && tagClasseStatus(p.status) !== statusFiltro) return false;
    return true;
  });
  PRODUTOS_FILTRADOS_ATUAL = filtrados;

  $('filtro-produtos-contador').textContent = `${filtrados.length} de ${PRODUTOS_CACHE.length} produto(s)`;

  $('lista-produtos').innerHTML = filtrados.map(p => `
    <tr>
      <td><input type="checkbox" ${PRODUTOS_SELECIONADOS.has(p.id) ? 'checked' : ''} onchange="alternarSelecaoProduto(${p.id}, this.checked)"></td>
      <td>${p.sku || ''}</td>
      <td>${p.nome}</td>
      <td>${p.categoria}</td>
      <td>${p.quantidade_vendida}/${p.quantidade_total}</td>
      <td>${fmt(p.custo_unitario)}</td>
      <td>${fmt(p.preco_anuncio)}</td>
      <td><span class="tag ${tagClasseStatus(p.status)}">${p.status}</span> ${tagClasseStatus(p.status) === 'vendido' ? renderFarol(p.farol) : ''}</td>
      <td>
        ${p.quantidade_restante > 0 ? `<button class="btn-mini venda" onclick="abrirModalVenda(${p.id})">Vender</button>` : ''}
        <button class="btn-mini" onclick="abrirModalProduto(${p.id})">Editar</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="9">${PRODUTOS_CACHE.length ? 'Nenhum produto bate com esse filtro.' : 'Nenhum produto cadastrado ainda.'}</td></tr>`;

  const todosMarcados = filtrados.length > 0 && filtrados.every(p => PRODUTOS_SELECIONADOS.has(p.id));
  $('check-todos-produtos').checked = todosMarcados;
  atualizarBarraSelecaoProdutos();
}

function alternarSelecaoProduto(id, marcado) {
  if (marcado) PRODUTOS_SELECIONADOS.add(id); else PRODUTOS_SELECIONADOS.delete(id);
  const todosMarcados = PRODUTOS_FILTRADOS_ATUAL.length > 0 && PRODUTOS_FILTRADOS_ATUAL.every(p => PRODUTOS_SELECIONADOS.has(p.id));
  $('check-todos-produtos').checked = todosMarcados;
  atualizarBarraSelecaoProdutos();
}

function alternarTodosProdutos(marcado) {
  PRODUTOS_FILTRADOS_ATUAL.forEach(p => { if (marcado) PRODUTOS_SELECIONADOS.add(p.id); else PRODUTOS_SELECIONADOS.delete(p.id); });
  renderProdutos();
}

function limparSelecaoProdutos() {
  PRODUTOS_SELECIONADOS.clear();
  renderProdutos();
}

function atualizarBarraSelecaoProdutos() {
  const n = PRODUTOS_SELECIONADOS.size;
  $('produtos-acoes-massa').classList.toggle('oculto', n === 0);
  $('produtos-selecionados-contador').textContent = `${n} selecionado(s)`;
}

async function exportarProdutosSelecionados() {
  const ids = [...PRODUTOS_SELECIONADOS];
  if (!ids.length) return;
  try {
    const r = await fetch('/api/produtos/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ids })
    });
    if (!r.ok) {
      const erro = await r.json().catch(() => ({}));
      throw new Error(erro.error || 'Erro ao exportar');
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kn-center-produtos-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Erro ao exportar: ' + e.message);
  }
}

async function excluirProdutosSelecionados() {
  const ids = [...PRODUTOS_SELECIONADOS];
  if (!ids.length) return;
  const forcar = $('forcar-exclusao-massa').checked;
  const aviso = forcar
    ? `Excluir ${ids.length} produto(s) selecionado(s)?\n\nA opção "apagar mesmo com vendas" está marcada — quem tiver vendas registradas vai ser excluído JUNTO com o histórico de vendas. Os totais de lucro mensal/semanal já fechados vão mudar.`
    : `Excluir ${ids.length} produto(s) selecionado(s)?\n\nProdutos com vendas registradas não vão ser excluídos (marque a opção "apagar mesmo com vendas", acima da lista, se quiser incluir esses também).`;
  // um unico confirm() — evita empilhar duas caixinhas seguidas, que no app instalado no iPhone
  // (modo standalone) pode nao aparecer direito na segunda vez e parecer que "nao faz nada".
  if (!confirm(aviso)) return;
  try {
    const r = await api('POST', '/api/produtos/excluir-em-massa', { ids, forcar });
    let msg = `${r.excluidos} produto(s) excluído(s).`;
    if (r.bloqueados.length) {
      msg += `\n\nNão excluídos (têm vendas registradas): ${r.bloqueados.map(b => b.label).join(', ')}.\nMarque "apagar mesmo com vendas" e tente de novo se quiser incluir esses também.`;
    }
    $('forcar-exclusao-massa').checked = false;
    PRODUTOS_SELECIONADOS.clear();
    await carregarProdutos();
    await atualizarVendasSeVisivel();
    alert(msg);
  } catch (e) {
    alert('Erro ao excluir em massa: ' + e.message);
  }
}

function atualizarInvestimentosUI() {
  const custo = Number($('prod-custo').value) || 0;
  const box = $('investimentos-box');
  const existentes = {};
  box.querySelectorAll('.investimento-linha input').forEach(inp => existentes[inp.dataset.socio] = inp.value);
  box.innerHTML = '<label>Quanto cada sócio pagou (a soma precisa bater com o custo total)</label>' +
    SOCIOS.map(s => `
      <div class="investimento-linha">
        <span>${s.nome}</span>
        <input type="number" step="0.01" data-socio="${s.id}" value="${existentes[s.id] ?? ''}" oninput="conferirSomaInvestimentos()">
      </div>
    `).join('') + '<div id="soma-investimentos" class="soma-investimentos"></div>';
  conferirSomaInvestimentos();
}

function conferirSomaInvestimentos() {
  const custo = Number($('prod-custo').value) || 0;
  let soma = 0;
  document.querySelectorAll('#investimentos-box input').forEach(inp => soma += Number(inp.value) || 0);
  const el = $('soma-investimentos');
  if (!el) return;
  const ok = Math.abs(soma - custo) < 0.01;
  el.textContent = `Soma: ${fmt(soma)} de ${fmt(custo)}`;
  el.className = 'soma-investimentos ' + (ok ? 'ok' : 'erro');
}

function coletarInvestimentos() {
  const arr = [];
  document.querySelectorAll('#investimentos-box input').forEach(inp => {
    if (Number(inp.value) > 0) arr.push({ socio_id: Number(inp.dataset.socio), valor: Number(inp.value) });
  });
  return arr;
}

let PRODUTO_EM_EDICAO_VENDAS = [];

async function abrirModalProduto(id) {
  $('prod-erro').textContent = '';
  $('prod-id').value = id || '';
  $('btn-excluir-produto-forcado').classList.add('oculto');
  if (id) {
    const p = await api('GET', '/api/produtos/' + id);
    PRODUTO_EM_EDICAO_VENDAS = p.vendas || [];
    $('modal-produto-titulo').textContent = 'Editar produto — ' + p.sku;
    $('prod-nome').value = p.nome;
    $('prod-categoria').value = p.categoria;
    $('prod-sku').value = p.sku;
    $('prod-condicao').value = p.condicao || '';
    $('prod-imei').value = p.imei_serial || '';
    $('prod-qtd').value = p.quantidade_total;
    $('prod-data-compra').value = p.data_compra || '';
    $('prod-custo').value = p.custo_total;
    $('prod-preco-anuncio').value = p.preco_anuncio ?? '';
    $('prod-lucro-minimo').value = p.lucro_minimo ?? '';
    $('prod-status-manual').value = p.status_manual || '';
    $('prod-obs').value = p.obs || '';
    atualizarInvestimentosUI();
    p.investimentos.forEach(inv => {
      const inp = document.querySelector(`#investimentos-box input[data-socio="${inv.socio_id}"]`);
      if (inp) inp.value = inv.valor;
    });
    conferirSomaInvestimentos();
    $('btn-excluir-produto').classList.remove('oculto');

    $('prod-vendas-box').classList.remove('oculto');
    $('lista-vendas-produto').innerHTML = PRODUTO_EM_EDICAO_VENDAS.map(v => `
      <tr>
        <td>${v.data_venda.split('-').reverse().join('/')}</td>
        <td>${v.quantidade}x</td>
        <td>${v.eh_troca ? 'Troca' : fmt(v.valor_vendido)}</td>
        <td class="${v.lucro >= 0 ? 'pos' : 'neg'}">${fmt(v.lucro)}</td>
        <td>${renderFarol(v.farol)}</td>
        <td>${v.canal_venda || ''}</td>
        <td>
          <button class="btn-mini" onclick="abrirModalVenda(${p.id}, ${v.id})">Editar</button>
          <button class="btn-mini" onclick="excluirVendaExistente(${v.id}, ${p.id})">Excluir</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="7">Nenhuma venda registrada ainda.</td></tr>';
  } else {
    PRODUTO_EM_EDICAO_VENDAS = [];
    $('modal-produto-titulo').textContent = 'Novo produto';
    ['prod-nome','prod-sku','prod-condicao','prod-imei','prod-preco-anuncio','prod-lucro-minimo','prod-status-manual','prod-obs'].forEach(f => $(f).value = '');
    $('prod-qtd').value = 1;
    $('prod-custo').value = '';
    $('prod-data-compra').value = new Date().toISOString().slice(0, 10);
    atualizarInvestimentosUI();
    $('btn-excluir-produto').classList.add('oculto');
    $('prod-vendas-box').classList.add('oculto');
  }
  $('modal-produto').classList.remove('oculto');
}

async function salvarProduto() {
  $('prod-erro').textContent = '';
  const id = $('prod-id').value;
  const payload = {
    nome: $('prod-nome').value,
    categoria: $('prod-categoria').value,
    sku: $('prod-sku').value,
    condicao: $('prod-condicao').value,
    imei_serial: $('prod-imei').value,
    quantidade_total: $('prod-qtd').value,
    data_compra: $('prod-data-compra').value,
    custo_total: $('prod-custo').value,
    preco_anuncio: $('prod-preco-anuncio').value || null,
    lucro_minimo: $('prod-lucro-minimo').value || null,
    status_manual: $('prod-status-manual').value,
    obs: $('prod-obs').value,
    investimentos: coletarInvestimentos()
  };
  try {
    if (id) await api('PUT', '/api/produtos/' + id, payload);
    else await api('POST', '/api/produtos', payload);
    fecharModal('modal-produto');
    await carregarProdutos();
  } catch (e) { $('prod-erro').textContent = e.message; }
}

async function excluirProduto() {
  const id = $('prod-id').value;
  if (!confirm('Excluir este produto?')) return;
  try {
    await api('DELETE', '/api/produtos/' + id);
    fecharModal('modal-produto');
    await carregarProdutos();
  } catch (e) {
    $('prod-erro').textContent = e.message;
    // em vez de empilhar um segundo confirm() logo depois do primeiro (que no app instalado no
    // iPhone pode nao aparecer direito), mostra um botao separado — o usuario clica quando quiser.
    if (/vendas registradas/i.test(e.message)) $('btn-excluir-produto-forcado').classList.remove('oculto');
  }
}

async function excluirProdutoForcado() {
  const id = $('prod-id').value;
  if (!confirm('Apagar esse produto JUNTO com o histórico de vendas dele? Os totais de lucro mensal/semanal já fechados vão mudar.')) return;
  try {
    await api('DELETE', '/api/produtos/' + id, { forcar: true });
    fecharModal('modal-produto');
    await carregarProdutos();
    await atualizarVendasSeVisivel();
  } catch (e) { $('prod-erro').textContent = e.message; }
}

// ---------- Venda ----------
function abrirModalVenda(id, vendaId) {
  const p = PRODUTOS_CACHE.find(x => x.id === id);
  $('venda-erro').textContent = '';
  $('venda-produto-id').value = id;
  $('venda-id').value = vendaId || '';
  $('venda-produto-nome').textContent = `${p.nome} (restam ${p.quantidade_restante})`;
  $('venda-qtd').value = 1;
  $('venda-qtd').max = p.quantidade_restante;
  $('venda-eh-troca').checked = false;
  $('venda-valor').value = '';
  $('venda-canal').value = '';
  $('venda-data').value = new Date().toISOString().slice(0, 10);
  $('venda-obs').value = '';
  const selDestino = $('venda-destino');
  selDestino.innerHTML = '<option value="">— nenhum —</option>' +
    PRODUTOS_CACHE.filter(x => x.id !== id).map(x => `<option value="${x.id}">${x.sku ? x.sku + ' — ' : ''}${x.nome}</option>`).join('');
  alternarNovoDestino(false);
  $('venda-destino-novo-nome').value = '';
  $('venda-destino-novo-erro').textContent = '';
  alternarTroca();

  const venda = vendaId ? PRODUTO_EM_EDICAO_VENDAS.find(v => v.id === vendaId) : null;
  if (venda) {
    $('modal-venda-titulo').textContent = 'Editar venda';
    $('venda-qtd').value = venda.quantidade;
    $('venda-eh-troca').checked = !!venda.eh_troca;
    $('venda-valor').value = venda.valor_vendido || '';
    $('venda-canal').value = venda.canal_venda || '';
    $('venda-data').value = venda.data_venda || '';
    $('venda-obs').value = venda.obs || '';
    selDestino.value = venda.produto_destino_id || '';
    alternarTroca();
  } else {
    $('modal-venda-titulo').textContent = 'Registrar venda';
  }

  $('modal-venda').classList.remove('oculto');
}

function alternarTroca() {
  const eh = $('venda-eh-troca').checked;
  $('venda-destino-box').classList.toggle('oculto', !eh);
  $('venda-valor-label').textContent = eh
    ? 'Entrou dinheiro junto com a troca? (R$) — opcional, deixe em branco se foi troca direta'
    : 'Valor vendido (R$)';
}

// Mostra/esconde o mini-formulario de criar produto novo direto no meio do registro da troca,
// pra nao precisar sair da tela, ir em Produtos, cadastrar, e voltar. Cria com custo R$0 — o
// valor que faltar cobrir na troca cai automaticamente nele quando a venda for confirmada (ver
// calcularVendaComTroca no backend).
function alternarNovoDestino(mostrar) {
  $('venda-destino-novo-box').classList.toggle('oculto', !mostrar);
  if (mostrar) $('venda-destino').value = '';
}

async function criarDestinoInline() {
  $('venda-destino-novo-erro').textContent = '';
  const nome = $('venda-destino-novo-nome').value.trim();
  if (!nome) { $('venda-destino-novo-erro').textContent = 'Digita o nome do produto recebido.'; return; }
  try {
    const novo = await api('POST', '/api/produtos', {
      nome, categoria: $('venda-destino-novo-categoria').value,
      quantidade_total: 1, custo_total: 0,
      data_compra: $('venda-data').value || new Date().toISOString().slice(0, 10),
      investimentos: []
    });
    PRODUTOS_CACHE.push(novo);
    const selDestino = $('venda-destino');
    selDestino.insertAdjacentHTML('beforeend', `<option value="${novo.id}">${novo.sku ? novo.sku + ' — ' : ''}${novo.nome}</option>`);
    selDestino.value = novo.id;
    alternarNovoDestino(false);
  } catch (e) { $('venda-destino-novo-erro').textContent = e.message; }
}

async function salvarVenda() {
  $('venda-erro').textContent = '';
  const id = $('venda-produto-id').value;
  const vendaId = $('venda-id').value;
  const ehTroca = $('venda-eh-troca').checked;
  try {
    if (vendaId) {
      const payload = {
        quantidade: $('venda-qtd').value,
        valor_vendido: $('venda-valor').value || 0,
        canal_venda: $('venda-canal').value,
        data_venda: $('venda-data').value,
        obs: $('venda-obs').value,
        eh_troca: ehTroca,
      };
      await api('PUT', `/api/vendas/${vendaId}`, payload);
    } else {
      await api('POST', `/api/produtos/${id}/vender`, {
        quantidade: $('venda-qtd').value,
        valor_vendido: $('venda-valor').value || 0,
        canal_venda: $('venda-canal').value,
        data_venda: $('venda-data').value,
        obs: $('venda-obs').value,
        eh_troca: ehTroca,
        produto_destino_id: ehTroca ? ($('venda-destino').value || null) : null
      });
    }
    fecharModal('modal-venda');
    await carregarProdutos();
    if (!$('modal-produto').classList.contains('oculto')) await abrirModalProduto(Number(id));
    await atualizarVendasSeVisivel();
  } catch (e) { $('venda-erro').textContent = e.message; }
}

async function excluirVendaExistente(vendaId, produtoId) {
  if (!confirm('Excluir essa venda? Isso devolve a quantidade pro estoque.')) return;
  try {
    await api('DELETE', `/api/vendas/${vendaId}`);
    await carregarProdutos();
    await abrirModalProduto(produtoId);
    await atualizarVendasSeVisivel();
  } catch (e) {
    alert('Erro ao excluir venda: ' + e.message);
  }
}

// se a aba Vendas estiver aberta, recarrega ela tambem — usado depois de qualquer
// criacao/edicao/exclusao de venda feita por fora dessa aba (ex: dentro do modal de produto).
async function atualizarVendasSeVisivel() {
  if (!$('aba-vendas').classList.contains('oculto')) await carregarVendas();
}

// ---------- Vendas (modulo global — todas as vendas de todos os produtos) ----------
let VENDAS_CACHE = [];

async function carregarVendas() {
  if (!PRODUTOS_CACHE.length) await carregarProdutos(); // abrirModalVenda depende do cache de produtos
  VENDAS_CACHE = await api('GET', '/api/vendas');
  renderVendas();
}

function limparFiltroVendas() {
  $('vendas-de').value = '';
  $('vendas-ate').value = '';
  $('filtro-vendas-busca').value = '';
  $('filtro-vendas-tipo').value = '';
  renderVendas();
}

function renderVendas() {
  const de = $('vendas-de').value;
  const ate = $('vendas-ate').value;
  const busca = ($('filtro-vendas-busca').value || '').trim().toLowerCase();
  const tipo = $('filtro-vendas-tipo').value;

  const filtradas = VENDAS_CACHE.filter(v => {
    if (de && v.data_venda < de) return false;
    if (ate && v.data_venda > ate) return false;
    if (tipo === 'venda' && v.eh_troca) return false;
    if (tipo === 'troca' && !v.eh_troca) return false;
    if (busca) {
      const alvo = `${v.produto_nome} ${v.produto_sku || ''} ${v.canal_venda || ''}`.toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  const lucroTotal = filtradas.reduce((s, v) => s + (v.lucro || 0), 0);
  $('vendas-totais').textContent = `Lucro do período filtrado: ${fmt(lucroTotal)}`;
  $('filtro-vendas-contador').textContent = `${filtradas.length} de ${VENDAS_CACHE.length} venda(s)`;

  $('lista-vendas').innerHTML = filtradas.map(v => `
    <tr>
      <td>${v.data_venda.split('-').reverse().join('/')}</td>
      <td>${v.produto_sku ? v.produto_sku + ' — ' : ''}${v.produto_nome}</td>
      <td>${v.quantidade}x</td>
      <td>${v.eh_troca ? (v.valor_vendido ? fmt(v.valor_vendido) : '—') : fmt(v.valor_vendido)}</td>
      <td>${fmt(v.custo)}</td>
      <td class="${v.lucro >= 0 ? 'pos' : 'neg'}">${fmt(v.lucro)}</td>
      <td>${renderFarol(v.farol)}</td>
      <td>${v.canal_venda || ''}</td>
      <td>${v.eh_troca ? ('Sim' + (v.produto_destino_nome ? ` → ${v.produto_destino_nome}` : '')) : 'Não'}</td>
      <td>
        <button class="btn-mini" onclick="abrirModalVendaStandalone(${v.id})">Editar</button>
        <button class="btn-mini" onclick="excluirVendaStandalone(${v.id})">Excluir</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="10">${VENDAS_CACHE.length ? 'Nenhuma venda bate com esse filtro.' : 'Nenhuma venda registrada ainda.'}</td></tr>`;
}

function abrirModalVendaStandalone(vendaId) {
  const venda = VENDAS_CACHE.find(v => v.id === vendaId);
  if (!venda) return;
  PRODUTO_EM_EDICAO_VENDAS = [venda];
  abrirModalVenda(venda.produto_id, vendaId);
}

async function excluirVendaStandalone(vendaId) {
  if (!confirm('Excluir essa venda? Isso devolve a quantidade pro estoque.')) return;
  try {
    await api('DELETE', `/api/vendas/${vendaId}`);
    await carregarProdutos();
    await carregarVendas();
  } catch (e) {
    alert('Erro ao excluir venda: ' + e.message);
  }
}

async function importarPlanilha(arquivo) {
  if (!arquivo) return;
  const box = $('import-resultado');
  box.classList.remove('oculto');
  box.innerHTML = 'Importando planilha, aguenta aí...';
  const fd = new FormData();
  fd.append('planilha', arquivo);
  try {
    const r = await api('POST', '/api/produtos/importar-planilha', fd);
    let html = `<div class="bloco-header"><h3>Importação concluída</h3></div>`;
    html += `<p>${r.criados} produto(s) criado(s), ${r.pulados} pulado(s) (SKU já existia), ${r.vendasCriadas} venda(s) registrada(s) de ${r.total} produto(s) na planilha.</p>`;
    if (r.avisos.length) {
      html += `<p><strong>${r.avisos.length} produto(s) precisam de conferência manual (não importados 100% automático):</strong></p>`;
      html += '<ul>' + r.avisos.map(a => `<li>${a}</li>`).join('') + '</ul>';
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<p class="erro">Erro ao importar: ${e.message}</p>`;
  }
  $('input-planilha').value = '';
  await carregarProdutos();
}

// ---------- Disponíveis ----------
async function carregarDisponiveis() {
  const lista = await api('GET', '/api/dashboard/disponiveis');

  // soma o custo de tudo que ainda esta parado em estoque, e quanto renderia se vendesse tudo
  // pelo preco de anuncio cadastrado — produto sem preco de anuncio nao entra nessa segunda soma
  // (fica de fora do "potencial", nao conta como zero, pra nao subestimar escondido).
  const custoTotalAberto = lista.reduce((s, p) => s + (p.custo_total_restante || 0), 0);
  const comAnuncio = lista.filter(p => p.preco_anuncio != null);
  const potencialVenda = comAnuncio.reduce((s, p) => s + p.preco_anuncio * p.quantidade_restante, 0);
  const custoDoComAnuncio = comAnuncio.reduce((s, p) => s + (p.custo_total_restante || 0), 0);
  const margemPotencial = potencialVenda - custoDoComAnuncio;
  const semAnuncio = lista.length - comAnuncio.length;

  const cards = [
    ['💰 Custo do estoque em aberto', fmt(custoTotalAberto), ''],
    ['🎯 Potencial de venda (pelo anúncio)', fmt(potencialVenda), ''],
    ['📈 Margem potencial (se vender tudo pelo anúncio)', fmt(margemPotencial), margemPotencial >= 0 ? 'pos' : 'neg'],
  ];
  $('cards-disponiveis').innerHTML = cards.map(([l, v, cls]) =>
    `<div class="card"><div class="label">${l}</div><div class="valor ${cls}">${v}</div></div>`).join('');

  $('disponiveis-aviso-sem-anuncio').classList.toggle('oculto', semAnuncio === 0);
  if (semAnuncio > 0) $('disponiveis-aviso-sem-anuncio').textContent =
    `${semAnuncio} produto(s) em aberto sem preço de anúncio cadastrado — não entram na soma do potencial de venda acima.`;

  $('lista-disponiveis').innerHTML = lista.map(p => `
    <tr>
      <td>${p.sku}</td><td>${p.nome}</td><td>${p.quantidade_restante}</td>
      <td>${fmt(p.custo_total_restante)}</td><td>${fmt(p.preco_anuncio)}</td>
      <td>${fmt(p.margem_anuncio)}</td><td>${fmt(p.margem_minima)}</td>
    </tr>
  `).join('') || '<tr><td colspan="7">Nada em estoque no momento.</td></tr>';
}

// ---------- Mensal ----------
async function carregarMensal() {
  const meses = await api('GET', '/api/dashboard/mensal');
  const nomesMes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  $('lista-mensal').innerHTML = meses.slice().reverse().map(m => {
    const [ano, mes] = m.mes.split('-');
    return `
      <div class="bloco">
        <div class="bloco-header"><h3>${nomesMes[Number(mes)-1]} / ${ano}</h3><strong>${fmt(m.lucro_total)}</strong></div>
        <table class="mini-tabela">
          <tr><td>Arrecadado no mês</td><td style="text-align:right">${fmt(m.arrecadado)}</td></tr>
          ${m.por_socio.map(s => `<tr><td>Lucro — ${s.socio_nome}</td><td style="text-align:right">${fmt(s.lucro)}</td></tr>`).join('')}
        </table>
      </div>`;
  }).join('') || '<p>Nenhuma venda registrada ainda.</p>';
}

// ---------- Semanal ----------
async function carregarSemanal() {
  const r = await api('GET', '/api/dashboard/semanal');
  $('meta-semanal-input').value = r.meta_semanal_por_socio;
  $('lista-semanal').innerHTML = r.semanas.slice().reverse().map(s => `
    <div class="bloco">
      <div class="bloco-header">
        <h3>${s.inicio.split('-').reverse().join('/')} a ${s.fim.split('-').reverse().join('/')}</h3>
        <span class="meta-badge ${s.meta_atingida ? 'sim' : 'nao'}">${s.meta_atingida ? 'Meta batida' : 'Faltou ' + fmt(s.meta_total - s.lucro_total)}</span>
      </div>
      <table class="mini-tabela">
        <tr><td>Lucro total da semana</td><td style="text-align:right"><strong>${fmt(s.lucro_total)}</strong></td></tr>
        ${s.por_socio.map(p => `<tr><td>${p.socio_nome}</td><td style="text-align:right">${fmt(p.lucro)}</td></tr>`).join('')}
      </table>
      <div class="filtros" style="margin-top:8px">
        <label>Meta desta semana por sócio (R$)${s.meta_customizada ? ' — própria' : ' — usando a padrão'}:</label>
        <input type="number" step="0.01" value="${s.meta_por_socio}" id="meta-semana-${s.semana}" style="width:120px">
        <button class="btn-mini" onclick="salvarMetaSemanaEspecifica('${s.semana}')">Salvar</button>
        ${s.meta_customizada ? `<button class="btn-mini" onclick="resetarMetaSemana('${s.semana}')">Usar padrão</button>` : ''}
      </div>
    </div>
  `).join('') || '<p>Nenhuma venda registrada ainda.</p>';
}

async function salvarMetaSemanal() {
  try {
    await api('PUT', '/api/config/meta-semanal', { meta_semanal_por_socio: $('meta-semanal-input').value });
    await carregarSemanal();
  } catch (e) { alert(e.message); }
}

// Segunda-feira da semana de uma data qualquer, no mesmo formato que o backend usa como chave
// (AAAA-MM-DD) — pra poder definir a meta de uma semana escolhendo qualquer dia dela.
function segundaDaSemana(dataStr) {
  const d = new Date(dataStr + 'T12:00:00');
  const diaSemana = (d.getDay() + 6) % 7; // segunda=0 ... domingo=6
  d.setDate(d.getDate() - diaSemana);
  return d.toISOString().slice(0, 10);
}

async function salvarMetaSemanaEspecifica(semana) {
  try {
    const valor = $('meta-semana-' + semana).value;
    await api('PUT', `/api/config/meta-semanal/${semana}`, { valor_por_socio: valor });
    await carregarSemanal();
  } catch (e) { alert(e.message); }
}

async function resetarMetaSemana(semana) {
  try {
    await api('DELETE', `/api/config/meta-semanal/${semana}`);
    await carregarSemanal();
  } catch (e) { alert(e.message); }
}

async function salvarMetaFutura() {
  $('meta-futura-erro').textContent = '';
  const data = $('meta-futura-data').value;
  const valor = $('meta-futura-valor').value;
  if (!data) { $('meta-futura-erro').textContent = 'Escolhe um dia da semana que você quer definir a meta.'; return; }
  try {
    await api('PUT', `/api/config/meta-semanal/${segundaDaSemana(data)}`, { valor_por_socio: valor });
    $('meta-futura-data').value = '';
    $('meta-futura-valor').value = '';
    await carregarSemanal();
  } catch (e) { $('meta-futura-erro').textContent = e.message; }
}

// ---------- Extrato sócios ----------
async function carregarExtrato() {
  const socios = await api('GET', '/api/dashboard/extrato-socios');
  $('lista-extrato').innerHTML = socios.map(s => `
    <div class="bloco">
      <div class="bloco-header"><h3>${s.socio_nome}</h3></div>
      <table class="mini-tabela">
        <tr><td><strong>Produto</strong></td><td><strong>Investido</strong></td><td><strong>Retorno</strong></td><td><strong>Lucro</strong></td></tr>
        ${s.produtos.map(p => `
          <tr>
            <td>${p.nome}${p.parcial ? ' (parcial)' : ''}</td>
            <td>${fmt(p.investido)}</td>
            <td>${typeof p.retorno === 'number' ? fmt(p.retorno) : p.retorno}</td>
            <td>${typeof p.lucro === 'number' ? fmt(p.lucro) : p.lucro}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `).join('') || '<p>Nenhum sócio cadastrado.</p>';
}

// ---------- Lançamentos ----------
let LANCAMENTOS_CACHE = [];

async function carregarLancamentos() {
  LANCAMENTOS_CACHE = await api('GET', '/api/lancamentos');
  const sel = $('filtro-lanc-socio');
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todas as contas</option><option value="loja">Loja (geral)</option>' +
    SOCIOS.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
  sel.value = atual;
  renderLancamentos();
}

function renderLancamentos() {
  const tipo = $('filtro-lanc-tipo').value;
  const socio = $('filtro-lanc-socio').value;
  const mes = $('filtro-lanc-mes').value; // formato YYYY-MM

  const filtrados = LANCAMENTOS_CACHE.filter(l => {
    if (tipo && l.tipo !== tipo) return false;
    if (socio === 'loja' && l.socio_nome) return false;
    if (socio && socio !== 'loja' && String(l.socio_id) !== socio) return false;
    if (mes && !l.data.startsWith(mes)) return false;
    return true;
  });

  $('lista-lancamentos').innerHTML = filtrados.map(l => `
    <tr>
      <td>${l.data.split('-').reverse().join('/')}</td>
      <td>${l.tipo === 'entrada' ? 'Entrada' : 'Saída'}</td>
      <td>${l.descricao}</td>
      <td>${l.socio_nome || 'Loja'}</td>
      <td class="${l.tipo === 'entrada' ? 'valor pos' : 'valor neg'}">${fmt(l.valor)}</td>
      <td>
        <button class="btn-mini" onclick="abrirModalLancamento(${l.id})">Editar</button>
        <button class="btn-mini" onclick="excluirLancamento(${l.id})">Excluir</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="6">${LANCAMENTOS_CACHE.length ? 'Nenhum lançamento bate com esse filtro.' : 'Nenhum lançamento ainda.'}</td></tr>`;
}

function abrirModalLancamento(id) {
  $('lanc-erro').textContent = '';
  const lanc = id ? LANCAMENTOS_CACHE.find(l => l.id === id) : null;
  $('lanc-id').value = lanc ? lanc.id : '';
  $('modal-lancamento-titulo').textContent = lanc ? 'Editar lançamento' : 'Novo lançamento';
  $('lanc-tipo').value = lanc ? lanc.tipo : 'saida';
  $('lanc-descricao').value = lanc ? lanc.descricao : '';
  $('lanc-valor').value = lanc ? lanc.valor : '';
  $('lanc-socio').value = lanc ? (lanc.socio_id || '') : '';
  $('lanc-data').value = lanc ? lanc.data : new Date().toISOString().slice(0, 10);
  $('modal-lancamento').classList.remove('oculto');
}

async function salvarLancamento() {
  $('lanc-erro').textContent = '';
  const id = $('lanc-id').value;
  const payload = {
    tipo: $('lanc-tipo').value, descricao: $('lanc-descricao').value,
    valor: $('lanc-valor').value, socio_id: $('lanc-socio').value || null, data: $('lanc-data').value
  };
  try {
    if (id) await api('PUT', `/api/lancamentos/${id}`, payload);
    else await api('POST', '/api/lancamentos', payload);
    fecharModal('modal-lancamento');
    await carregarLancamentos();
  } catch (e) { $('lanc-erro').textContent = e.message; }
}

async function excluirLancamento(id) {
  if (!confirm('Excluir este lançamento?')) return;
  await api('DELETE', '/api/lancamentos/' + id);
  await carregarLancamentos();
}

// ---------- Usuários ----------
async function carregarUsuarios() {
  const lista = await api('GET', '/api/usuarios');
  $('lista-usuarios').innerHTML = lista.map(u => `
    <tr>
      <td>${u.nome}${u.is_admin ? ' ⭐' : ''}</td>
      <td>${u.email}</td>
      <td>${(u.criado_em || '').slice(0, 10).split('-').reverse().join('/')}</td>
      <td>
        <button class="btn-mini" onclick="abrirModalTrocarSenha(${u.id}, '${u.nome.replace(/'/g, "\\'")}')">Trocar senha</button>
        ${u.id !== USUARIO.id ? `<button class="btn-mini" onclick="excluirUsuario(${u.id})">Remover acesso</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4">Nenhum usuário.</td></tr>';
}

function abrirModalUsuario() {
  $('user-erro').textContent = '';
  $('user-nome-novo').value = '';
  $('user-email-novo').value = '';
  $('user-senha-novo').value = '';
  $('modal-usuario').classList.remove('oculto');
}

async function salvarUsuario() {
  $('user-erro').textContent = '';
  try {
    await api('POST', '/api/usuarios', {
      nome: $('user-nome-novo').value, email: $('user-email-novo').value, senha: $('user-senha-novo').value
    });
    fecharModal('modal-usuario');
    await carregarUsuarios();
  } catch (e) { $('user-erro').textContent = e.message; }
}

async function excluirUsuario(id) {
  if (!confirm('Remover o acesso desse usuário?')) return;
  try {
    await api('DELETE', '/api/usuarios/' + id);
    await carregarUsuarios();
  } catch (e) { alert(e.message); }
}

// ---------- Trocar senha (direto no painel, sem codigo de recuperacao) ----------
function abrirModalTrocarSenha(id, nome) {
  $('trocar-senha-erro').textContent = '';
  $('trocar-senha-user-id').value = id;
  $('trocar-senha-nova').value = '';
  $('trocar-senha-titulo').textContent = `Trocar senha — ${nome}`;
  $('modal-trocar-senha').classList.remove('oculto');
}

async function salvarTrocaSenha() {
  $('trocar-senha-erro').textContent = '';
  const id = $('trocar-senha-user-id').value;
  try {
    await api('PUT', `/api/usuarios/${id}/senha`, { novaSenha: $('trocar-senha-nova').value });
    fecharModal('modal-trocar-senha');
    alert('Senha trocada. Se era a sua própria conta, você vai precisar entrar de novo com a senha nova.');
  } catch (e) { $('trocar-senha-erro').textContent = e.message; }
}

// ---------- Modal helpers ----------
function fecharModal(id) { $(id).classList.add('oculto'); }

checarSessao();
