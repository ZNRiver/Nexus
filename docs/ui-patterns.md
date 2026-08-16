# NEXUS Dashboard — UI Patterns

Conventions for building and reviewing UI in `apps/dashboard`. Follow these so every surface looks and behaves the same. All classes reference the tokens in `src/index.css` (CSS variables, three themes: `light`, `dim`, `dark`).

---

## 1. Modals

Component: `src/components/ui/Modal.tsx` — used by every dialog in the app.

### Sizing (stable = never content-driven)

- The Modal **defaults to `width="100%"`** — the panel width comes from the page's `maxWidth`, **never** from content. Never rely on content to size a modal; a content-driven width causes the panel to shrink/grow when content changes.
- Every modal must pass an explicit `maxWidth` (`440px` small dialogs, `520px` forms, `560px` wide forms, `640px` exec/terminal).
- **Form modals with long or conditional content** get a fixed height so the panel never resizes:
  ```tsx
  <Modal
    isOpen={open}
    onClose={close}
    width="520px"
    maxWidth="520px"
    height="min(680px, calc(100vh - 48px))"  // stable height, internal scroll
    ...
  ```
- Small dialogs (confirm, pull, create-single-field) keep height `auto` — their content never changes.
- The modal's scroll area carries `[scrollbar-gutter:stable]` (built into the component) so the form does not shift horizontally when the scrollbar appears/disappears.

### Footers stay pinned

Action buttons (Cancel / Create / Install…) go in the Modal **`footer` prop**, rendered **outside** the scroll area — they never scroll away and never move when content changes:

```tsx
footer={
  <div className="flex items-center justify-between border-t border-border/60 px-6 py-4">
    {/* left: summary (e.g. "Redis · 6379") */}
    {/* right: actions */}
  </div>
}
```

Do **not** put the action row inside the scrollable content.

### Conditional fields must not move the layout

When a field should disappear for some state (e.g. Database User/Password for Redis, SSH Private Key vs Password), **keep it rendered and disable it** instead of unmounting it:

```tsx
<Input
  value={form.username}
  disabled={form.type === "REDIS"}
  className={cn(inputCls, form.type === "REDIS" && "opacity-50")}
/>
```

Unmounting/re-animating fields resizes the modal and scrolls content. The exception is animations that **do not change layout** (fade/opacity of an already-sized element).

### Scroll reset on state change

If switching state can change content height (auth method, database type), reset the modal scroll so the view never jumps:

```tsx
const modalContentRef = useRef<HTMLDivElement>(null);
// ...
<Modal ... contentRef={modalContentRef} />

// in the handler that changes the conditional content:
modalContentRef.current?.scrollTo({ top: 0 });
```

### Structure inside a form modal

```tsx
<Modal ...>
  <div className="p-6">
    <h2 className="text-lg font-semibold">Title</h2>
    <p className="mt-1 text-sm text-muted-foreground">Subtitle.</p>
    <div className="mt-5 space-y-4">{/* fields: Label + control, stacked */}</div>
  </div>
</Modal>
```

Field pattern: `space-y-1.5` wrapper, `Label` (`text-[13px]` in dense modals), then the control. Grids of fields use `grid grid-cols-2 gap-3` (or `grid-cols-3`).

---

## 2. Selects

Component: `src/components/ui/custom-select.tsx` — the app's select control. **Native `<select>` elements are not used anywhere in the app** (the old `components/ui/select.tsx` was removed). If you find a native select, replace it with `CustomSelect`.

### Usage

```tsx
<CustomSelect
  value={serverId}
  options={servers.map((s) => ({
    value: s.id,
    label: s.name,
    description: s.status,   // optional dimmed second line
    icon: <DbLogo type={s.type} className="size-4" />, // optional leading icon
  }))}
  onChange={(v) => setServerId(v)}   // value directly — no event object
  placeholder="Select a server"
  className="w-56"                   // optional width on the wrapper
/>
```

### Behavior built in

- Trigger styled to match inputs: `h-[42px]`, `rounded-lg`, `bg-muted/40`, `border-input`, chevron rotates when open.
- Menu renders in a **portal** (`z-[10050]`) positioned under the trigger, **flips above** when there is no room, tracks scroll/resize.
- Selected option shows a `Check`; keyboard `Escape` and click-outside close it.
- `footerAction` and `onOpen` (lazy-load) props are available for menu footer actions and lazy-loading options.

---

## 3. Hover & interactive states

### Sidebar navigation (`src/components/sidebar.tsx`)

- Links: `hover:bg-foreground/[0.06] hover:text-foreground hover:ring-1 hover:ring-border/80` — a visible **outline ring on hover**, not just a background tint.
- Active link: `bg-foreground/[0.08] ring-1 ring-foreground/[0.1]`.
- Icon buttons (theme, collapse, logout): `hover:bg-foreground/[0.08] hover:text-foreground`.
- "New Application" CTA: bordered button look — `border border-border/80 bg-foreground/[0.06] hover:border-foreground/20 hover:bg-foreground/[0.1]`.

### Cards

Use the `.card-hover` utility (`src/index.css`) for interactive cards: border **and** shadow lift together.

```tsx
<Link className="... border ... card-hover">…</Link>
```

### List rows

Use `.row-hover` for table/list rows, or inline `hover:bg-foreground/[0.05]`.

```tsx
<Link className="flex items-center gap-4 px-5 py-4 row-hover">…</Link>
```

### General rules

- Background lifts for hover: `bg-foreground/[0.05]`–`[0.08]` (never below 4% — it reads as "nothing happens").
- Outline feedback on hover: `ring-1 ring-border/80` (or `ring-foreground/20` for emphasis).
- Transitions: `transition-colors` (or `transition-all duration-150`–`200`) on every interactive element.
- Interactive = `cursor-pointer` on buttons; rows/links get it automatically.

---

## 4. Brand logos

Component: `src/components/db-logos.tsx` — real brand SVG paths (simple-icons) for PostgreSQL, MongoDB, MariaDB, MySQL, Redis and InfluxDB, plus `DB_COLORS` brand accents.

```tsx
<DbLogo type="REDIS" className={cn("size-4", DB_COLORS.REDIS)} />
```

- Logos inherit `currentColor` — pair with `DB_COLORS[type]` for the brand color.
- Use brand logos for database types everywhere (cards, lists, detail headers, footers) instead of generic lucide icons.

---

## 5. Checklist for new UI

- [ ] Modal has explicit `maxWidth`; form modals also set `width` + `height="min(680px, calc(100vh - 48px))"`.
- [ ] Action buttons live in the Modal `footer` prop (pinned), not inside the scroll content.
- [ ] Conditional fields are disabled (not unmounted) and never change the modal size.
- [ ] `contentRef` + scroll-to-top wired for handlers that change conditional content.
- [ ] Selects use `CustomSelect` (never native `<select>`).
- [ ] Hover feedback is visible: ≥5% background lift and/or a ring.
- [ ] Database types render with `DbLogo` + `DB_COLORS`.
- [ ] Typecheck passes: `cd apps/dashboard && bun run typecheck`.
