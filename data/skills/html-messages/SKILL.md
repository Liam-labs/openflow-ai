---
name: html-messages
description: >
  Use HTML fenced code blocks in AgentChat for structured data — status dashboards, comparisons, review findings, task grids, sprint progress. Trigger when: you're about to send a message with a table (3+ rows), status of multiple items, before/after comparison, color-tiered review findings, or task assignments. NOT for: single metrics, stack traces, yes/no answers, one-line updates. Also covers `sandbox` blocks for interactive content (charts, tools, animations). Use /html-messages before posting any structured output to the collab channel.
---

# HTML Messages

Use HTML fenced code blocks to communicate structured information in AgentChat. Markdown is linear — HTML shows relationships spatially, encodes meaning with color, and creates typographic hierarchy. All three communicate faster than paragraphs.

## Instructions

### Step 1: Decision — Should This Be HTML?

Run this check before composing your message:

```
Does your message contain any of these?
├─ Table of data with 3+ rows          → use ```html block
├─ Status of multiple items            → use ```html block (color-coded rows)
├─ Before/after or option comparison   → use ```html block (side-by-side)
├─ Review findings with severity tiers  → use ```html block (color-tiered)
├─ Sprint/phase progress (multiple)    → use ```html block (stacked bars)
├─ Task assignments (3+ people)        → use ```html block
├─ Single metric or yes/no answer      → plain text — no HTML needed
├─ Single progress bar                 → use ```progress block
├─ Numeric trend over time             → use ```chart block
├─ Architecture/flow diagram           → use ```mermaid block
├─ Stack trace or error message        → use ```code block (not HTML)
└─ Interactive tool/visualization      → use ```sandbox block
```

**Rule of thumb:** If you're about to write 3+ lines of text describing data that could be shown spatially — use an HTML block.

### Step 2: Building an html Block

Fenced code block with language `html`. Renders sanitized static HTML inline in the message. Scripts, iframes, event handlers, and CSS are stripped by DOMPurify.

**Caps:** 50KB max. One block per message (two if complementary). Never three.

**Format:**
````
```html
<table>
  <tr><th>Header</th><th>Header</th></tr>
  <tr><td>Data</td><td>Data</td></tr>
</table>
```
````

**Critical rules:**
- No `<html>`, `<head>`, or `<body>` wrapper — just the content elements
- Inline styles only: `style="..."` attributes survive sanitization; `<style>` blocks are stripped
- System font stack only: `font-family:system-ui,sans-serif` or `font-family:monospace`
- Dark theme: AgentChat is dark. Light text on dark backgrounds. Never set `background:white`
- Test before posting: broken HTML is worse than no HTML

**Allowed tags:** `<table>`, `<tr>`, `<th>`, `<td>`, `<div>`, `<span>`, `<h3>`, `<details>`, `<summary>`, `<strong>`, `<code>`, `<br>`, `<hr>`, `<ul>`, `<ol>`, `<li>`, `<pre>`, `<p>`, inline SVG elements.

**Status color palette:**
| Color | Meaning |
|-------|---------|
| `#22c55e` | Green — healthy, online, done, success, passed |
| `#f59e0b` | Amber — degraded, warning, in progress, partial |
| `#ef4444` | Red — down, critical, failed, blocked |
| `#3b82f6` | Blue — info, active, in-review |
| `#64748b` | Muted — secondary text, metadata, notes |

### Step 3: Building a sandbox Block

Fenced code block with language `sandbox`. Renders in a sandboxed iframe with null-origin isolation. JavaScript executes but has no access to AgentChat session, cookies, or parent DOM.

**Caps:** 200KB max. Auto-resizes to content height up to 2000px.

**When to use:** Interactive data visualizations, self-contained slide decks, interactive tools (calculators, configurators), rich data explorers with client-side filtering, animated demonstrations.

**Format:**
````
```sandbox
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <canvas id="c" width="400" height="200"></canvas>
  <script>
    // Your JavaScript here
  </script>
</body>
</html>
```
````

### Step 4: Visual Quality

Follow these principles when building HTML blocks:

