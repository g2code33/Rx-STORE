# Appearance (light / dark / system)

Every signed-in account can choose its appearance in **Profile → Settings →
Appearance**. The setting is remembered on the device *and* on the account, so
it follows the user to their other devices.

| Choice | Behaviour |
| --- | --- |
| **Light** | Bright surfaces, dark ink. Always applied, whatever the OS says. |
| **Dark** | The original RX Store look. Always applied. |
| **System** | Follows the OS appearance live (`prefers-color-scheme`), including while the page is open. |

Default for a device that has never chosen: **Dark** — the storefront shipped
dark-only, so a deploy must not silently re-skin it.

## How it works

One attribute drives everything:

```html
<html data-theme="light">  <!-- or "dark" -->
```

`src/platform/theme.ts` owns the logic (`normalizeThemePreference`,
`resolveTheme`, `applyTheme`, …) and is pure, so it is unit-tested in
`src/platform/theme.test.ts` — including the rule that the pre-paint script in
`index.html` cannot drift from the module.

`src/context/ThemeContext.tsx` is the React layer: it reads the device
preference, resolves `system` against `matchMedia`, paints the attribute, and
mirrors an explicit choice to `user.preferences.theme` (the account field is
written **only** when the user actually picks a theme, so saving an unrelated
preference can never overwrite another device's choice).

### No flash of the wrong theme

`index.html` carries a tiny pre-paint script that reads `rx-theme` from
`localStorage`, resolves the system preference and sets `data-theme` **before**
the bundle executes. `<html data-theme="dark">` is the no-JS default.

### Desktop shell

The Electron main process mirrors the choice too (`theme:set` IPC):
`nativeTheme.themeSource` (native menus, dialogs, and `prefers-color-scheme`
inside the renderer) and each window's `backgroundColor`, so a window never
flashes the wrong colour before first paint.

## Colour system

Everything colour-related is a CSS variable, so no component markup has to know
which theme is active.

| Token | Backs | Dark | Light |
| --- | --- | --- | --- |
| `--rx-dark` | `bg-rx-dark`, page background | `15 20 25` | `243 246 250` |
| `--rx-dark-secondary` | `bg-rx-dark-secondary`, cards (`card`) | `26 35 50` | `255 255 255` |
| `--rx-dark-tertiary` | inputs, chips, hovers | `36 48 68` | `232 237 243` |
| `--rx-ink` | **every** `text-white`, `bg-white/5…20`, `border-white/5…25`, `divide-white/5` | white | ink `15 20 25` |
| `--rx-muted` | `text-rx-gray-medium` | `136 153 170` | `88 104 122` |
| `--rx-yellow*` | brand accent (unchanged in both themes) | `255 214 0` | `255 214 0` |

The `--rx-ink` indirection is what makes the light theme possible without
rewriting ~1,700 utility usages: `white` in `tailwind.config.js` resolves to
`rgb(var(--rx-ink) / <alpha-value>)`, so opacity modifiers keep working.

### Corrections a variable cannot express

These live at the bottom of `src/index.css`, one rule each — the complete list:

1. `.text-rx-dark` is pinned to real ink (it is the text on a yellow/green
   button and must stay dark in both themes).
2. `.text-rx-yellow` (and its `hover:` / `group-hover:` / `/80` / `/90`
   variants) becomes a deep gold in light mode. Bright yellow is a **fill**;
   as text on white it is ~1.1:1 and unreadable. `.gradient-text` follows.
3. Status colours tuned for dark (`text-green-400`, `text-red-300`,
   `text-amber-300`, `text-blue-300`, `text-purple-*`, `text-yellow-*`,
   `text-gray-400/600`) get the equivalent darker shade, keeping meaning and
   reaching ≥4.5:1 on white. `fill-yellow-400` matches `text-yellow-400`.
4. The few deliberate pure-white elements (`.bg-white`, `.bg-white/70`,
   `/90`) stay white and gain a hairline shadow.
5. `.bg-gradient-hero` gets a light ramp.
6. `.bg-black/30` (code blocks and quoted messages, not modal scrims) becomes a
   neutral tint.
7. Card elevation, glow, scrollbars and `::selection` are re-tuned.

## Adding a component

1. Use the semantic classes — `bg-rx-dark-secondary`, `text-white`,
   `text-rx-gray-medium`, `border-white/10` — and the theme just works.
2. Never hard-code a dark hex (`#0F1419`, `#1A2332`) in a component; use
   `rgb(var(--rx-…))` if you need a raw value (see the toast style in
   `App.tsx`).
3. If you introduce a new *literal* colour (a Tailwind palette class, a fixed
   hex), add the light-mode counterpart to the list in `index.css` **and** a
   line to the test that asserts both palettes exist.
4. Check contrast against the light page (`#f3f6fa`) and cards (`#ffffff`) —
   body text needs 4.5:1, large/bold text 3:1.

## Admin "Live Website Builder" interaction

The builder can set brand colours (`design.brandColor*`) and a custom dark
palette (`design.bgColor`, `design.surfaceColor*`) as inline CSS variables. Brand
colours apply in both themes; the three surface variables are **skipped while
the light theme is active**, otherwise an inline dark palette would beat the
light CSS block and leave a "light" storefront painted dark.
