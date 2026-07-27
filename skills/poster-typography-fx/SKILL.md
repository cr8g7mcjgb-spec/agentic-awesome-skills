---
name: poster-typography-fx
description: "Recreate trend poster typography — inflated 3D jelly type, liquid chrome, grainy gradient maps, and bitmap halftone — with pure SVG filters and canvas, no Photoshop or Illustrator."
category: design
risk: safe
source: self
source_type: self
date_added: "2026-07-27"
author: sickn33
tags: [typography, svg-filters, poster, halftone, gradient-map, canvas, generative]
tools: [claude, cursor, gemini]
---

# Poster Typography FX

## Overview

Four production-ready generators that reproduce the poster typography styles that fill
Pinterest and Behance moodboards — puffy inflated 3D lettering, melted liquid chrome,
trippy grain-mapped gradients, and Illustrator-style bitmap halftone — using nothing but
SVG filter primitives and a canvas sampling pass. No Photoshop, no Illustrator, no 3D
software, no external libraries or fonts.

Each generator is a single self-contained HTML file with a live control panel and PNG/SVG
export. The point is that the **material is separated from the content**: swap the word,
swap the shape, keep the exact texture. Changing the cherry in the halftone poster to an
apple is a one-line change to a path — the dot screen, angle, contrast, and colour stay
byte-identical.

## When to Use This Skill

- Use when the user shares a reference poster or screenshot and asks to reproduce its
  typographic treatment ("이거랑 똑같이 만들어줘", "recreate this poster style")
- Use when you need inflated / jelly / balloon / 3D-looking type without a 3D renderer
- Use when you need chrome, liquid metal, or Y2K melted lettering
- Use when you need grainy gradient backgrounds, gradient maps, or noise-textured posters
- Use when you need halftone, bitmap dithering, or riso-print dot screens as **vectors**
- Use when a design must stay editable and resolution-independent rather than being a
  flattened raster export

## How It Works

### Step 1: Pick the template that matches the reference

| Reference look | File | Core technique |
| --- | --- | --- |
| Puffy jelly / balloon / inflated type | `templates/inflate-type.html` | `feSpecularLighting` + `feDiffuseLighting` over a thresholded blur |
| Liquid chrome, melted metal, Y2K | `templates/chrome-liquid.html` | banded `feComponentTransfer` ramp + `feDisplacementMap` |
| Trippy gradient, grain, aura blobs | `templates/grain-gradient.html` | gradient map via lookup tables + `feTurbulence` grain |
| Bitmap halftone, dot screen, riso | `templates/halftone-bitmap.html` | canvas luminance sampling → vector dot path |

Open the file in any browser. No build step, no server, no dependencies.

### Step 2: Understand the inflate pipeline

Every "3D" look here comes from one idea: **an alpha channel is a height map**. Blur the
glyph, hard-threshold it into a fat rounded silhouette, blur that again, then hand it to
the SVG lighting primitives as a bump map.

```xml
<filter id="inflate" color-interpolation-filters="sRGB">
  <!-- 1. soft field from the glyph -->
  <feGaussianBlur in="SourceAlpha" stdDeviation="15" result="b1"/>

  <!-- 2. hard threshold => fat, rounded, merged silhouette.
          slope 24 / intercept -24*t cuts at brightness t with a ~4% soft edge -->
  <feComponentTransfer in="b1" result="solid">
    <feFuncA type="linear" slope="24" intercept="-9.36"/>
  </feComponentTransfer>

  <!-- 3. re-blur the silhouette => the dome that the lights will read -->
  <feGaussianBlur in="solid" stdDeviation="9" result="height"/>

  <!-- 4. flat body colour, clipped to the silhouette -->
  <feFlood flood-color="#ee4f9b" result="paint"/>
  <feComposite in="paint" in2="solid" operator="in" result="body"/>

  <!-- 5. volume shading, multiplied under the body -->
  <feDiffuseLighting in="height" surfaceScale="9" diffuseConstant="1"
                     lighting-color="#ffd7ec" result="dRaw">
    <feDistantLight azimuth="230" elevation="52"/>
  </feDiffuseLighting>
  <feComposite in="dRaw" in2="solid" operator="in" result="dClip"/>
  <feBlend in="body" in2="dClip" mode="multiply" result="shaded"/>

  <!-- 6. the gloss: screen a specular pass on top -->
  <feSpecularLighting in="height" surfaceScale="9" specularConstant="1.75"
                      specularExponent="22" lighting-color="#fff" result="sRaw">
    <fePointLight x="340" y="280" z="300"/>
  </feSpecularLighting>
  <feComposite in="sRaw" in2="solid" operator="in" result="sClip"/>
  <feBlend in="shaded" in2="sClip" mode="screen"/>
</filter>
```

Two details make or break it:

- `color-interpolation-filters="sRGB"` — without it the browser lights in linearRGB and
  everything looks washed out and plasticky in the wrong way.
