import { NextRequest, NextResponse } from "next/server";
import { loadConfig, saveConfig, SiteConfig } from "@/lib/config";

// GET /api/sites
export async function GET() {
  const config = loadConfig();
  return NextResponse.json({ sites: config.sites || [] });
}

// POST /api/sites
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, url, alert_emails } = body;

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

  const emails = (alert_emails || [])
    .map((e: string) => e.trim().toLowerCase())
    .filter((e: string) => e && e.includes("@"));

  const newSite: SiteConfig = {
    name: name || new URL(finalUrl).hostname.replace("www.", ""),
    url: finalUrl,
    region: "global",
    team: "default",
    sla_target: 99.9,
    check_endpoints: [{ path: "/", method: "GET", expected_status: 200 }],
    auth: null,
    tags: [],
    vitals_enabled: true,
    alert_emails: emails,
  };

  config.sites.push(newSite);
  saveConfig(config);
  return NextResponse.json({ site: newSite }, { status: 201 });
}

// PATCH /api/sites — update alert emails for a site
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { url, alert_emails } = body;

  if (!url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  const config = loadConfig();
  const site = config.sites.find((s) => s.url === url);

  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  site.alert_emails = (alert_emails || [])
    .map((e: string) => e.trim().toLowerCase())
    .filter((e: string) => e && e.includes("@"));

  saveConfig(config);
  return NextResponse.json({ site });
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
