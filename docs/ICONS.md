# Icon family

All icons live in `src/client/icons/index.tsx` as React components built with `defineIcon(name, paths)`. Run `npm run dev` and open **`/_dev/icons`** to see every icon at 16/20/24/40 px on cream, charcoal and peach (development builds only).

## Rules

1. **Grid:** 24×24 viewBox with about 2 px optical padding.
2. **Stroke:** 1.75 px, round caps and joins, no fills (the brand mark is the only filled shape).
3. **Simplicity:** must read at 16 px. Prefer 2–4 paths.
4. **Two-tone:** at most one meaningful sub-part is marked `accent: true`: the arrow of upload/download, the check of "completed", the hands of the clock, the slash of "cancel". It is painted with `--icon-accent`. Never accent the whole glyph.
   - Neutral contexts set `--icon-accent` to tangerine (`--accent-ink` on light surfaces for contrast).
   - Buttons set it to `currentColor`, so icons are monochrome on coloured buttons.
5. **Signature:** `SendIcon` is an outline of the brand plane, not a generic glyph.
6. **Accessibility:** icons are `aria-hidden` by default. Pass `title` when an icon carries meaning on its own; icon-only buttons need an `aria-label`.

## Inventory

send · receive · upload · download · add-files · remove · close · folder · document · image · video · audio · archive · qr · copy-qr · download-qr · link · copy · share · devices · phone · laptop · connection · relay · security · lock · progress · completed · check · error · retry · cancel · settings · clock · expiration · delete-share · arrow-left · arrow-right · chevron-down · sun · moon · globe · info

## Adding an icon

```tsx
export const ExampleIcon = defineIcon('example', [
  { d: 'M4 6h16v12H4Z' }, // base, currentColor
  { d: 'M8 12h8', accent: true }, // the one meaningful accent
]);
```

Register it in `ICONS` so it appears in the gallery, and check it there on all three surfaces.
