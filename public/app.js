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
  ['form-login', 'form-cadastro', 'form-recuperar'].forEach(f => $(f).classList.add('oculto'));
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
    $('cad-codigo-texto').textContent = r.recoveryCode;
    $('cad-codigo').classList.remove('oculto');
  } catch (e) { $('cad-erro').textContent = e.message; }
}

async function recuperarSenha() {
  $('rec-erro').textContent = '';
  try {
    await api('POST', '/api/auth/recuperar-senha', {
      email: $('rec-email').value, codigo: $('rec-codigo').value, novaSenha: $('rec-senha').value
    });
    alert('Senha alterada. Faça login com a nova senha.');
    mostrar('form-login');
  } catch (e) { $('rec-erro').textContent = e.message; }
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
  document.querySelectorAll('.aba-btn').forEach(b => b.classList.toggle('ativa', b.dataset.aba === aba));
  document.querySelectorAll('.aba').forEach(s => s.classList.add('oculto'));
  $('aba-' + aba).classList.remove('oculto');
  if (aba === 'resumo') await carregarResumo();
  if (aba === 'produtos') await carregarProdutos();
  if (aba === 'disponiveis') await carregarDisponiveis();
  if (aba === 'mensal') await carregarMensal();
  if (aba === 'semanal') await carregarSemanal();
  if (aba === 'extrato') await carregarExtrato();
  if (aba === 'lancamentos') await carregarLancamentos();
  if (aba === 'usuarios') await carregarUsuarios();
}

