/**
 * RX Store — minimal request router.
 *
 * IMPORTANT (audited behaviour, documented honestly):
 *   Path-mounted handler OBJECTS passed to `use('/path', routeObject)` are
 *   ACCEPTED but **never dispatched**. Only `use(fn)` middleware is executed,
 *   and the Worker entry point (`index.ts`) handles every API route inline.
 *
 *   The registrations in `index.ts` are therefore descriptive/documentational
 *   rather than functional. They are kept because they record the intended API
 *   surface, and a dev-time warning now makes the situation explicit instead of
 *   silently doing nothing.
 *
 *   `router.get/post/...` handlers DO work (used by tests/legacy paths).
 */

export type RouteHandler = (request: Request, env: any) => unknown | Promise<unknown>;
/** A route module (an object of named handlers) or a plain handler function. */
export type HandlerLike = RouteHandler | Record<string, unknown>;

let warned = false;

export class Router {
  private routes: Map<string, Map<string, RouteHandler[]>> = new Map();
  private middleware: RouteHandler[] = [];

  /**
   * `use(fn, ...moreMiddleware)` registers middleware (executed in order).
   * `use('/path', routeObject)` records the path for documentation only —
   * see the note at the top of this file.
   */
  use(pathOrMiddleware: string | HandlerLike, ...handlers: HandlerLike[]) {
    if (typeof pathOrMiddleware === 'function') {
      this.middleware.push(pathOrMiddleware as RouteHandler, ...(handlers as RouteHandler[]));
      return;
    }
    const path = String(pathOrMiddleware);
    if (!this.routes.has(path)) this.routes.set(path, new Map());
    // Be honest rather than silently ignoring the registration.
    if (handlers.length && !warned) {
      warned = true;
      console.warn(
        `[rx-store] router.use('${path}', …) mounted route objects are not dispatched; ` +
        'routes are handled inline in the Worker entry point. See backend/src/router.ts.',
      );
    }
  }

  get(path: string, ...handlers: RouteHandler[]) { this.addRoute('GET', path, handlers); }
  post(path: string, ...handlers: RouteHandler[]) { this.addRoute('POST', path, handlers); }
  put(path: string, ...handlers: RouteHandler[]) { this.addRoute('PUT', path, handlers); }
  patch(path: string, ...handlers: RouteHandler[]) { this.addRoute('PATCH', path, handlers); }
  delete(path: string, ...handlers: RouteHandler[]) { this.addRoute('DELETE', path, handlers); }

  private addRoute(method: string, path: string, handlers: RouteHandler[]) {
    if (!this.routes.has(path)) this.routes.set(path, new Map());
    this.routes.get(path)!.set(method, handlers);
  }

  async handle(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // Apply global middleware
    for (const mw of this.middleware) {
      const result = await mw(request, env);
      if (result instanceof Response) return result;
    }

    // Match route
    for (const [path, methods] of this.routes) {
      if (url.pathname.startsWith(path) && methods.has(method)) {
        const handlers = methods.get(method)!;
        for (const handler of handlers) {
          const result = await handler(request, env);
          if (result instanceof Response) return result;
          if (result) {
            return new Response(JSON.stringify({ success: true, data: result }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
