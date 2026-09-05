export function app(req: Request): Promise<Response> {
  return new Response(JSON.stringify({ error: "routes not wired yet" }), {
    status: 501,
    headers: { "content-type": "application/json" },
  });
}
