const json=(obj,status=200,headers={})=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function rowsCSV(text){
 const out=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===';'){row.push(field);field='';}else if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))out.push(row);row=[];field='';}else field+=c;}
 row.push(field);if(row.some(v=>v.trim()))out.push(row);return out;
}
function money(v){const s=String(v||'').replace(/[^\d,.-]/g,'').trim();if(!s)return 0;return Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'):s)||0;}
function convert(csv,name,previous){const rows=rowsCSV(csv.replace(/^\uFEFF/,''));if(rows.length<2)throw Error('CSV sem imóveis');
 const head=rows.shift().map(norm);const get=(r,...names)=>{for(const n of names){const i=head.indexOf(norm(n));if(i>=0)return (r[i]||'').trim();}return '';};
 const items=rows.map(r=>{const valuation=money(get(r,'Valor de avaliação','Valor de avaliacao'));const price=money(get(r,'Valor de venda','Preço','Preco'));const id=get(r,'N° do imóvel','Nº do imóvel','Numero do imovel','Numero do imóvel');return {id,uf:get(r,'UF'),city:get(r,'Cidade'),district:get(r,'Bairro'),address:get(r,'Endereço','Endereco'),description:get(r,'Descrição','Descricao'),price,valuation,discount:valuation>0?(1-price/valuation)*100:0,finance:get(r,'Aceita financiamento','Financiamento'),mode:get(r,'Modalidade de venda','Modalidade'),url:get(r,'Link de acesso','Link','URL')};}).filter(x=>x.id&&x.price>0);
 if(!items.length)throw Error('CSV sem registros válidos. Verifique os cabeçalhos.');
 const old=new Map((previous?.items||[]).map(x=>[x.id,x.price]));const reductions=items.filter(x=>old.has(x.id)&&old.get(x.id)>x.price).map(x=>[x.id,old.get(x.id)]);
 return {revision:crypto.randomUUID(),generated:new Date().toISOString().slice(0,10),input:{name,imported:new Date().toISOString(),comparison:previous?{name:previous.input?.name||'Lista anterior',generated:previous.generated,reductions}:null},items};}
export async function onRequest({request,env}){
 if(!env.IMOVEIS_KV)return json({error:'Configure o binding KV IMOVEIS_KV no Cloudflare Pages.'},503);
 if(request.method==='GET'){
 const listing=await env.IMOVEIS_KV.get('lista','json');if(!listing)return json({error:'Nenhuma lista publicada ainda. Importe um CSV oficial.'},404);
 const etag='"'+listing.revision+'"';if(request.headers.get('If-None-Match')===etag)return new Response(null,{status:304,headers:{ETag:etag}});
 return json(listing,200,{ETag:etag});}
 if(request.method==='PUT'){
 const token=env.ADMIN_TOKEN;const provided=request.headers.get('Authorization')||'';
 if(!token||provided!==`Bearer ${token}`)return json({error:'Publicação restrita. Configure ADMIN_TOKEN e envie Authorization: Bearer <token>.'},401);
 const raw=await request.text();if(raw.length>15000000)return json({error:'CSV muito grande.'},413);
 try{const previous=await env.IMOVEIS_KV.get('lista','json');const name=decodeURIComponent(request.headers.get('X-CSV-Name')||'Lista_imoveis.csv');const listing=convert(raw,name,previous);await env.IMOVEIS_KV.put('lista',JSON.stringify(listing));return json({count:listing.items.length,revision:listing.revision,unchanged:false});}catch(e){return json({error:e.message},400);}}
 return json({error:'Método não permitido'},405,{Allow:'GET, PUT'});
}
