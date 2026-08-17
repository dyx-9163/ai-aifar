export {};

declare global {
  interface Window {
    desktop: {
      health(): Promise<{ ok: true; version: string }>;
    };
  }
}
