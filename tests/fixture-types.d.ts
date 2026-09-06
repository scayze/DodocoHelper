declare module "pngjs" {
  export function sync(mode?: unknown): unknown;
  export class PNG {
    static sync: {
      read(data: Buffer | Uint8Array): { data: Uint8Array; width: number; height: number };
    };
    width: number;
    height: number;
    data: Uint8Array;
    constructor(opts?: unknown);
  }
}

declare module "jpeg-js" {
  export function decode(data: Buffer | Uint8Array, opts?: unknown): {
    data: Uint8Array;
    width: number;
    height: number;
  };
}