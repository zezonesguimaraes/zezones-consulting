import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PUBLIC_SITE_URL = "https://www.zezonesconsulting.com.br";
const CATALOG_OWNER_ID = "f986ddd6-a487-47f4-9adf-bc975a764a5e";

const headers = {
  "Content-Type": "text/csv; charset=utf-8",
  "Cache-Control": "public, max-age=60, s-maxage=300",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};

function csvCell(value: unknown): string {
  // Feed descriptions must stay on one physical CSV line for robust importer compatibility.
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

function money(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? `${amount.toFixed(2)} BRL` : "";
}

function vehicleTitle(v: Record<string, unknown>): string {
  const name = [v.marca, v.modelo, v.versao, v.ano_modelo || v.ano_fabricacao]
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== "")
    .join(" ");
  return name.slice(0, 200);
}

function vehicleDescription(v: Record<string, unknown>): string {
  const parts: string[] = [];
  const title = vehicleTitle(v);
  if (title) parts.push(title);

  const specs: Array<[string, unknown]> = [
    ["Ano", v.ano_modelo || v.ano_fabricacao],
    ["Quilometragem", v.quilometragem !== null && v.quilometragem !== undefined
      ? `${Number(v.quilometragem).toLocaleString("pt-BR")} km`
      : null],
    ["Combustível", v.combustivel],
    ["Câmbio", v.cambio],
    ["Cor", v.cor],
  ];
  for (const [label, value] of specs) {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      parts.push(`${label}: ${value}`);
    }
  }

  if (v.destaque && String(v.destaque).trim()) parts.push(String(v.destaque).trim());
  if (v.descricao && String(v.descricao).trim()) parts.push(String(v.descricao).trim());
  return parts.join(" | ").slice(0, 5000);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("Feed configuration unavailable", {
      status: 500,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: vehicles, error: vehicleError } = await admin
      .from("veiculos")
      .select("id,marca,modelo,versao,ano_fabricacao,ano_modelo,quilometragem,preco,combustivel,cambio,cor,descricao,destaque,status,user_id")
      .eq("user_id", CATALOG_OWNER_ID)
      .eq("status", "ativo")
      .order("created_at", { ascending: false });

    if (vehicleError) throw vehicleError;

    const ids = (vehicles ?? []).map((v) => v.id);
    let photos: Array<{ veiculo_id: string; url: string; ordem: number | null; destaque: boolean | null }> = [];
    if (ids.length) {
      const { data, error } = await admin
        .from("veiculo_fotos")
        .select("veiculo_id,url,ordem,destaque")
        .in("veiculo_id", ids)
        .order("ordem", { ascending: true });
      if (error) throw error;
      photos = data ?? [];
    }

    const photosByVehicle = new Map<string, typeof photos>();
    for (const photo of photos) {
      if (!photo.url || !/^https?:\/\//i.test(photo.url)) continue;
      const list = photosByVehicle.get(photo.veiculo_id) ?? [];
      list.push(photo);
      photosByVehicle.set(photo.veiculo_id, list);
    }

    const columns = [
      "id",
      "title",
      "description",
      "availability",
      "condition",
      "price",
      "link",
      "image_link",
      "additional_image_link",
      "brand",
      "color",
      "product_type",
    ];

    const rows = [columns.join(",")];
    for (const v of vehicles ?? []) {
      const gallery = (photosByVehicle.get(v.id) ?? [])
        .slice()
        .sort((a, b) => Number(b.destaque) - Number(a.destaque) || (a.ordem ?? 0) - (b.ordem ?? 0));
      const mainImage = gallery[0]?.url;
      const price = money(v.preco);
      const title = vehicleTitle(v);
      if (!mainImage || !title || !price) continue;

      const detailUrl = `${PUBLIC_SITE_URL}/?veiculo=${encodeURIComponent(v.id)}`;
      const additionalImages = gallery.slice(1).map((p) => p.url).join(", ");
      rows.push(csvRow([
        v.id,
        title,
        vehicleDescription(v),
        "in stock",
        "used",
        price,
        detailUrl,
        mainImage,
        additionalImages,
        v.marca,
        v.cor ?? "",
        "Vehicles > Cars",
      ]));
    }

    return new Response(`\uFEFF${rows.join("\r\n")}\r\n`, {
      status: 200,
      headers: {
        ...headers,
        "Content-Disposition": 'inline; filename="zezones-meta-vehicle-feed.csv"',
      },
    });
  } catch (_error) {
    return new Response("Unable to generate vehicle feed", {
      status: 500,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});
