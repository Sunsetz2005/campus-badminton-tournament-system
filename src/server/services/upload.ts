import { IMPORT_LIMITS } from "@/domain/registration/import-plan";
import { AppError } from "@/server/services/errors";

/** 读取 multipart 中的导入文件；先按声明大小拒绝，避免把超大文件整个读进内存。 */
export async function readImportUpload(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > IMPORT_LIMITS.maxBytes + 64 * 1024) {
    throw new AppError(413, "import_too_large", `导入文件超过 ${IMPORT_LIMITS.maxBytes / 1024} KiB 上限。`);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError(400, "invalid_upload", "上传格式无效。");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError(400, "import_missing", "请选择要导入的 CSV 文件。");
  if (file.size > IMPORT_LIMITS.maxBytes) {
    throw new AppError(413, "import_too_large", `导入文件超过 ${IMPORT_LIMITS.maxBytes / 1024} KiB 上限。`);
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), form };
}
