import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { registrationImportTemplate } from "@/server/services/registration-import-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const template = await registrationImportTemplate(user.id, slug);
    return new Response(template.body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${template.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, { route: "GET /api/admin/tournaments/[slug]/imports/template" });
  }
}
