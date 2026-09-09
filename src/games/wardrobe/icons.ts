import type { ClothType } from "./logic.js";

function svg(inner: string): string {
  return `<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** Clothing glyphs in the house stroke style; tile colors come from CSS. */
export const CLOTH_ICONS: Record<ClothType, string> = {
  shirt: svg(
    `<path d="M96,48 L56,76 L78,116 L94,108 L94,208 L162,208 L162,108 L178,116 L200,76 L160,48 C150,66 106,66 96,48 Z" />`,
  ),
  shoe: svg(
    `<path d="M48,168 L48,112 L92,112 L124,142 L188,156 C200,159 200,176 188,176 L48,176 Z" /><path d="M92,118 L122,146" />`,
  ),
  pant: svg(
    `<path d="M92,40 L164,40 L172,216 L134,216 L128,128 L122,216 L84,216 Z" /><path d="M90,66 L166,66" />`,
  ),
  bag: svg(
    `<path d="M84,104 L172,104 L164,208 L92,208 Z" /><path d="M104,104 C104,64 152,64 152,104" />`,
  ),
};
