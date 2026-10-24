import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = {
  "/": ["index.html", "text/html"],
  "/main.js": ["main.js", "text/javascript"],
};
const server = createServer(async (req, res) => {
  const route = routes[req.url];
  if (req.method !== "GET" || !route) {
    res.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL(`./public/${route[0]}`, import.meta.url));
    res
      .writeHead(200, {
        "Content-Type": `${route[1]}; charset=utf-8`,
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      })
      .end(content);
  } catch {
    res.writeHead(500).end("Build the example first.");
  }
});
server.listen(3203, "127.0.0.1", () => console.log("Open http://127.0.0.1:3203"));