- **Typographic hierarchy:** 3x+ size jumps, weight extremes (200 vs 800). Not timid variation.
- **Color with intent:** Status, severity, category — not decoration. Use the palette above.
- **Spatial layout:** Side-by-side comparisons, grid arrangements, indented hierarchies. Use position to show relationships.
- **Self-contained:** One block tells one complete story. Don't require surrounding text for context.
- **Minimum viable HTML:** A simple color-coded `<table>` often communicates better than elaborate `<div>` layouts. Goal is faster comprehension, not visual impressiveness.

## Examples

### Before (plain text — slow to parse)

> Services: devflow is online with 2.1% CPU and 180MB RAM, uptime 4 days 3 hours. Supabase is online with 0.8% CPU and 220MB RAM, uptime 12 days 7 hours. Footage-tracker is degraded — it restarted twice. Qdrant is down completely.

### After (html block — instant comprehension)

```html
<table style="width:100%;border-collapse:collapse;font-family:system-ui,sans-serif">
  <thead>
    <tr style="background:#1e293b;color:#e2e8f0">
      <th style="padding:8px 12px;text-align:left">Service</th>
      <th style="padding:8px 12px;text-align:left">Status</th>
      <th style="padding:8px 12px;text-align:right">CPU</th>
      <th style="padding:8px 12px;text-align:right">Mem</th>
      <th style="padding:8px 12px;text-align:left">Uptime</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:1px solid #334155">
      <td style="padding:8px 12px;font-weight:600">devflow</td>
      <td style="padding:8px 12px;color:#22c55e">● online</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">2.1%</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">180MB</td>
      <td style="padding:8px 12px;font-family:monospace">4d 3h</td>
    </tr>
    <tr style="border-bottom:1px solid #334155">
      <td style="padding:8px 12px;font-weight:600">supabase</td>
      <td style="padding:8px 12px;color:#22c55e">● online</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">0.8%</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">220MB</td>
      <td style="padding:8px 12px;font-family:monospace">12d 7h</td>
    </tr>
    <tr style="border-bottom:1px solid #334155">
      <td style="padding:8px 12px;font-weight:600">footage-tracker</td>
      <td style="padding:8px 12px;color:#f59e0b">● degraded</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">--</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">--</td>
      <td style="padding:8px 12px;font-family:monospace">restarted 2x</td>
    </tr>
    <tr style="border-bottom:1px solid #334155">
      <td style="padding:8px 12px;font-weight:600">qdrant</td>
      <td style="padding:8px 12px;color:#ef4444">● down</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">0%</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace">--</td>
      <td style="padding:8px 12px;font-family:monospace">--</td>
    </tr>
  </tbody>
</table>
```

### More Patterns

Full copy-paste patterns available at `~/DevFlow/data/central-knowledge-base/platform/html-message-blocks.md`:
- **Pattern 1:** Service/System Status dashboard
- **Pattern 2:** Sprint/Phase Progress with stacked bars
- **Pattern 3:** Side-by-Side Comparison table
- **Pattern 4:** Code Review Findings with severity tiers
- **Pattern 5:** Task Assignment Grid with status badges
- **Pattern 6:** Quick Decision/ADR Summary

## Troubleshooting

**Block doesn't render — shows as raw markdown:**
Check the opening fence is exactly ` ```html ` (not ` ```HTML `, not ` ``` html ` with extra space). Three backticks, language `html`, no trailing characters.

**Table looks broken or misaligned:**
Verify every `<td>` and `<th>` has `style="padding:..."` — inconsistent padding causes misalignment. Use `border-collapse:collapse` on the `<table>`.

**Colors look wrong or invisible:**
Confirm you're not setting `background:white` or `color:black`. Use the palette above. Light text (`#e2e8f0`, `#94a3b8`) on dark backgrounds (`#1e293b`, `#0f172a`).

**Content disappeared after posting:**
DOMPurify stripped an unsafe element. Check for `<script>`, `<style>`, `<iframe>`, event handlers (`onclick`), or `javascript:` URLs — all stripped. Use inline `style="..."` attributes only.

**sandbox block is blank:**
Ensure the content starts with `<!DOCTYPE html>` and includes `<html>`, `<head>`, `<body>` tags. sandbox blocks require full HTML document structure (unlike html blocks). Check for JavaScript syntax errors — they fail silently in the isolated iframe.
