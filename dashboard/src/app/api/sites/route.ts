import { NextRequest, NextResponse } from "next/server";
import { loadConfig, saveConfig, SiteConfig } from "@/lib/config";

// GET /api/sites — list all sites
export async function GET() {
  const config = loadConfig();
  return NextResponse.json({ sites: config.sites || [], teams: config.teams || {} });
}

// POST /api/sites — add a new site
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, url, team, region, sla_target, tags, vitals_enabled } = body;

  if (!name || !url) {
    return NextResponse.json({ error: "Name and URL are required" }, { status: 400 });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const config = loadConfig();

  // Check if URL already exists
  if (config.sites.some((s) => s.url === url)) {
    return NextResponse.json({ error: "Site already exists" }, { status: 409 });
  }

  const newSite: SiteConfig = {
    name,
    url,
    region: region || "global",
    team: team || "default",
    sla_target: sla_target || 99.9,
    check_endpoints: [{ path: "/", method: "GET", expected_status: 200 }],
    auth: null,
    tags: tags || [],
    vitals_enabled: vitals_enabled !== false,
  };

  config.sites.push(newSite);

  // Auto-create team if it doesn't exist
  const teamId = (team || "default").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!config.teams[teamId]) {
    config.teams[teamId] = {
      name: team || "Default",
      members: [],
      slack_webhook: "",
      escalation: {
        level_1_after_minutes: 0,
        level_2_after_minutes: 10,
        level_3_after_minutes: 30,
      },
    };
  }

  // Update the site's team reference to the normalized ID
  newSite.team = teamId;

  saveConfig(config);
  return NextResponse.json({ site: newSite }, { status: 201 });
}

// DELETE /api/sites — remove a site
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
