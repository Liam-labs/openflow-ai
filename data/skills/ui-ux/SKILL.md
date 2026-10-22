---
name: ui-ux
description: >
  Working guide for building functional, well-crafted interfaces: component design, layouts, animation, theming, accessibility and responsive design. Use for frontend UI implementation work alongside the design skills.
---
# UI/UX

This skill is for building **beautifully functional** interfaces, drawing on modern design trends, CSS techniques, component libraries, animation patterns, accessibility standards, and design systems. You write production-ready code, not prototypes.

## Design direction and refinement

Your role's design process decides how much design a task owns. When it does,
use `/impeccable` for direction and its refinement commands (`shape`,
`critique`, `audit`, `layout`, `typeset`, `polish`...). This skill covers the
implementation craft underneath.

## Your Philosophy

1. **Function first, beauty always** - Every visual choice serves a purpose
2. **Performance is a feature** - Only animate GPU-friendly properties (`transform`, `opacity`, `filter`, `clip-path`)
3. **Accessibility is non-negotiable** - WCAG 2.2 AA minimum, semantic HTML first, ARIA second
4. **Less is more** - Strategic minimalism. Every element earns its place
5. **Respect the user** - Honor `prefers-reduced-motion`, `prefers-color-scheme`, and zoom

---

## The 2026 Stack

| Layer | Default | Alternative |
|-------|---------|-------------|
| CSS Framework | **Tailwind CSS v4** | Vanilla CSS with modern features |
| Component Primitives | **Radix UI** (unified `radix-ui` package) | Base UI v1, Ark UI |
| Component Library | **shadcn/ui** | HeroUI, Mantine, daisyUI v5 |
| Animations | **Motion** (formerly Framer Motion) | GSAP, react-spring |
| Animation Components | **Magic UI**, **Aceternity UI** | Motion Primitives, Animate UI |
| Icons | **Lucide** | Phosphor (6 weights), Tabler (5900+) |
| Forms | **React Hook Form + Zod** | - |
| Data Tables | **TanStack Table** | AG Grid (100K+ rows) |
| Charts | **Recharts** (React) | Chart.js, ECharts, D3 |
| Toasts | **Sonner** | React Hot Toast |
| Command Palette | **cmdk** | kbar |

---

## Tailwind CSS v4 Configuration

### Standard Project Setup (globals.css)

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.145 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.145 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.985 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.396 0.141 25.723);
  --border: oklch(0.269 0 0);
  --input: oklch(0.269 0 0);
  --ring: oklch(0.439 0 0);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(0.269 0 0);
  --sidebar-ring: oklch(0.439 0 0);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; }
}
```

### Tailwind v4 Key Features
- **CSS-first config**: Use `@theme {}` instead of `tailwind.config.js`
- **Container queries built-in**: `@container` + `@sm:`, `@lg:` etc.
- **3D transforms**: `perspective-distant`, `rotate-x-51`, `transform-3d`
- **Expanded gradients**: `bg-linear-45`, `bg-conic`, `bg-radial-[at_25%_25%]`
- **`@starting-style`**: `starting:open:opacity-0` for enter animations
- **Dynamic spacing**: Any number works (`w-17`, `pr-29`)
- **OKLCH palette**: Wider P3 gamut, more vivid colors
- **Plugins**: Use `@plugin` directive instead of `plugins:[]`

---

## Color System

### OKLCH (Preferred Color Space)
OKLCH is perceptually uniform - colors with the same lightness appear equally light. Use for all theme generation.

```css
/* Generate tints/shades dynamically */
--brand: oklch(0.7 0.15 250);
--brand-light: oklch(from var(--brand) calc(l + 0.1) c h);
--brand-dark: oklch(from var(--brand) calc(l - 0.1) c h);
--brand-muted: oklch(from var(--brand) l calc(c * 0.5) h);

/* Color mixing */
--brand-soft: color-mix(in oklch, var(--brand), white 65%);
--brand-deep: color-mix(in oklch, var(--brand), black 30%);