// ---------- Resumo ----------
async function carregarResumo() {
  const r = await api('GET', '/api/dashboard/resumo');
  const cards = [
    ['💰 Total Investido', fmt(r.total_investido), ''],
    ['📦 Produtos em Aberto', r.produtos_em_aberto, ''],
    ['✅ Produtos Esgotados/Vendidos', r.produtos_esgotados, ''],
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

// ---------- Produtos ----------
let PRODUTOS_CACHE = [];

async function carregarProdutos() {
  PRODUTOS_CACHE = await api('GET', '/api/produtos');
  const tagClasse = (status) => status === 'Disponível' ? 'disp' : (status.toLowerCase().includes('vendido') || status === 'Esgotado' ? 'vendido' : 'outro');
  $('lista-produtos').innerHTML = PRODUTOS_CACHE.map(p => `
    <tr>
      <td>${p.sku || ''}</td>
      <td>${p.nome}</td>
      <td>${p.categoria}</td>
      <td>${p.quantidade_vendida}/${p.quantidade_total}</td>
      <td>${fmt(p.custo_unitario)}</td>
      <td>${fmt(p.preco_anuncio)}</td>
      <td><span class="tag ${tagClasse(p.status)}">${p.status}</span></td>
      <td>
        ${p.quantidade_restante > 0 ? `<button class="btn-mini venda" onclick="abrirModalVenda(${p.id})">Vender</button>` : ''}
        <button class="btn-mini" onclick="abrirModalProduto(${p.id})">Editar</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8">Nenhum produto cadastrado ainda.</td></tr>';
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

async function abrirModalProduto(id) {
  $('prod-erro').textContent = '';
  $('prod-id').value = id || '';
  if (id) {
    const p = await api('GET', '/api/produtos/' + id);
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
  } else {
    $('modal-produto-titulo').textContent = 'Novo produto';
    ['prod-nome','prod-sku','prod-condicao','prod-imei','prod-preco-anuncio','prod-lucro-minimo','prod-status-manual','prod-obs'].forEach(f => $(f).value = '');
    $('prod-qtd').value = 1;
    $('prod-custo').value = '';
    $('prod-data-compra').value = new Date().toISOString().slice(0, 10);
    atualizarInvestimentosUI();
    $('btn-excluir-produto').classList.add('oculto');
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
  } catch (e) { $('prod-erro').textContent = e.message; }
}

// ---------- Venda ----------
function abrirModalVenda(id) {
  const p = PRODUTOS_CACHE.find(x => x.id === id);
  $('venda-erro').textContent = '';
  $('venda-produto-id').value = id;
  $('venda-produto-nome').textContent = `${p.nome} (restam ${p.quantidade_restante})`;
  $('venda-qtd').value = 1;
  $('venda-qtd').max = p.quantidade_restante;
  $('venda-valor').value = '';
  $('venda-canal').value = '';
  $('venda-data').value = new Date().toISOString().slice(0, 10);
  $('venda-obs').value = '';
  $('modal-venda').classList.remove('oculto');
}

async function salvarVenda() {
  $('venda-erro').textContent = '';
  const id = $('venda-produto-id').value;
  try {
    await api('POST', `/api/produtos/${id}/vender`, {
      quantidade: $('venda-qtd').value,
      valor_vendido: $('venda-valor').value,
      canal_venda: $('venda-canal').value,
      data_venda: $('venda-data').value,
      obs: $('venda-obs').value
    });
    fecharModal('modal-venda');
    await carregarProdutos();
  } catch (e) { $('venda-erro').textContent = e.message; }
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
    </div>
  `).join('') || '<p>Nenhuma venda registrada ainda.</p>';
}

async function salvarMetaSemanal() {
  try {
    await api('PUT', '/api/config/meta-semanal', { meta_semanal_por_socio: $('meta-semanal-input').value });
    await carregarSemanal();
  } catch (e) { alert(e.message); }
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
async function carregarLancamentos() {
  const lista = await api('GET', '/api/lancamentos');
  $('lista-lancamentos').innerHTML = lista.map(l => `
    <tr>
      <td>${l.data.split('-').reverse().join('/')}</td>
      <td>${l.tipo === 'entrada' ? 'Entrada' : 'Saída'}</td>
      <td>${l.descricao}</td>
      <td>${l.socio_nome || 'Loja'}</td>
      <td class="${l.tipo === 'entrada' ? 'valor pos' : 'valor neg'}">${fmt(l.valor)}</td>
      <td><button class="btn-mini" onclick="excluirLancamento(${l.id})">Excluir</button></td>
    </tr>
  `).join('') || '<tr><td colspan="6">Nenhum lançamento ainda.</td></tr>';
}

function abrirModalLancamento() {
  $('lanc-erro').textContent = '';
  $('lanc-tipo').value = 'saida';
  $('lanc-descricao').value = '';
  $('lanc-valor').value = '';
  $('lanc-socio').value = '';
  $('lanc-data').value = new Date().toISOString().slice(0, 10);
  $('modal-lancamento').classList.remove('oculto');
}

async function salvarLancamento() {
  $('lanc-erro').textContent = '';
  try {
    await api('POST', '/api/lancamentos', {
      tipo: $('lanc-tipo').value, descricao: $('lanc-descricao').value,
      valor: $('lanc-valor').value, socio_id: $('lanc-socio').value || null, data: $('lanc-data').value
    });
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
      <td>${u.id !== USUARIO.id ? `<button class="btn-mini" onclick="excluirUsuario(${u.id})">Remover acesso</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">Nenhum usuário.</td></tr>';
}

function abrirModalUsuario() {
  $('user-erro').textContent = '';
  $('user-nome-novo').value = '';
  $('user-email-novo').value = '';
  $('user-senha-novo').value = '';
  $('usuario-form').classList.remove('oculto');
  $('user-codigo').classList.add('oculto');
  $('modal-usuario').classList.remove('oculto');
}

async function salvarUsuario() {
  $('user-erro').textContent = '';
  try {
    const r = await api('POST', '/api/usuarios', {
      nome: $('user-nome-novo').value, email: $('user-email-novo').value, senha: $('user-senha-novo').value
    });
    $('usuario-form').classList.add('oculto');
    $('user-codigo-texto').textContent = r.recoveryCode;
    $('user-codigo').classList.remove('oculto');
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

// ---------- Modal helpers ----------
function fecharModal(id) { $(id).classList.add('oculto'); }

checarSessao();
