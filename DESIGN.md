# Protein research report visual system

## Intent

The physical scene is a reliability engineer reviewing an architecture decision
in a bright project room: white plans, cobalt navigation ink, orange risk marks,
and compact machine annotations. The composition is a technical field report,
not a SaaS landing page or a simulated terminal.

## Color

Use a committed palette anchored by the Impeccable seed hue.

- Background: `oklch(1 0 0)`
- Surface: `oklch(0.965 0.008 252)`
- Ink: `oklch(0.18 0.025 252)`
- Muted ink: `oklch(0.43 0.028 252)`
- Primary cobalt: `oklch(0.478 0.136 251.8)`
- Primary dark: `oklch(0.31 0.105 252)`
- Signal orange: `oklch(0.70 0.17 52)`
- Positive green: `oklch(0.54 0.12 153)`
- Rule: `oklch(0.87 0.015 252)`

White text is used on saturated cobalt and orange fills. Status is always
reinforced with words or shape.

## Typography

Use the local system sans stack for prose and headings, with large weight and
width contrast rather than an external display font. Use the local monospace
stack only for measurements, event names, and implementation evidence. Body
copy is 17–19px with a maximum width of 72 characters.

## Layout

- A narrow sticky contents rail accompanies the report on wide screens.
- Sections use alternating dense evidence bands and open explanatory fields.
- Diagrams are inline, semantic SVG with adjacent prose descriptions.
- Tables become horizontally scrollable at narrow widths.
- Cards are reserved for genuinely independent evidence or use-case records.

## Components

- `claim-label`: observed, inference, proposal, or open risk.
- `system-map`: cell/executor responsibility boundary.
- `evidence-strip`: measured result with method and limitation together.
- `decision-gate`: explicit continue/stop criteria.
- `source-list`: numbered primary references and repository evidence.

## Motion

One short load choreography draws the system boundary and benchmark bars.
All content is visible without JavaScript. Reduced-motion mode disables every
transition and animation.
