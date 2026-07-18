import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the Netlify functions from Vite's dev server, so `npm run dev`
 * exercises the exact handler files that ship to production.
 *
 * Netlify itself reads the routes from each function's `export const config`;
 * this mirrors that mapping for local dev. `netlify dev` would do this for us,
 * but the CLI is a heavy dependency to require for a two-route API.
 */
const ROUTES: Record<string, string> = {
  '/api/access-status': '/netlify/functions/access-status.mjs',
  '/api/check-in': '/netlify/functions/check-in.mjs',
};

/** Node's IncomingMessage -> a Web Request, the shape the handlers expect. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }

  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function send(response: Response, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function netlifyFunctionsDev(): Plugin {
  return {
    name: 'netlify-functions-dev',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const modulePath = ROUTES[path];
        if (!modulePath) return next();

        void (async () => {
          try {
            // ssrLoadModule re-reads on change, so edits to a handler take
            // effect without restarting the dev server.
            const mod = await server.ssrLoadModule(modulePath);
            const request = await toRequest(req);
            // Netlify populates context.ip in production. Honour a forwarded
            // header here so per-IP behaviour (the rate limiter) is testable
            // locally instead of every caller sharing one bucket.
            const forwarded = req.headers['x-forwarded-for'];
            const ip =
              (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
              req.socket.remoteAddress ||
              '127.0.0.1';
            const response = await mod.default(request, { ip });
            await send(response, res);
          } catch (err) {
            server.config.logger.error(`[netlify-dev] ${path} failed: ${err}`);
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'dev_handler_error', message: String(err) }));
          }
        })();
      });
    },
  };
}
