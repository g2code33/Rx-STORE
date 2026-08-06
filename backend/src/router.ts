export class Router {
  private routes: Map<string, Map<string, Function[]>> = new Map();
  private middleware: Function[] = [];

  use(pathOrMiddleware: string | Function, ...handlers: Function[]) {
    if (typeof pathOrMiddleware === 'function') {
      this.middleware.push(pathOrMiddleware, ...handlers);
    } else {
      const path = pathOrMiddleware;
      if (!this.routes.has(path)) {
        this.routes.set(path, new Map());
      }
    }
  }

  get(path: string, ...handlers: Function[]) { this.addRoute('GET', path, handlers); }
  post(path: string, ...handlers: Function[]) { this.addRoute('POST', path, handlers); }
  put(path: string, ...handlers: Function[]) { this.addRoute('PUT', path, handlers); }
  patch(path: string, ...handlers: Function[]) { this.addRoute('PATCH', path, handlers); }
  delete(path: string, ...handlers: Function[]) { this.addRoute('DELETE', path, handlers); }

  private addRoute(method: string, path: string, handlers: Function[]) {
    if (!this.routes.has(path)) {
      this.routes.set(path, new Map());
    }
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
