// Le uma planilha .xlsx no formato "KNBRIK — Controle de Produtos" (aba "Produtos") e devolve
// uma lista de produtos prontos pra gravar no banco, ja reconciliados: quantidade vendida
// calculada a partir do status, vendas so incluidas quando o valor bate matematicamente com o
// lucro real declarado, e avisos pra tudo que nao fechou sozinho (fica pra revisao manual na
// tela de Produtos, nao trava a importacao dos outros).
const XLSX = require('xlsx');

function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '—' || s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function parseQtd(condicao, nome) {
  for (const txt of [condicao, nome]) {
    if (!txt) continue;
    const m = txt.match(/(\d+)\s*(?:un\.?|unidades)\b/i);
    if (m) return parseInt(m[1], 10);
  }
  return 1;
}

function categoria(nome) {
  const n = nome.toLowerCase();
  if (n.includes('iphone')) return 'iPhone';
  if (n.includes('tv')) return 'TV';
  if (n.includes('playstation') || n.includes('ps4') || n.includes('xbox') || n.includes('console')) return 'Console/Videogame';
  if (n.includes('xiaomi') || n.includes('android')) return 'Android';
  if (['carregador', 'cabo', 'fone', 'pelicula', 'película', 'capa', 'suporte'].some(k => n.includes(k))) return 'Acessório';
  return 'Outro';
}

