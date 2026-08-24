import { NextResponse } from "next/server";
import { prepareProgressionWorkflow } from "@/lib/progression/prepare";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.workflowId || !["assessment", "interview"].includes(body?.kind)) {
      return NextResponse.json({ error: "kind and workflowId are required" }, { status: 400 });
    }
    const result = await prepareProgressionWorkflow(body.kind, body.workflowId);
    return NextResponse.json({ ok: true, result });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Preparation failed" }, { status: 500 });
  }
}
