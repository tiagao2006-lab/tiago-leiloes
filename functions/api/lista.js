const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
});
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function rowsCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ';') { row.push(field); field = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v.trim())) rows.push(row);
      row = []; field = '';
    } else field += c;
  }
  if (quoted) throw Error('CSV com aspas não fechadas.');
  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
function money(value) {
  const s = String(value ?? '').replace(/[^\d,.-]/g, '').trim();
  if (!s) return 0;
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0;
}
const allowedUF = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
function convert(csv, name, previous) {
  const rows = rowsCSV(csv.replace(/^\uFEFF/, ''));
  const headerIndex = rows.findIndex(row => {
    const h = row.map(norm);
    return h.includes('uf') && h.includes('cidade') && h.includes('bairro') && h.includes('preco') && h.includes('modalidadedevenda') && h.includes('endereco');
  });
  if (headerIndex < 0) throw Error('Cabeçalho oficial da Caixa não encontrado.');
  const header = rows[headerIndex].map(norm);
  const get = (row, ...names) => {
    for (const n of names) {
      const idx = header.indexOf(norm(n));
      if (idx >= 0) return String(row[idx] ?? '').trim();
    }
    return '';
  };
  const metadata = rows.slice(0, headerIndex).flat().join(' ');
  const dateMatch = metadata.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  const generated = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : new Date().toISOString().slice(0, 10);
  const items = []; const ids = new Set(); const ufs = new Set(); let invalid = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const id = get(row, 'N° do imóvel', 'Nº do imóvel', 'Número do imóvel', 'Numero do imovel');
    const uf = get(row, 'UF').toUpperCase();
    const price = money(get(row, 'Preço', 'Preco', 'Valor de venda'));
    if (!id || !allowedUF.has(uf) || !(price > 0)) { invalid++; continue; }
    if (ids.has(id)) { invalid++; continue; }
    ids.add(id); ufs.add(uf);
    const valuation = money(get(row, 'Valor de avaliação', 'Valor de avaliacao'));
    const originalDiscount = money(get(row, 'Desconto'));
    items.push({
      id, uf, city: get(row, 'Cidade'), district: get(row, 'Bairro'),
      address: get(row, 'Endereço', 'Endereco'), description: get(row, 'Descrição', 'Descricao'),
      price, valuation,
      discount: valuation > 0 ? (1 - price / valuation) * 100 : originalDiscount,
      finance: get(row, 'Financiamento', 'Aceita financiamento'),
      mode: get(row, 'Modalidade de venda', 'Modalidade'),
      url: get(row, 'Link de acesso', 'Link', 'URL')
    });
  }
  if (items.length < 1000 || ufs.size < 20) {
    throw Error(`Lista incompleta: ${items.length} imóveis em ${ufs.size} UFs. Publicação cancelada.`);
  }
  const old = new Map((previous?.items || []).map(x => [x.id, x.price]));
  const reductions = items.filter(x => old.has(x.id) && old.get(x.id) > x.price).map(x => [x.id, old.get(x.id)]);
  return {
    revision: crypto.randomUUID(), generated,
    input: { name, imported: new Date().toISOString(), invalid,
      comparison: previous ? { name: previous.input?.name || 'Lista anterior', generated: previous.generated, reductions } : null },
    items
  };
}

// Índice geográfico compacto: 16 partições, sem repetir a base nacional na API do mapa.
function geoBucket(id) {
  let h=2166136261;
  for(const c of String(id)) {h^=c.charCodeAt(0);h=Math.imul(h,16777619);}
  return (h>>>0)%16;
}
async function publishGeoIndex(env, listing) {
  const shards=Array.from({length:16},()=>({}));
  for(const x of listing.items) {
    if(!x.id||!x.uf||!x.city||!x.address)continue;
    shards[geoBucket(x.id)][String(x.id)]={id:String(x.id),uf:x.uf,city:x.city,district:x.district||'',address:x.address};
  }
  const revision=String(listing.revision);
  // Primeiro gravar todas as partições; somente depois ativar a nova revisão.
  for(let i=0;i<16;i++)await env.IMOVEIS_KV.put(`geo-index:${revision}:${i}`,JSON.stringify(shards[i]),{expirationTtl:7776000});
  await env.IMOVEIS_KV.put('geo-index:active',JSON.stringify({revision,buckets:16,count:listing.items.length}));
  return shards.reduce((n,shard)=>n+Object.keys(shard).length,0);
}

export async function onRequest({ request, env }) {
  if (!env.IMOVEIS_KV) return json({ error: 'Configure o binding IMOVEIS_KV no Cloudflare Pages.' }, 503);
  if (request.method === 'GET') {
    const listing = await env.IMOVEIS_KV.get('lista', 'json');
    if (!listing) return json({ error: 'Nenhuma lista publicada ainda.' }, 404);
    const etag = `"${listing.revision}"`;
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return json(listing, 200, { ETag: etag });
  }
  // Inicialização única do índice, sem exigir reenvio do CSV nacional.
  if(request.method==='POST' && new URL(request.url).searchParams.get('action')==='reindex') {
    if(!env.ADMIN_TOKEN || request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`)
      return json({error:'Chave administrativa inválida.'},401);
    try {
      const listing=await env.IMOVEIS_KV.get('lista','json');
      if(!listing?.revision||!Array.isArray(listing.items))return json({error:'Lista nacional não encontrada.'},404);
      const indexed=await publishGeoIndex(env,listing);
      return json({ok:true,indexed,revision:listing.revision});
    } catch(error){return json({error:'Falha ao criar índice: '+String(error.message||error)},500);}
  }
  if (request.method === 'PUT') {
    const token = env.ADMIN_TOKEN;
    if (!token || request.headers.get('Authorization') !== `Bearer ${token}`)
      return json({ error: 'Chave administrativa inválida ou não configurada.' }, 401);
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > 15000000) return json({ error: 'CSV acima do limite de 15 MB.' }, 413);
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 15000000) return json({ error: 'CSV acima do limite de 15 MB.' }, 413);
      let csv;
      try { csv = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { csv = new TextDecoder('windows-1252').decode(buffer); }
      const previous = await env.IMOVEIS_KV.get('lista', 'json');
      const name = decodeURIComponent(request.headers.get('X-CSV-Name') || 'Lista_imoveis_geral.csv');
      const listing = convert(csv, name, previous);
      const serialized = JSON.stringify(listing);
      if (new TextEncoder().encode(serialized).length > 24000000)
        return json({ error: 'Lista processada acima do limite seguro do KV. Publicação cancelada.' }, 413);
      await env.IMOVEIS_KV.put('lista', serialized);
      let geoIndexReady=true;
      try { await publishGeoIndex(env,listing); } catch(e) {geoIndexReady=false;}
      return json({ geoIndexReady, count: listing.items.length, ufs: new Set(listing.items.map(x => x.uf)).size, generated: listing.generated, revision: listing.revision, unchanged: false });
    } catch (e) {
      return json({ error: e.message || 'Erro ao importar CSV.' }, 400);
    }
  }
  return json({ error: 'Método não permitido' }, 405, { Allow: 'GET, PUT' });
}
