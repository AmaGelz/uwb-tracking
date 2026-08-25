const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const STORAGE_ROOT = `${SUPABASE_URL}/storage/v1/object/public/site`;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function requestedPath(req: Request): string | null {
  const url = new URL(req.url);
  let path = decodeURIComponent(url.pathname);
  if (path.startsWith("/functions/v1/site")) {
    path = path.slice("/functions/v1/site".length);
  } else if (path.startsWith("/site/")) {
    path = path.slice("/site".length);
  }
  path = path.replace(/^\/+/, "") || "index.html";
  if (path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(path)) return null;
  const top = path.split("/", 1)[0];
  if (!["index.html", "login.html", "dashboard.html", "plan-editor.html", "css", "js", "assets"].includes(top)) return null;
  return path;
}

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index).toLowerCase() : "";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const path = requestedPath(req);
  if (!path) return new Response("Not found", { status: 404 });

  const upstream = await fetch(`${STORAGE_ROOT}/${path}`, { method: req.method });
  if (!upstream.ok) return new Response("Not found", { status: upstream.status === 404 ? 404 : 502 });

  const isDocument = extension(path) === ".html";
  return new Response(req.method === "HEAD" ? null : upstream.body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[extension(path)] || "application/octet-stream",
      "Cache-Control": isDocument || path === "js/runtime-config.js"
        ? "no-cache"
        : "public, max-age=3600",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
});
