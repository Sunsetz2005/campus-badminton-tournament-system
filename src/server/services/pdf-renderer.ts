import { chromium } from "playwright-core";

import { AppError } from "@/server/services/errors";

/**
 * 服务端 PDF 渲染：用无头 Chromium 把**内部生成的** HTML 字符串打印成 PDF。
 *
 * - 只接受 HTML 字符串（`setContent`），从不打开任何 URL；
 * - 禁用 JavaScript，拦截页面发出的一切网络请求（字体只用系统已安装的），避免服务端任意访问；
 * - 同一进程内串行渲染，限制内存与 CPU 占用；每次渲染都有超时。
 *
 * Chromium 可执行文件：默认使用 playwright-core 自带的下载位置（本机开发），
 * 部署环境通过 `REPORT_PDF_CHROMIUM_PATH` 指向系统安装的 Chromium，并安装开源中文字体（如 Noto Sans CJK）。
 * 容器内以 root 运行且未配置沙箱时，可设 `REPORT_PDF_NO_SANDBOX=1`（渲染内容仍只来自内部模板）。
 */

const RENDER_TIMEOUT_MS = 60_000;
let queue: Promise<unknown> = Promise.resolve();

export interface PdfInspection {
  pageCount: number;
  bytes: number;
}

/** 生成后自检：确实是完整 PDF 且至少有一页。只检查返回成功不够。 */
export function inspectPdf(bytes: Buffer): PdfInspection {
  const head = bytes.subarray(0, 5).toString("latin1");
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1");
  if (head !== "%PDF-" || !tail.includes("%%EOF")) throw new AppError(500, "pdf_invalid", "PDF 生成结果不完整，已放弃存档，请重试。");
  const text = bytes.toString("latin1");
  const pageCount = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  if (pageCount < 1) throw new AppError(500, "pdf_invalid", "PDF 生成结果没有任何页面，已放弃存档。");
  return { pageCount, bytes: bytes.length };
}

async function renderOnce(html: string, footerTemplate: string): Promise<Buffer> {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.REPORT_PDF_CHROMIUM_PATH || undefined,
      args: process.env.REPORT_PDF_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
      timeout: 30_000,
    });
  } catch {
    throw new AppError(503, "pdf_engine_unavailable", "服务器没有可用的 PDF 渲染引擎（Chromium），暂时不能生成 PDF；可先使用打印网页或 Excel。");
  }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate,
      tagged: true,
      outline: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** 串行渲染：同一时刻只运行一个 Chromium。 */
export function renderPdf(html: string, footerTemplate: string): Promise<Buffer> {
  const run = () => renderOnce(html, footerTemplate);
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
