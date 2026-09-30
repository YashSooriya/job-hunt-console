import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function GET() {
  try {
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("get_chatgpt_bridge_status");
    if (error) throw error;
    const payload = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const devices = Array.isArray(payload.devices) ? payload.devices : [];
    const preferred = devices.find((device) => device && typeof device === "object" && (device as Record<string, unknown>).preferred === true)
      || devices[0];
    const preferredRecord = preferred && typeof preferred === "object" && !Array.isArray(preferred)
      ? preferred as Record<string, unknown>
      : {};
    const capabilities = preferredRecord.capabilities && typeof preferredRecord.capabilities === "object" && !Array.isArray(preferredRecord.capabilities)
      ? preferredRecord.capabilities as Record<string, unknown>
      : {};
    return NextResponse.json({
      ok: true,
      ...payload,
      server_capabilities: payload.server_capabilities && typeof payload.server_capabilities === "object" ? payload.server_capabilities : {},
      bridge: {
        serverDeviceId: typeof preferredRecord.id === "string" ? preferredRecord.id : null,
        extensionVersion: typeof preferredRecord.extension_version === "string" ? preferredRecord.extension_version : null,
        extensionBuildId: typeof capabilities.build_id === "string" ? capabilities.build_id : null,
        online: preferredRecord.online === true,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read ChatGPT bridge status." }, { status: statusCode(error) });
  }
}