- The threshold in step 2 must sit **below 0.5** (around 0.38–0.44) so the silhouette grows
  rather than shrinks. That growth is what fuses neighbouring letters into one blob.

Fat rounded letterforms come from stroking the text with its own fill colour and
`paint-order: stroke fill`, so any installed font works — no need for a heavy display face:

```xml
<text stroke="#ee4f9b" fill="#ee4f9b" stroke-width="26"
      stroke-linejoin="round" paint-order="stroke fill">POP?</text>
```

### Step 3: Understand the chrome ramp

Chrome is the inflate pipeline with the shading replaced by an **oscillating transfer
table**. A monotonic light response becomes alternating light/dark bands — which is exactly
what a mirrored surface reflecting a room looks like.

```js
function rampTable(stops, waves, contrast, phase){
  const out = [];
  for (let i = 0; i < stops; i++){
    const t = i / (stops - 1);
    let v = 0.5 + 0.5 * Math.cos((t * waves + phase) * Math.PI * 2);
    v = 0.5 + (v - 0.5) * contrast;
    out.push(Math.max(0, Math.min(1, v)).toFixed(3));
  }
  return out.join(" ");
}
// feFuncR/G/B tableValues, each with a slightly different phase => metallic colour split
```

For the bands to sweep across the letter body — not just hug its edges — the height map
must be blurred *hard* (`stdDeviation` around 40 at a 300px cap height). A small blur
leaves a flat plateau inside the glyph and the metal reads as a flat fill with a chrome rim.

### Step 4: Understand the gradient map

A gradient map is a per-channel lookup table. Desaturate, then remap brightness onto a
colour ramp. Repeating the ramp more than once over the 0–1 range is what produces the
concentric rings in aura/trippy gradient posters.

```xml
<feColorMatrix type="saturate" values="0" result="lum"/>
<feComponentTransfer in="lum">
  <feFuncR type="table" tableValues="0.04 0.36 1.00 1.00 0.95 ..."/>
  <feFuncG type="table" tableValues="0.02 0.10 0.18 0.54 0.94 ..."/>
  <feFuncB type="table" tableValues="0.06 0.37 0.56 0.12 0.72 ..."/>
</feComponentTransfer>
```

Grain needs two layers. `mix-blend-mode: overlay` only bites in the midtones, so a dark
poster looks clean where the reference is speckled; add a second `feTurbulence` rect in
`screen` mode at roughly a quarter of the opacity to bring grain into the shadows.

### Step 5: Understand the halftone screen

Halftone is not a filter — it is a resampling. Draw the artwork into an offscreen canvas
in greyscale, walk a rotated grid, and emit one dot per cell sized by local darkness.
Output as a single SVG `path` so the result stays vector.

```js
const cos = Math.cos(angle), sin = Math.sin(angle);
for (let v = -reach; v <= reach; v++)
  for (let u = -reach; u <= reach; u++){
    const x = cx + (u * cos - v * sin) * cell;
    const y = cy + (u * sin + v * cos) * cell;
    const o = (Math.round(y) * W + Math.round(x)) * 4;
    const lum = (px[o] * 0.299 + px[o+1] * 0.587 + px[o+2] * 0.114) / 255;
    // area must track density, so the radius takes a square root
    const r = Math.sqrt(1 - lum) * cell * 0.55;
    d += `M${x-r} ${y}a${r} ${r} 0 1 0 ${2*r} 0a${r} ${r} 0 1 0 ${-2*r} 0`;
  }
```

Dot size varies only if the source varies. Fill the artwork with a gradient before
screening it — a flat black shape screens to a uniform grid of identical dots.

### Step 6: Swap the content, keep the material

This is the whole point of the split. In `halftone-bitmap.html` every shape is a list of
path ops in a 100×100 box:

```js
const SHAPES = {
  cherry: [
    { d:"M54 20 C 42 38, 32 52, 30 62", w:4 },                       // stem, stroked
    { d:"M30 62 m -20 0 a 20 20 0 1 0 40 0 a 20 20 0 1 0 -40 0", fill:true }
  ],
  apple: [
    { d:"M50 30 C 40 16, 16 18, 12 40 C 8 62, 24 88, 38 93 ... Z", fill:true },
    { d:"M50 30 C 50 18, 53 10, 58 4", w:4 }
  ]
};
```

Add a key, pick it in the dropdown, and the dot screen, angle, contrast, gradient, colours
and layout are untouched. Same idea in the other three: the filter never sees what the
glyph or shape actually is, only its alpha.

## Examples

### Example 1: Reproduce a reference poster with different wording

```js
// inflate-type.html — the "POP?" treatment carrying your own word
applyPreset({
  ...PRESETS.pop,
  txt: "WOW!",
  c1: "#ee4f9b",     // 본체 색은 그대로
  bg1: "#82e05a"     // 배경도 그대로 => 질감 동일, 내용만 교체
});
```

