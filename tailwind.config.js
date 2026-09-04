/** @type {import('tailwindcss').Config} */

/**
 * Bind a Tailwind colour family to a CSS-variable ramp defined in
 * src/web/index.css. `<alpha-value>` keeps opacity modifiers working,
 * so `bg-brand-600/20` still renders a 20% tint of the themed value.
 */
const ramp = (name) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
      step,
      `rgb(var(--${name}-${step}) / <alpha-value>)`,
    ]),
  );

const neutral = ramp('neutral');
const brand = ramp('brand');
const success = ramp('success');
const warning = ramp('warning');
const danger = ramp('danger');
const info = ramp('info');
// `alt` ramp lives in CSS only — see the colours block below.

export default {
  content: ['./src/web/**/*.{html,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ── Semantic families — the only colour names in the markup.
        //    Hue names (zinc, cyan, emerald, …) are deliberately NOT
        //    aliased here: naming a colour by its hue is what
        //    DESIGN_LANGUAGE.md §7 rule 4 forbids, and leaving the
        //    aliases in place lets it creep back in silently.
        neutral,
        brand,
        success,
        warning,
        danger,
        info,
        // `--alt-*` is deliberately not exposed as a utility family: it
        // feeds the ambient body gradient and is the reservoir the
        // entity-type scale draws from, but as a call-site colour name
        // "alt" says nothing about intent. Add it back only with a role.

        // ── Structural tokens ─────────────────────────────────
        //    Bound to the ramp triplets rather than the `--color-*`
        //    aliases they mirror, so opacity modifiers work:
        //    `border-muster-border/60` silently emitted no rule while
        //    these were plain `var()` values.
        muster: {
          accent: `rgb(var(--brand-400) / <alpha-value>)`,
          'accent-solid': `rgb(var(--brand-600) / <alpha-value>)`,
          'on-accent': `rgb(var(--neutral-950) / <alpha-value>)`,
          surface: `rgb(var(--neutral-900) / <alpha-value>)`,
          base: `rgb(var(--neutral-950) / <alpha-value>)`,
          hover: `rgb(var(--neutral-800) / <alpha-value>)`,
          active: `rgb(var(--neutral-700) / <alpha-value>)`,
          border: `rgb(var(--neutral-800) / <alpha-value>)`,
          text: `rgb(var(--neutral-100) / <alpha-value>)`,
          muted: `rgb(var(--neutral-400) / <alpha-value>)`,
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      fontFamily: {
        sans: ['Inter Variable', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono Variable', 'JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