/* Automatic light/dark */
color: light-dark(#333, #eee);
```

### Radix Colors 12-Step Scale
| Steps | Purpose | Example Uses |
|-------|---------|-------------|
| 1-2 | Backgrounds | App bg, card bg, sidebar bg |
| 3-5 | Component backgrounds | 3=normal, 4=hover, 5=active |
| 6-8 | Borders | 6=subtle, 7=interactive, 8=focus ring |
| 9-10 | Solid backgrounds | 9=primary bg, 10=hover on 9 |
| 11-12 | Text | 11=low-contrast, 12=high-contrast |

### Dark Mode Elevation (NOT shadows)
```css
.surface-0 { background: oklch(0.145 0 0); }  /* Base */
.surface-1 { background: oklch(0.18 0 0); }   /* Cards */
.surface-2 { background: oklch(0.21 0 0); }   /* Raised cards */
.surface-3 { background: oklch(0.25 0 0); }   /* Modals */
.surface-4 { background: oklch(0.29 0 0); }   /* Popovers */
```

### 2026 Trending Palettes
| Name | Colors | Use Case |
|------|--------|----------|
| Premium Tech | `#1E3A8A` + `#A8E6CF` + `#4A3F35` | SaaS/fintech |
| Calming Wellness | `#A89ACD` + `#F4E99B` + `#1E3A8A` | Health apps |
| Earthy Heritage | `#C4734C` + `#8A8265` + `#D8A39D` | Craft brands |
| Modern Nature | `#1E6F6B` + `#FF6F61` + `#DCC7B6` | Multi-purpose |

---

## Typography

### Fluid Typography (Always Use)
```css
/* Heading: 2rem at 320px → 4.5rem at 1200px */
h1 { font-size: clamp(2rem, 0.727rem + 5.682vw, 4.5rem); }

/* Subheading: 1.25rem → 2rem */
h2 { font-size: clamp(1.25rem, 0.875rem + 1.667vw, 2rem); }

/* Body: 1rem → 1.125rem */
body { font-size: clamp(1rem, 0.938rem + 0.278vw, 1.125rem); }
```

**Always use `rem` for min/max bounds** (never `px`) so values respect user font-size preferences.

### Variable Fonts
```css
@font-face {
  font-family: "Inter Variable";
  src: url("/fonts/inter-var.woff2") format("woff2");
  font-weight: 100 900;
  font-display: swap;
}

body {
  font-family: "Inter Variable", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
```

### Text Quality Rules
- `font-variant-numeric: tabular-nums` for number columns
- `text-wrap: balance` on headings
- `text-wrap: pretty` on body paragraphs
- Use curly quotes (" ") not straight quotes
- Use ellipsis character (...) not three periods

---

## Layout Patterns

### Bento Grid (Dominant 2026 Layout)
```css
.bento-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  grid-auto-flow: dense;
}
.bento-item--feature { grid-column: span 2; grid-row: span 2; }
.bento-item--wide { grid-column: span 2; }
.bento-item--tall { grid-row: span 2; }

@media (max-width: 768px) {
  .bento-grid { grid-template-columns: repeat(2, 1fr); }
  .bento-item--feature, .bento-item--wide { grid-column: span 2; }
}
@media (max-width: 480px) {
  .bento-grid { grid-template-columns: 1fr; }
  .bento-item--feature, .bento-item--wide { grid-column: span 1; }
}
```

### Container Queries (Component-Level Responsive)
```css
.card-container { container: card / inline-size; }
@container card (min-width: 400px) {
  .card-content { flex-direction: row; }
}
/* Container query units: cqi, cqb, cqmin, cqmax */
```

---

## Animation Patterns

### Performance Tier List
| Tier | Properties | What Happens |
|------|-----------|-------------|
| **S** (compositor) | `transform`, `opacity` via CSS/WAAPI | Smooth even under heavy load |
| **A** (main thread) | `transform`, `opacity` via JS | Smooth unless main thread busy |
| **C** (paint) | `color`, `background-color`, `box-shadow`, `border` | Triggers repaint |
| **D** (layout) | `width`, `height`, `margin`, `padding`, `top`, `left` | Triggers full reflow |

**ONLY animate S-tier properties.** Use `transform: translate/scale/rotate` instead of `top/left/width/height`.

### CSS Scroll-Driven Animations (No JS!)
```css
/* Reading progress bar */
.progress-bar {
  position: fixed; left: 0; top: 0;
  width: 100%; height: 4px;
  background: var(--primary);
  transform-origin: 0 50%;
  animation: grow-progress auto linear;
  animation-timeline: scroll();
}
@keyframes grow-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }

/* Fade-in on scroll */
.card {
  animation: reveal linear both;
  animation-timeline: view();
  animation-range: entry 25% cover 50%;
}
@keyframes reveal {
  from { opacity: 0; transform: translateY(30px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### Motion (Framer Motion) Patterns
```tsx
// Staggered list animation
const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } }
};
const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 }
};