function iso(d) {
  if (!d || d === '—') return null;
  const [dd, mm, yyyy] = String(d).split('/');
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function parseProdutosSheet(workbook) {
  const ws = workbook.Sheets['Produtos'];
  if (!ws) throw new Error('Aba "Produtos" nao encontrada na planilha. Confira se e o arquivo certo (modelo KNBRIK).');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const cols = ['id', 'produto', 'condicao', 'data_compra', 'custo_compra', 'pago_kaua', 'pago_gustavo',
    'preco_anuncio', 'min_lucro', 'lucro_estimado', 'data_venda', 'valor_vendido', 'canal_venda',
    'lucro_real', 'retorno_kaua', 'retorno_gustavo', 'lucro_parcial', 'status'];
  const out = [];
  for (const r of rows.slice(3)) {
    if (!r || !r[0] || !String(r[0]).startsWith('KNB')) continue;
    const obj = {};
    cols.forEach((c, i) => obj[c] = r[i] === undefined ? null : r[i]);
    out.push(obj);
  }
  return out;
}

function reconciliar(linhas) {
  const produtos = [];
  const avisos = [];

  for (const r of linhas) {
    const sku = r.id, nome = r.produto, condicao = r.condicao || '';
    const custo = num(r.custo_compra) || 0;
    const pagoKaua = num(r.pago_kaua) || 0;
    const pagoGustavo = num(r.pago_gustavo) || 0;
    const precoAnuncio = num(r.preco_anuncio);
    const minLucro = num(r.min_lucro);
    const status = r.status;
    const valorVendidoRaw = num(r.valor_vendido);
    const lucroRealStated = num(r.lucro_real);
    const canal = r.canal_venda || '';
    const dataVenda = r.data_venda;

    let qtdTotal = parseQtd(condicao, nome);
    let custoUnit = qtdTotal ? custo / qtdTotal : custo;

    const somaPago = pagoKaua + pagoGustavo;
    const obsParts = [];
    let investimentoIncompleto = false;
    if (Math.abs(somaPago - custo) > 0.01) {
      investimentoIncompleto = true;
      avisos.push(`${sku} (${nome}): custo total R$${custo.toFixed(2)}, mas Kauã (R$${pagoKaua.toFixed(2)}) + Gustavo (R$${pagoGustavo.toFixed(2)}) = R$${somaPago.toFixed(2)} — falta R$${(custo - somaPago).toFixed(2)} identificar de quem. Importado com o custo original; ajuste a divisão na tela de Produtos (o sistema vai travar até a soma bater).`);
      obsParts.push(`[Import] ATENÇÃO: soma paga por sócio (R$${somaPago.toFixed(2)}) não bate com o custo total (R$${custo.toFixed(2)}). Corrija a divisão entre sócios nesta tela.`);
    }

    let qtdVendida = 0;
    const mEstoque = status && status.match(/Estoque\s*\((\d+)\s*\/\s*(\d+)\)/);
    if (mEstoque) {
      const restante = parseInt(mEstoque[1], 10), totalStatus = parseInt(mEstoque[2], 10);
      if (totalStatus !== qtdTotal) qtdTotal = totalStatus;
      qtdVendida = qtdTotal - restante;
    } else if (status === 'Vendido' || status === 'Vendido (Troca)' || status === 'Esgotado') {
      qtdVendida = qtdTotal;
    } else if (status && status.startsWith('Esgotado')) {
      const mv = canal.match(/(\d+)\s*vend/i);
      qtdVendida = mv ? parseInt(mv[1], 10) : qtdTotal;
    } else if (status === 'Disponível') {
      qtdVendida = 0;
    } else if (status && status.startsWith('Troca')) {
      qtdVendida = qtdTotal;
    } else {
      avisos.push(`${sku}: status não reconhecido '${status}'.`);
    }

    let venda = null;
    if (qtdVendida > 0 && valorVendidoRaw !== null) {
      const lucroPara = (qtd) => valorVendidoRaw - custoUnit * qtd;
      let lucroCalc = lucroPara(qtdVendida);
      let reconciliou = lucroRealStated !== null && Math.abs(lucroCalc - lucroRealStated) < 1.0;
      let valorFinal = valorVendidoRaw;
      let qtdFinal = qtdVendida;

      if (!reconciliou && lucroRealStated !== null && custoUnit > 0) {
        const qtdTentativa = (valorVendidoRaw - lucroRealStated) / custoUnit;
        const qtdArred = Math.round(qtdTentativa);
        if (Math.abs(qtdTentativa - qtdArred) < 0.02 && qtdArred >= 0 && qtdArred <= qtdTotal) {
          qtdFinal = qtdArred;
          lucroCalc = lucroPara(qtdFinal);
          if (Math.abs(lucroCalc - lucroRealStated) < 1.0) {
            reconciliou = true;
            avisos.push(`${sku} (${nome}): status dizia '${status}' (sugerindo ${qtdVendida} vendida(s)) mas o lucro real só bate com ${qtdFinal} unidade(s). Importado com ${qtdFinal}; confira se o status na planilha estava desatualizado.`);
          }
        }
      }

      if (!reconciliou) {
        const md = canal.match(/-\s*R\$\s*([\d.,]+)/);
        if (md) {
          const txt = md[1];
          const desconto = txt.includes(',') ? parseFloat(txt.replace(/\./g, '').replace(',', '.')) : parseFloat(txt);
          const lucroCalc2 = (valorVendidoRaw - desconto) - custoUnit * qtdVendida;
          if (lucroRealStated !== null && Math.abs(lucroCalc2 - lucroRealStated) < 1.0) {
            valorFinal = valorVendidoRaw - desconto;
            qtdFinal = qtdVendida;
            reconciliou = true;
            obsParts.push(`[Import] Valor bruto da venda era R$${valorVendidoRaw.toFixed(2)}; descontado R$${desconto.toFixed(2)} (${canal.trim()}) pra bater com o lucro real da planilha (R$${lucroRealStated.toFixed(2)}).`);
          }
        }
      }

      if (reconciliou) {
        venda = {
          quantidade: qtdFinal,
          valor_vendido: Math.round(valorFinal * 100) / 100,
          canal_venda: canal !== '—' ? canal : '',
          data_venda: iso(dataVenda),
          obs: ''
        };
      } else {
        avisos.push(`${sku} (${nome}): venda de R$${valorVendidoRaw.toFixed(2)} (canal '${canal}') NÃO reconcilia com o lucro real da planilha (R$${lucroRealStated}). Não importada automaticamente — registre manualmente pela tela de Vender.`);
        obsParts.push(`[Import] NÃO IMPORTADO COMO VENDA: planilha registrava R$${valorVendidoRaw.toFixed(2)} em ${dataVenda} (canal: ${canal}), lucro real R$${lucroRealStated}, retorno Kauã R$${num(r.retorno_kaua)}, retorno Gustavo R$${num(r.retorno_gustavo)}. Registre manualmente se necessário.`);
      }
    } else if (qtdVendida > 0 && valorVendidoRaw === null) {
      obsParts.push(`[Import] Item saiu do estoque em ${dataVenda} sem valor de venda monetário na planilha (canal: ${canal}). Retorno Kauã R$${num(r.retorno_kaua)}, retorno Gustavo R$${num(r.retorno_gustavo)}, lucro real R$${lucroRealStated}. Registre manualmente se necessário.`);
      avisos.push(`${sku} (${nome}): saída de estoque sem venda monetizada (status '${status}', canal '${canal}'). Marcado fora de estoque, mas nenhuma venda foi criada — confira manualmente.`);
    }

    if (condicao) obsParts.unshift(`Condição: ${condicao}`);

    const investimentos = [];
    if (pagoKaua > 0) investimentos.push({ socio: 'Kauã', valor: Math.round(pagoKaua * 100) / 100 });
    if (pagoGustavo > 0) investimentos.push({ socio: 'Gustavo', valor: Math.round(pagoGustavo * 100) / 100 });

    produtos.push({
      sku, nome, categoria: categoria(nome), condicao,
      quantidade_total: qtdTotal,
      custo_total: Math.round(custo * 100) / 100,
      investimento_incompleto: investimentoIncompleto,
      data_compra: iso(r.data_compra),
      preco_anuncio: precoAnuncio, lucro_minimo: minLucro,
      status_manual: (status && (status.startsWith('Troca') || status.toLowerCase().includes('estragado'))) ? status : null,
      obs: obsParts.join(' | '),
      investimentos,
      venda
    });
  }

  return { produtos, avisos };
}

// le o buffer de um arquivo .xlsx e devolve { produtos, avisos } prontos pra gravar no banco
function processarPlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const linhas = parseProdutosSheet(wb);
  if (linhas.length === 0) throw new Error('Nenhum produto encontrado na aba "Produtos" (esperava linhas com ID tipo KNB001).');
  return reconciliar(linhas);
}

module.exports = { processarPlanilha };
