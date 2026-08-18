# KN Center — Gestão

Sistema de estoque e sócios para loja de eletrônicos/iPhones, adaptado do modelo usado no
sistema de gestão de carros (aclera.cars), substituindo a lógica de "1 veículo = 1 registro"
por um modelo misto: itens únicos (iPhones por IMEI) e lotes com quantidade (acessórios).

Baseado na planilha real da loja (aba "KNBRIK — Controle de Produtos": produtos, divisão de
investimento entre sócios, retorno por sócio, lucro por mês/semana com meta, extrato por sócio,
produtos disponíveis). "KNBRIK" era o nome de trabalho anterior — a marca agora é **KN Center**,
com logo e ícones próprios; o layout da planilha em si não mudou, só o nome do sistema.

## Deixando como app no iPhone (sem passar pela App Store)

O site já vem com manifest, ícones (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) e as
meta tags que o iOS pede pra rodar em tela cheia, sem barra do Safari. No iPhone: abre o site no
Safari → botão de compartilhar → **"Adicionar à Tela de Início"**. Vira um ícone igual a qualquer
app, abre em tela cheia. Não precisa de loja de app nem de conta de desenvolvedor Apple.

## O que foi adaptado do sistema de carros e o que foi removido

Mantido (não é específico de carro): login com cookie httpOnly, cadastro fechado por convite,
auditoria de criação/edição/exclusão, upload de fotos, deploy Railway com volume persistente.

Simplificado: a recuperação de senha por código único foi trocada por troca direta — qualquer
pessoa logada pode trocar a senha de qualquer conta na aba Usuários (botão "Trocar senha"), sem
precisar de código nem email. Isso desloga a conta afetada, que precisa entrar de novo com a
senha nova.

Removido, sem substituto (conforme decidido): tabela FIPE, verificação de placa, alerta de
"material parado há 15+ dias". Nenhum desses tem equivalente natural em eletrônicos.

Redesenhado do zero: o schema de produto. Veículo virava 1 registro com 1 valor de compra e
1 venda. Produto agora suporta quantidade (lote), com custo total dividido pela quantidade pra
achar o custo unitário, e cada venda desconta do estoque — permite vender parte de um lote de
carregadores/películas ao longo do tempo, do jeito que a planilha já fazia manualmente.

## Regra de divisão entre sócios (replicada da planilha, com uma correção)

O valor pago na compra é dividido livremente entre os sócios (não precisa ser 50/50 — dá pra
registrar exatamente como na planilha, ex: um sócio pagou tudo em um produto e no seguinte
dividiram igual). O lucro de cada venda, porém, é **sempre dividido em partes iguais** entre os
sócios que investiram naquele produto — é a regra que a planilha já aplicava manualmente linha a
linha (`Retorno = Pago + Lucro/2`, mesmo quando o pago não era 50/50).

Diferente da planilha: o sistema **valida na hora de salvar** que a soma do que cada sócio pagou
bate com o custo total do produto. Na planilha original, o produto KNB002 tinha uma diferença de
R$158 entre "Custo Compra" (R$3.308) e a soma de "Pago Kauã" + "Pago Gustavo" (R$3.150) — não dava
pra saber se foi frete esquecido ou erro de digitação. O sistema novo não deixa salvar um produto
nesse estado.

## Rodando localmente

```
npm install
npm start
```

Abre em http://localhost:3000. Primeiro acesso: "Não tem conta? Cadastre-se" — o primeiro usuário
criado vira admin e pode cadastrar o segundo sócio/usuário depois. Sócios "Kauã" e "Gustavo" já
vêm cadastrados por padrão (dá pra editar o nome ou adicionar mais sócios na tela de Extrato, se
precisar).

## Importar planilha (pelo site, sem terminal)

Na aba **Produtos**, tem um botão **"📥 Importar planilha (.xlsx)"** ao lado de "+ Novo produto".
Escolhe o arquivo da planilha (mesmo layout da KNBRIK, aba "Produtos") e ele importa direto —
sem precisar de terminal, Node, Railway CLI ou nada disso. É idempotente: se importar a mesma
planilha de novo (ou uma atualizada), produtos cujo SKU já existe são pulados, não duplica.

Depois de importar, aparece um resumo na tela: quantos produtos entraram, quantas vendas foram
registradas, e a lista de casos que precisam de conferência manual (ver mais abaixo por quê).

