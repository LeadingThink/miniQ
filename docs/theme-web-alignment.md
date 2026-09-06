# Theme Alignment With Zaiwen Web

## Reference

The catalog and original character PNGs come from the user's Zaiwen Web source at
commit `14a46e1ed0f821bca25802bb02fc3aecdefe7203`:

- `web/src/theme/theme-catalog.ts`
- `web/src/theme/theme-characters.ts`
- `web/src/styles/theme/skins.scss`
- `web/public/themes/characters/`

The production preference page at `https://chat.zaiwenai.com/user/general-preference`
was inspected read-only on 2026-09-06. It exposes the same 108 themes, nine categories,
25 featured themes and 10 independent character choices. No production preferences
were changed.

## Behavior

- The five-color catalog is the sole palette source for the application, gallery,
  source editor and generated early-paint bootstrap.
- All 108 themes and 16 textures are available, with search, category and mode
  filters, favorites and 12-item pagination. Pagination never discards entries.
- The 10 character choices are independent of color themes. All 18 PNGs ship
  locally; selection requires no network access. The optional watermark is a
  sidebar background, not an overlay over controls.
- Theme, character and favorites apply immediately and survive reload. The last
  light and dark selections are remembered separately. Changes sync between
  windows sharing the same origin; they do not change another device's appearance.
- With no stored theme, the initial mode follows the OS. An explicit selection
  remains explicit; this is not a continuous follow-system setting.
- Invalid persisted values are rejected. Restricted storage still permits changes
  for the lifetime of the page.
- The original `miniq.appearance.theme` key is retained. Legacy IDs migrate:
  `paper -> jade`, `mist -> ocean`, `grove -> forest`, `sunrise -> amber`,
  `midnight -> navy-office`, `aurora -> aurora-lake`. `rose` and `graphite`
  remain valid and use the canonical Web palette.
- Appearance and service settings occupy separate tabs. Search, favorites,
  character and palette selection cannot submit model settings; unsaved service
  edits survive switching tabs.
- The modal stays above the mobile drawer and keeps its header/footer visible.
  Native radios, keyboard-operable tabs, focus containment and focus restoration
  are retained across appearance changes.
- Approval code blocks and Monaco source previews follow the selected theme.
  PDF pages and HTML documents retain their own content appearance.

## Verification

From `apps/desktop`:

```sh
npx vitest run
npm run build
```

Theme tests cover every catalog ID, palette text and button contrast, early paint,
legacy migration, corrupt/blocked storage, persistence, cross-window changes and
complete pagination. Settings interaction tests cover keyboard navigation, focus,
retained service edits and absence of unintended provider writes.

`appearance-preview.html` is a development-only fixture with an in-memory settings
client. It never connects to the daemon, relay or a model provider. Use it to inspect
the real settings and source-preview components at desktop and narrow widths.
It is not a production entry point.

No version, release workflow, installed client or running task is changed.
