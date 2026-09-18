import { NextResponse } from "next/server";

import { prisma } from "@/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await prisma.$queryRaw<Array<{ server_time: Date }>>`select now() as server_time`;
    return NextResponse.json(
      {
        status: "ok",
        database: "connected",
        serverTime: rows[0]?.server_time.toISOString() ?? new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "error", database: "unavailable", message: "数据库连接不可用。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