### Alternativa via terminal (script `importar-planilha.js`)

Só necessário se preferir rodar por fora do site, ou pra importar sem estar logado no navegador:

```
npm install
npm start        # cria o schema do banco — deixe rodar uns segundos e pare (Ctrl+C)
node importar-planilha.js
```

Isso popula o banco com os 50 produtos da planilha KNBRIK (atualizada em 16/08), a divisão de
investimento entre Kauã e Gustavo, e as 38 vendas que já reconciliam certinho com o lucro real
registrado na planilha. É idempotente — pode rodar de novo sem duplicar (pula SKU já existente).
Usa o mesmo motor de reconciliação do botão do site (`importador.js`), só que a partir de um
JSON já extraído (`import-produtos.json`) em vez de subir o arquivo .xlsx direto.

**5 casos não entraram automático porque os números da própria planilha não fecham entre si** —
ler `import-avisos.txt` pra ver os 5, mas resumindo:

- **KNB002**: custo total (R$3.308) não bate com a soma do que Kauã+Gustavo pagaram (R$3.150) —
  falta R$158 identificar. Importado com o custo original pra não estragar o lucro histórico, mas
  o sistema vai travar a próxima edição desse produto até a divisão fechar.
- **KNB014**: o status na planilha dizia "1 de 4 em estoque", mas o lucro real só bate matematicamente
  se as 4 unidades tiverem sido vendidas — status provavelmente ficou desatualizado. Importado como
  4 vendidas.
- **KNB022 e KNB045**: trocas sem valor monetário claro (ex: PS4 trocado direto por um Xbox). Ficaram
  marcadas como fora de estoque, mas nenhuma venda em R$ foi criada — é um valor de troca, não uma
  venda, e o sistema atual não modela troca de item por item.
- **KNB026**: venda de R$750 registrada, mas a planilha zerou o lucro real mesmo custando R$1.250
  (provável perda que não quiseram formalizar). Não importado como venda pra não fabricar um número
  que a própria planilha evita declarar.

`import-produtos.json` tem os dados tratados linha a linha (o que o script realmente vai gravar);
`dados-planilha.json` é o dump bruto da planilha, caso precise conferir algo à mão.

## Deploy no Railway — PASSO CRÍTICO: volume persistente

Sem isso, todo redeploy apaga o banco de dados.

1. No canvas do projeto (não dentro do serviço), aperta `Ctrl+K`/`⌘K` ou clica com o botão
   direito pra abrir o menu de criar volume.
2. Escolhe o serviço do KNBRIK pra conectar o volume.
3. Mount path: `/app/data`
4. Redeploy o serviço.

Volume só é montado quando o container inicia (não durante o build) — se algo escrever em
`data/` no build, não persiste. E se a imagem não rodar como root, precisa da variável de
ambiente `RAILWAY_RUN_UID=0` (não é o caso do `nixpacks.toml` deste projeto).

`server.js` lê `DB_PATH` do ambiente (padrão: `./data/knbrik.db`). Fotos ficam em `data/uploads`,
dentro do mesmo volume — se o volume não estiver configurado, banco e fotos somem no redeploy.

## Não testado em ambiente real

Assim como o sistema original de carros, este código não rodou de ponta a ponta em produção —
`better-sqlite3` precisa compilar nativamente e este ambiente não tem acesso à internet liberado
pra isso. Foi validado só por `node --check` (sintaxe) e revisão manual linha a linha das fórmulas
de lucro/retorno, comparando com os valores reais da planilha (produtos KNB001 a KNB009 batem).
Teste local (`npm install && npm start`) antes de apontar pra produção.

## Pendente / não incluído nesta primeira versão

- Checklist de diagnóstico de aparelho usado (tela, botões, bateria) — não pedido ainda, mas o
  padrão do sistema de carros (`checklist_itens`) dá pra adaptar rápido se fizer sentido.
- Contas a receber / parcelamento de venda — a planilha não mostrava esse fluxo pra eletrônicos,
  então não foi incluído. Avisa se a loja vende parcelado.
- Permissões granulares por módulo (o sistema de carros tinha isso) — simplificado pra "qualquer
  usuário logado vê tudo", já que é uma operação de 2 sócios. Reintroduz se entrar mais gente.
