import { NextRequest, NextResponse } from "next/server";
import https from "https";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url param required" }, { status: 400 });

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return NextResponse.json({ ssl: false, reason: "Not HTTPS" });
    }

    const cert = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const r = https.request(
        { hostname: parsed.hostname, port: 443, method: "HEAD", rejectUnauthorized: false, timeout: 10000 },
        (res) => {
          const c = (res.socket as import("tls").TLSSocket).getPeerCertificate();
          if (!c || !c.valid_to) return resolve({ ssl: true, error: "No cert info" });

          const validFrom = new Date(c.valid_from);
          const validTo = new Date(c.valid_to);
          const days = Math.floor((validTo.getTime() - Date.now()) / 86400000);

          resolve({
            ssl: true,
            valid: Date.now() >= validFrom.getTime() && Date.now() <= validTo.getTime(),
            issuer: c.issuer?.O || c.issuer?.CN || "Unknown",
            validFrom: validFrom.toISOString(),
            validTo: validTo.toISOString(),
            daysRemaining: days,
          });
        }
      );
      r.on("error", (e) => reject(e));
      r.on("timeout", () => { r.destroy(); reject(new Error("Timeout")); });
      r.end();
    });

    return NextResponse.json(cert);
  } catch (err) {
    return NextResponse.json({ ssl: false, error: String(err) });
  }
}
