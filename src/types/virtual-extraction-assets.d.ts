/**
 * Type declaration for the build-time virtual module produced by the
 * `extraction-assets` esbuild plugin (see esbuild.config.mjs). Jest supplies
 * an equivalent fixture via moduleNameMapper; without this declaration
 * neither `tsc --noEmit` nor ts-jest can resolve the import.
 */
declare module 'virtual:extraction-assets' {
  /** Embedded Python sources, keyed by path relative to `extraction/`. */
  export const EXTRACTION_ASSETS: Record<string, string>;
  /** Content hash of the embedded sources, used as the on-disk version marker. */
  export const EXTRACTION_ASSETS_VERSION: string;
}