### Example 2: Swap the halftone subject from cherry to apple

```js
// halftone-bitmap.html
SHAPES.pineapple = [
  { d:"M50 34 C 26 34, 18 56, 22 74 C 26 92, 74 92, 78 74 C 82 56, 74 34, 50 34 Z", fill:true },
  { d:"M50 34 C 44 18, 34 8, 30 2", w:4 },
  { d:"M50 34 C 56 18, 66 8, 70 2", w:4 }
];
// 드롭다운에 <option value="pineapple"> 한 줄만 추가하면 끝.
// cell / ang / dot / con 은 손대지 않는다 — 그래야 질감이 원본과 같다.
```

### Example 3: Use just the inflate filter inside an existing page

```html
<svg width="0" height="0"><defs>
  <filter id="puff" x="-30%" y="-30%" width="160%" height="160%"
          color-interpolation-filters="sRGB"> <!-- 위 Step 2 의 필터 본문 --> </filter>
</defs></svg>

<h1 style="filter:url(#puff); -webkit-text-stroke:20px currentColor;">SALE</h1>
```

## Best Practices

- ✅ Set `color-interpolation-filters="sRGB"` on every lighting filter
- ✅ Scale filter radii with the rendered font size, so a 600px headline and a 200px
  subhead get the same material rather than the same pixel counts
- ✅ Keep the threshold in the inflate pipeline between 0.36 and 0.46
- ✅ Fill shapes with a gradient *before* halftoning, otherwise every dot is the same size
- ✅ Export SVG when the piece will be printed or scaled; export PNG for social
- ❌ Don't chain a large `feDisplacementMap` straight into a lighting primitive — polish it
  with a small blur first or the metal looks corroded
- ❌ Don't rely on a font being installed; stroke-fatten instead of trusting `font-weight: 900`
- ❌ Don't put a huge blur on the full-page grain rect — filter cost scales with area

## Limitations

- Reproduces the *technique*, not a specific artist's file. Reference posters are matched
  by construction (lighting model, ramp, screen), not pixel-for-pixel, and the exact
  letterforms depend on which fonts are installed on the viewing machine.
- Photographic references — real inflatable balloons in a subway car, physical prints,
  studio-lit objects — can only be approximated. The template gives the material, not the
  photograph.
- SVG filter rendering differs slightly between Chromium, Firefox, and WebKit, most
  visibly in `feSpecularLighting` falloff. Verify in the target browser before shipping.
- Large filter regions on full-page elements are expensive; on low-end mobile a 1080×1920
  grain layer plus a lighting chain can drop frames during slider drags.
- The halftone pass rasterises to sample. Source resolution is fixed at the poster size,
  so extremely small dot cells (< 5px) alias.
- This skill does not replace environment-specific validation, testing, or expert review.
- Stop and ask for clarification if required inputs, permissions, or safety boundaries are missing.

## Security & Safety Notes

- All four templates are static local HTML. They make no network requests, load no remote
  fonts or scripts, and write nothing outside a user-initiated download.
- Export uses a `data:` URL and an anchor click, so nothing is uploaded anywhere.
- No shell commands, credentials, or privileged actions are involved.
- When reproducing a look from a reference image, reproduce the *technique*. Do not trace,
  re-upload, or redistribute someone else's artwork, and keep third-party brand names and
  logos out of the output.

## Common Pitfalls

- **Problem:** The type renders flat with a thin shiny rim and a dead interior.
  **Solution:** The height-map blur is too small. Raise it until the blurred silhouette has
  no flat plateau — around 40 for a 300px cap height in the chrome template.
- **Problem:** Letters melt into an unreadable blob at large sizes.
  **Solution:** Filter radii are absolute pixels. Multiply `stdDeviation`, `surfaceScale`
  and `stroke-width` by `fontSize / 300` as the templates do.
- **Problem:** Colours look chalky and desaturated.
  **Solution:** Missing `color-interpolation-filters="sRGB"`.
- **Problem:** The chrome looks like rust.
  **Solution:** The R/G/B ramp phases are too far apart. Keep the offset under ~0.05 cycles.
- **Problem:** Halftone dots are all identical.
  **Solution:** The source is a flat fill. Add a gradient, or turn on 글자 그라디언트.
- **Problem:** Grain is invisible on a dark poster.
  **Solution:** `overlay` blend does nothing near black. Add a `screen` grain layer.
- **Problem:** PNG export produces a blank image.
  **Solution:** The SVG must be self-contained. Any external reference — a remote font, an
  `<image href>` to another file — makes the browser refuse to rasterise it.

## Related Skills

- `@canvas-design` - When the deliverable is a full art-directed composition rather than a
  typographic treatment
- `@color-expert` - For building the gradient-map ramps and checking contrast
- `@shader-programming-glsl` - When the effect needs to animate per-frame at 60fps
- `@frontend-design` - For the surrounding page or layout the treatment sits in
