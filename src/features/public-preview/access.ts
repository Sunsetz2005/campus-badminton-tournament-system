export function isPublicUiPreviewEnabled(
  environment: { ENABLE_PUBLIC_UI_PREVIEW?: string; NODE_ENV?: string } = process.env,
) {
  return environment.NODE_ENV !== "production" && environment.ENABLE_PUBLIC_UI_PREVIEW === "true";
}
