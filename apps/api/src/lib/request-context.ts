import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId?: string;
  userId?: string;
  userName?: string;
  ip?: string;
}

export const requestStore = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext {
  return requestStore.getStore() ?? {};
}

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T> | T): Promise<T> | T {
  return requestStore.run(ctx, fn);
}
