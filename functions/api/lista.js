
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });

const norm = value =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function rowsCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === ";" && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }

  if (quoted) throw Error("CSV com aspas não fechadas.");

  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);

  return rows;
}

function money(value) {
  const s = String(value ?? "")
    .replace(/[^\d,.-]/g, "")
    .trim();

  if (!s) return 0;

  const number = s.includes(",")
    ? Number(s.replace(/\./g, "").replace(",", "."))
    : Number(s);

  return Number.isFinite(number) ? number : 0;
}

function decodeCSV(buffer) {
  const bytes = new Uint8Array(buffer);
  let text;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }

  return text.replace(/^\uFEFF/, "");
}

function extractDate(rows) {
  for (const row of rows.slice(0, 5)) {
    const match = row.join(" ").match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    if (match) {
      return `${match[3]}-${match[2]}-${match[1]}`;
    }
  }

  return null;
}

function convert(csv, name, previous) {
  const rows = rowsCSV(csv);
  const generatedDate = extractDate(rows);

  const headerIndex = rows.findIndex(row => {
    const h = row.map(norm);
    return h.includes("uf") &&
      h.includes("cidade") &&
      h.includes("bairro") &&
      h.includes("preco") &&
      h.includes("modalidadedevenda") &&
      h.includes("endereco");
  });

  if (headerIndex < 0) {
    throw Error("Cabeçalho oficial da Caixa não encontrado.");
  }

  const header = rows[headerIndex].map(norm);
  const dataRows = rows.slice(headerIndex + 1);

  const get = (row, ...names) => {
    for (const name of names) {
      const index = header.indexOf(norm(name));
      if (index >= 0) return String(row[index] ?? "").trim();
    }
    return "";
  };

  const items = [];
  const seen = new Set();

  for (const row of dataRows) {
    const id = get(
      row,
      "N° do imóvel",
      "Nº do imóvel",
      "Numero do imovel",
      "Número do imóvel"
    ).replace(/\s/g, "");

    const uf = get(row, "UF").toUpperCase();
    const price = money(get(row, "Preço", "Valor de venda"));

    if (!id || !uf || price <= 0 || seen.has(id)) continue;

    const valuation = money(
      get(row, "Valor de avaliação", "Valor de avaliacao")
    );

    const rawDiscount = get(row, "Desconto");
    const discount = rawDiscount
      ? money(rawDiscount)
      : valuation > 0
        ? (1 - price / valuation) * 100
        : 0;

    items.push({
      id,
      uf,
      city: get(row, "Cidade"),
      district: get(row, "Bairro"),
      address: get(row, "Endereço", "Endereco"),
      description: get(row, "Descrição", "Descricao"),
      price,
      valuation,
      discount,
      finance: get(row, "Financiamento", "Aceita financiamento"),
      mode: get(row, "Modalidade de venda", "Modalidade"),
      url: get(row, "Link de acesso", "Link", "URL")
    });

    seen.add(id);
  }

  const ufs = new Set(items.map(item => item.uf)).size;

  // Proteção contra a substituição da base nacional
  // por um arquivo incompleto ou estadual.
  if (items.length < 1000 || ufs < 20) {
    throw Error(
      `Lista nacional incompleta: ${items.length} imóveis em ${ufs} UFs. ` +
      "A publicação foi cancelada."
    );
  }

  const old = new Map(
    (previous?.items || []).map(item => [item.id, item.price])
  );

  const reductions = items
    .filter(item => old.has(item.id) && old.get(item.id) > item.price)
    .map(item => [item.id, old.get(item.id)]);

  return {
    revision: crypto.randomUUID(),
    generated: generatedDate || new Date().toISOString().slice(0, 10),
    input: {
      name,
      imported: new Date().toISOString(),
      comparison: previous ? {
        name: previous.input?.name || "Lista anterior",
        generated: previous.generated,
        reductions
      } : null
    },
    items,
    ufs
  };
}

export async function onRequest({ request, env }) {
  if (!env.IMOVEIS_KV) {
    return json({
      error: "Binding IMOVEIS_KV não configurado."
    }, 503);
  }

  if (request.method === "GET") {
    try {
      const listing = await env.IMOVEIS_KV.get("lista", "json");

      if (!listing) {
        return json({
          error: "Nenhuma lista publicada ainda."
        }, 404);
      }

      const etag = `"${listing.revision}"`;

      if (request.headers.get("If-None-Match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag }
        });
      }

      return json(listing, 200, { ETag: etag });
    } catch {
      return json({ error: "Erro ao consultar a lista." }, 500);
    }
  }

  if (request.method === "PUT") {
    const token = env.ADMIN_TOKEN;
    const provided = request.headers.get("Authorization") || "";

    if (!token || provided !== `Bearer ${token}`) {
      return json({ error: "Chave administrativa inválida." }, 401);
    }

    try {
      const buffer = await request.arrayBuffer();

      if (buffer.byteLength > 15000000) {
        return json({
          error: "CSV acima do limite de 15 MB."
        }, 413);
      }

      const raw = decodeCSV(buffer);
      const previous = await env.IMOVEIS_KV.get("lista", "json");

      const name = request.headers.get("X-CSV-Name") ||
        "Lista_imoveis_geral.csv";

      const listing = convert(raw, name, previous);
      const serialized = JSON.stringify(listing);

      // O Cloudflare KV possui limite por valor.
      if (new TextEncoder().encode(serialized).byteLength > 24000000) {
        return json({
          error: "Lista processada muito grande para o armazenamento KV."
        }, 413);
      }

      await env.IMOVEIS_KV.put("lista", serialized);

      return json({
        count: listing.items.length,
        ufs: listing.ufs,
        generated: listing.generated,
        revision: listing.revision,
        unchanged: false
      });
    } catch (error) {
      return json({
        error: error.message || "Falha ao importar CSV."
      }, 400);
    }
  }

  return json({
    error: "Método não permitido."
  }, 405, { Allow: "GET, PUT" });
}
