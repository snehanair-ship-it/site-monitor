import { NextRequest, NextResponse } from "next/server";
import { loadConfig, saveConfig, SiteConfig } from "@/lib/config";

// GET /api/sites
export async function GET() {
  const config = loadConfig();
  return NextResponse.json({ sites: config.sites || [] });
}

// POST /api/sites — just name + url needed
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, url } = body;

  if (!url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  let finalUrl = url;
  if (!finalUrl.startsWith("http")) finalUrl = `https://${finalUrl}`;

  try { new URL(finalUrl); } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const config = loadConfig();

  if (config.sites.some((s) => s.url === finalUrl)) {
    return NextResponse.json({ error: "Already monitoring this URL" }, { status: 409 });
  }

  const friendlyName = name || new URL(finalUrl).hostname.replace("www.", "");

  const newSite: SiteConfig = {
    name: friendlyName,
    url: finalUrl,
    region: "global",
    team: "default",
    sla_target: 99.9,
    check_endpoints: [{ path: "/", method: "GET", expected_status: 200 }],
    auth: null,
    tags: [],
    vitals_enabled: true,
  };

  config.sites.push(newSite);
  saveConfig(config);
  return NextResponse.json({ site: newSite }, { status: 201 });
}

// DELETE /api/sites
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { url } = body;

  if (!url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  const config = loadConfig();
  const index = config.sites.findIndex((s) => s.url === url);

  if (index === -1) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  config.sites.splice(index, 1);
  saveConfig(config);
  return NextResponse.json({ success: true });
}
