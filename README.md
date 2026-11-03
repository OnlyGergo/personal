# liquid-hello

The "hello" page (teal/blue breathing blobs, random multilingual greetings every 2–4 s)
with the liquid-metal morph as the word transition. Astro + TypeScript, no UI framework.

## AI Disclaimer
Adapted by AI to add liquid metal effect

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # static output in dist/
npm run check     # typecheck
```

## Layout
- `src/config.ts` – every tunable: metal params, colours, word list, timings, drift.
- `src/lib/liquid.ts` – the WebGL pipeline: text canvas → threshold (goo) → separable
  blur (edge field) → metal shader. Exports `startLiquid(canvas)`, which returns a cleanup fn.
- `src/components/LiquidHello.astro` – markup, CSS blobs (colours/opacity fed from
  `config.ts` via `define:vars`), and the client script that starts the loop.
- `src/pages/index.astro` – the page.

Font is Raleway 900 via `@fontsource/raleway` (self-hosted, bundled by Vite).

Set `motion.drift` to 0 for the pure in-place morph.
