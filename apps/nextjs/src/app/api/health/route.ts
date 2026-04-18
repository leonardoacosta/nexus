export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    version:
      process.env.NEXUS_VERSION ??
      process.env.npm_package_version ??
      "unknown",
    timestamp: new Date().toISOString(),
  });
}
