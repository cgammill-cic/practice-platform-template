// Wrangler's default module rules import *.html as a Text module (the file's contents as a string).
// Declared here so TypeScript knows the shape; used by src/pricing.ts for the calculator page.
declare module "*.html" {
  const content: string;
  export default content;
}

// AsyncLocalStorage (auth.ts) comes from the Workers runtime under the nodejs_als compatibility flag.
// Declared minimally because the project deliberately carries no @types/node.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
