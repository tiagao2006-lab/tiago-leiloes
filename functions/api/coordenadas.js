// Tiago Leilões · /api/coordenadas
// Coloque este arquivo em cccc/functions/api/coordenadas.js
// Configure GEOAPIFY_API_KEY em Cloudflare Pages > Settings > Variables and Secrets.
// Usa IMOVEIS_KV já vinculado ao site. A chave permanece apenas no servidor.

const answer=(obj,status=200)=>new Response(JSON.stringify(obj),{
  status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
});
const normalize=(value)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const validId=id=>/^[0-9a-zA-Z-]{4,40}$/.test(String(id));

async function fingerprint(item) {
  const text=[item.id,item.uf,item.city,item.district,item.address].join('|');
  const bytes=new TextEncoder().encode(text);
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].slice(0,12).map(n=>n.toString(16).padStart(2,'0')).join('');
}
function withinBrazil(lat,lon){return lat>=-34 && lat<=6 && lon>=-75 && lon<=-30;}
function acceptable(result,item) {
  if(!result||!Number.isFinite(+result.lat)||!Number.isFinite(+result.lon))return null;
  const lat=Number(result.lat),lon=Number(result.lon);
  if(!withinBrazil(lat,lon)||String(result.country_code).toLowerCase()!=='br')return null;
  const state=String(result.state_code||'').toUpperCase().split('-').pop();
  if(state&&state!==String(item.uf).toUpperCase())return null;
  const desiredCity=normalize(item.city);
  const matchedCities=[result.city,result.municipality,result.county].filter(Boolean).map(normalize);
  if(!desiredCity || !matchedCities.some(x=>x===desiredCity))return null;
  const type=String(result.result_type||'').toLowerCase();
  const confidence=Number(result.rank?.confidence||0);
  const building=['building','amenity'].includes(type);
  const street=type==='street';
  if(!building&&!street)return null; // Nunca marcar o centro de um município como imóvel.
  if(confidence < (building ? 0.66 : 0.59))return null;
  return {lat,lon,precision:building?'building':'street',provider:'Geoapify'};
}
async function geocode(item,key) {
  const query=[item.address,item.district,item.city,item.uf,'Brasil'].filter(Boolean).join(', ');
  const url=new URL('https://api.geoapify.com/v1/geocode/search');
  url.searchParams.set('text',query);
  url.searchParams.set('format','json');
  url.searchParams.set('filter','countrycode:br');
  url.searchParams.set('limit','3');
  url.searchParams.set('lang','pt');
  url.searchParams.set('apiKey',key);
  const response=await fetch(url.toString(),{headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('Geocodificação indisponível ('+response.status+').');
  const data=await response.json();
  const candidates=Array.isArray(data.results)?data.results:[];
  return candidates.map(candidate=>acceptable(candidate,item)).find(Boolean)||null;
}
async function dailyRateLimit(env,request) {
  const ip=request.headers.get('CF-Connecting-IP')||'sem-ip';
  const today=new Date().toISOString().slice(0,10);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(today+'|'+ip));
  const key='geo-ratelimit:'+today+':'+Array.from(new Uint8Array(digest)).slice(0,10).map(x=>x.toString(16).padStart(2,'0')).join('');
  const count=Number(await env.IMOVEIS_KV.get(key)||0);
  if(count>=30)return false;
  await env.IMOVEIS_KV.put(key,String(count+1),{expirationTtl:86400});
  return true;
}
export async function onRequest({request,env}) {
  if(request.method!=='POST')return answer({error:'Método não permitido.'},405);
  if(!env.IMOVEIS_KV)return answer({error:'IMOVEIS_KV não configurado.'},503);
  try {
    const length=Number(request.headers.get('content-length')||0);
    if(length>5000)return answer({error:'Requisição muito grande.'},413);
    const body=await request.json();
    const requested=Array.isArray(body.ids)?body.ids.map(String).filter(validId).slice(0,50):[];
    const ids=[...new Set(requested)];
    if(!ids.length)return answer({error:'Informe identificadores de imóveis.'},400);
    const index=await env.IMOVEIS_KV.get('geo-index:active','json');
    if(!index?.revision)return answer({error:'Índice geográfico ainda não inicializado. Execute a indexação administrativa uma vez.',code:'INDEX_NOT_READY'},503);
    const bucketFor=id=>{
      let h=2166136261;
      for(const c of String(id)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}
      return (h>>>0)%16;
    };
    const groups=new Map();
    for(const id of ids){const b=bucketFor(id);if(!groups.has(b))groups.set(b,[]);groups.get(b).push(id);}
    const matches=new Map();
    // Lê apenas partições compactas, não o JSON de todos os imóveis.
    for(const [bucket,group] of groups){
      const shard=await env.IMOVEIS_KV.get(`geo-index:${index.revision}:${bucket}`,'json');
      if(!shard)return answer({error:'Índice geográfico incompleto. Refaça a indexação.',code:'INDEX_INCOMPLETE'},503);
      for(const id of group)if(shard[id])matches.set(id,shard[id]);
    }
    const points=[];
    const uncached=[];
    for(const id of ids) {
      const item=matches.get(id);if(!item||!item.address||!item.city||!item.uf)continue;
      const hash=await fingerprint(item);
      const storageKey='geo:v1:'+id;
      const cached=await env.IMOVEIS_KV.get(storageKey,'json');
      if(cached?.hash===hash) {
        if(cached.point)points.push({id,...cached.point});
      } else uncached.push({id,item,hash,storageKey});
    }
    const configured=Boolean(env.GEOAPIFY_API_KEY);
    let attempted=0,limitReached=false;
    if(body.resolve===true && configured && uncached.length) {
      // Pequenos lotes sob demanda, com limite por visitante. KV não é limitador atômico global.
      for(const entry of uncached.slice(0,2)) {
        if(!(await dailyRateLimit(env,request))){limitReached=true;break;}
        attempted++;
        try {
          const point=await geocode(entry.item,env.GEOAPIFY_API_KEY);
          await env.IMOVEIS_KV.put(entry.storageKey,JSON.stringify({hash:entry.hash,point}),{expirationTtl:point?2592000:604800});
          if(point)points.push({id:entry.id,...point});
        } catch(error) {
          return answer({error:error.message||'Falha na consulta de coordenadas.',points,configured,attempted},503);
        }
      }
    }
    return answer({points,configured,attempted,limitReached,missing:Math.max(0,uncached.length-attempted)});
  } catch(error) {
    return answer({error:error?.message||'Erro ao consultar localizações.'},400);
  }
}
