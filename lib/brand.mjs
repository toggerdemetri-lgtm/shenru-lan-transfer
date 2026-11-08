import { readFileSync } from 'node:fs';

// The self-contained HTML entry embeds the same vector as the main application.
export const BRAND_SVG = readFileSync(new URL('../public/brand/logo.svg', import.meta.url), 'utf8').trim();
export const BRAND_FAVICON = 'data:image/svg+xml;base64,' + readFileSync(new URL('../public/favicon.svg', import.meta.url)).toString('base64');
