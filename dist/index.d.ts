export interface InitOptions {
  /** Open the panel immediately instead of waiting for the launcher click. */
  defaultOpen?: boolean;
}

/**
 * Mount Linear Grab into the current page (dev builds only).
 *
 * @example
 * if (import.meta.env.DEV) {
 *   import('linear-grab').then(({ init }) => init());
 * }
 */
export declare function init(options?: InitOptions): void;
