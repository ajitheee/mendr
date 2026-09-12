# Mendr brand mark

The mark is a lowercase **m** built from one rail and three legs, the way three model calls hang off one dependency trace.
The third leg stops one stroke short of the baseline; an amber square sits where its foot should be: the retiring
dependency, caught before it drops. It is the first letter of the name, so the wordmark is set as the mark + `endr`.

## Files
| File | Use |
|---|---|
| `mendr-mark.svg` | the mark on light grounds (cobalt #315CFF + amber #D88916) |
| `mendr-mark-dark.svg` | on near-black grounds (cobalt lightened to #7C97FF) |
| `mendr-mark-mono.svg` | one colour (ink) for print, stamps, monochrome UI |
| `mendr-mark-glyph.svg` | the mark cropped to its glyph box, for inline use as the wordmark's own m |
| `mendr-lockup.svg` / `-dark.svg` | mark + "endr", wordmark outlined (no font needed) |
| `mendr-lockup-word.svg` | mark + full word "mendr", for places where the letter lockup would be unfamiliar |
| `favicon.svg`, `favicon-16.png`, `favicon-32.png`, `apple-touch-icon-180.png` | browser tab and home-screen icons |
| `mendr-avatar-512.png` | GitHub App avatar and LinkedIn page logo (square; both crop it) |
| `mendr-avatar-512-rounded.png`, `mendr-avatar-512-dark.png` | social and dark contexts |
| `mendr-mark-1024.png` | transparent, for slides and video |

## Rules
- Grid 100 × 100; stroke 14; the glyph box is x 15–92, y 30–92. Clear space around the mark = one stroke (14 units) on every side.
- Minimum size: 16 px for the mark alone; 24 px cap height for the letter lockup.
- Colour: cobalt for the trace, amber for the one caught node, nothing else. On near-black use `mendr-mark-dark.svg`.
- Never rotate, outline, add a gradient or a drop shadow, or put the mark in a circle badge.
- Wordmark: Instrument Sans 600, tracking −0.01 em. In HTML the letter lockup is the glyph SVG at height `0.510em` (the x-height), `vertical-align: baseline`, followed by `endr`.