<motion.ul variants={container} initial="hidden" animate="show">
  {items.map(i => <motion.li key={i} variants={item}>{i}</motion.li>)}
</motion.ul>

// Layout animation (auto-animates position/size changes)
<motion.div layout layoutId="shared-element">Content</motion.div>

// Gesture animations
<motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} />

// Exit animations
<AnimatePresence>
  {isVisible && (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      Content
    </motion.div>
  )}
</AnimatePresence>
```

### Button Micro-Interactions
```css
/* Standard tactile button */
.button {
  transition: transform 160ms ease-out, box-shadow 160ms ease-out;
}
.button:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.button:active {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}
```

### Skeleton Loading Shimmer
```css
@keyframes skeleton-shimmer {
  0% { background-position-x: 200%; }
  100% { background-position-x: 0%; }
}
.skeleton {
  animation: skeleton-shimmer 2s ease-out infinite;
  background: linear-gradient(100deg, #e8e8e8, #e8e8e8 50%, #fff 60%, #e8e8e8 70%);
  background-size: 200% 100%;
  background-attachment: fixed; /* Synchronized shimmer across elements */
  border-radius: 8px;
}
```

### Accessibility-First Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## Visual Effects

### Glassmorphism
```css
.glass-card {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px) saturate(180%);
  -webkit-backdrop-filter: blur(10px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
}
```

### Liquid Glass (Apple iOS 26 Style)
```css
.liquid-glass {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(2px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 2rem;
  box-shadow: 0 8px 32px rgba(31, 38, 135, 0.2), inset 0 4px 20px rgba(255, 255, 255, 0.3);
}
```

### Neubrutalism
```css
.neubrutalist-card {
  background: #FFE26A;
  border: 3px solid #000;
  box-shadow: 8px 8px 0px 0px #000;
  border-radius: 0;
  padding: 1.5rem;
}
.neubrutalist-button:active {
  transform: translate(4px, 4px);
  box-shadow: 0px 0px 0px 0px #000;
}
```

### Layered Shadows (Vercel Style)
```css
/* Mimic ambient + direct light with 2+ layers */
.elevated-card {
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.04),    /* Ambient: tight, subtle */
    0 4px 12px rgba(0, 0, 0, 0.08);   /* Direct: larger, offset */
  border: 1px solid rgba(0, 0, 0, 0.06);
}
```

---

## Accessibility (WCAG 2.2)

### Critical New Requirements
- **Target Size**: Interactive elements minimum 24x24 CSS pixels
- **Focus Not Obscured**: Focused elements must not be hidden by sticky elements
- **Dragging Movements**: All drag ops must have single-pointer alternatives
- **Accessible Auth**: No CAPTCHAs without alternatives
- **Consistent Help**: Help mechanisms in same location across pages
- **Redundant Entry**: Don't ask users to re-enter info from same session

### Implementation Rules
1. **Semantic HTML first**: `<button>` not `<div role="button">`, `<nav>` not `<div role="navigation">`
2. **Visible focus indicators**: Minimum 2px thick, 3:1 contrast ratio
3. **Skip links**: `<a href="#main" class="sr-only focus:not-sr-only">Skip to content</a>`
4. **Form accessibility**: Every input has `<label>`, errors use `aria-describedby` + `role="alert"`
5. **Color contrast**: 4.5:1 normal text, 3:1 large text (APCA preferred over WCAG 2 formula)
6. **Focus management**: Trap focus in modals, restore on close
7. **Screen reader testing**: Automated tools catch only ~30% of issues

### Focus Trap Pattern
```tsx
// 1. Store previous focus before opening modal
// 2. Move focus to first interactive element inside
// 3. Trap Tab/Shift+Tab within boundaries
// 4. On Escape/close, restore focus to stored element
// Use: focus-trap-react, or Radix UI Dialog (built-in)
```

---

## UX Patterns

### Navigation
- **Command Palette**: cmdk library, `Cmd+K` trigger, group by category, show recent first
- **Sidebar**: Fixed on desktop, collapsible/rail on mobile, active state via `useLocation`
- **Breadcrumbs**: Semantic `<nav aria-label="Breadcrumb"><ol>`, all clickable except last
- **Mobile**: Bottom tabs for 3-5 primary destinations, hamburger for secondary

### Forms (React Hook Form + Zod)
- Validate on blur (NOT on change), remove errors instantly on correction
- Show errors adjacent to field with `aria-describedby`
- Multi-step: validate each step independently, persist in `sessionStorage`
- Use correct `autocomplete`, `inputmode`, and `type` attributes

### Data Display
- TanStack Table for headless data logic + full rendering control
- Virtualize lists over ~100 rows with TanStack Virtual
- Use pagination for search results, infinite scroll for feeds

### Loading States
- Skeleton screens matching final layout (prevent CLS)
- 150-300ms delay before showing spinners (avoid flicker)
- Keep button labels visible during loading, add spinner beside
- Optimistic updates: show expected result immediately, reconcile on response

### Error Handling
- Error boundaries at route/feature level, NOT app-wide
- Tie errors to user actions: "We couldn't save because..."
- Always provide actionable next steps (retry, undo, contact support)
- Never show raw error codes to users

### AI Chat Interfaces
- Stream tokens as they arrive (never wait for complete response)
- Auto-scroll conversation, show typing indicator
- Provide starter prompts/suggestion chips
- Support "Copy", "Regenerate", "Edit" actions on responses
- Disable input during streaming

---

## Modern CSS Features (Use Freely)

```css
/* Container queries */
.container { container-type: inline-size; }
@container (min-width: 400px) { .child { flex-direction: row; } }

/* :has() parent selector */
form:has(input:invalid) { border-color: red; }
.card:has(.badge) { padding-top: 2rem; }

/* View Transitions API */
@view-transition { navigation: auto; }
::view-transition-old(main) { animation: fade-out 0.3s ease; }
::view-transition-new(main) { animation: fade-in 0.3s ease; }

/* @starting-style (enter animations without keyframes) */
.toast {
  opacity: 1; transform: translateY(0);
  transition: opacity 200ms, transform 200ms;
}
@starting-style {
  .toast { opacity: 0; transform: translateY(12px); }
}

/* Anchor positioning (native tooltips/popovers) */
.trigger { anchor-name: --my-trigger; }
.tooltip { position: fixed; position-anchor: --my-trigger; position-area: top; }

/* Popover API */
<button popovertarget="menu">Menu</button>
<div popover id="menu">Content</div>

/* text-wrap */
h1 { text-wrap: balance; }
p { text-wrap: pretty; }
```

---

## Design Principles from Top Products

### Linear (Gold Standard SaaS)
- Monochrome base + single accent color
- Spring physics animations (150-300ms)
- Keyboard shortcuts discoverable via hover tooltips (2s delay)
- Command palette as primary navigation
- Dark mode by default, brand color at 1-10% lightness

### Vercel (Performance as Design)
- Hit targets: <24px visual expands to 24px hit area; mobile min 44px
- Loading: 150-300ms show-delay, 300-500ms minimum visible
- `font-variant-numeric: tabular-nums` for data
- `touch-action: manipulation` to prevent double-tap zoom
- Never `transition: all` - explicitly list properties
- Shadows: 2+ layers mimicking ambient + direct light
- Child border-radius <= parent border-radius (concentric curves)
- State persistence in URL for sharing/refresh

### Stripe (Visual Sophistication)
- WebGL mesh gradients (GPU-accelerated, ~10KB minigl library)
- Fractal Brownian Motion with Simplex noise
- Progressive disclosure of capabilities

---

To improve this skill, edit `~/DevFlow/data/skills/ui-ux/SKILL.md` and redeploy it with `python3 ~/DevFlow/data/scaffolding/sync.py --skills-only --skill ui-ux`.
