---
name: ssl-studio-visual-verify
description: Live visual inspection workflow for verifying UI changes in the running SSL Studio web host across wide/narrow layouts and light/dark themes. Use before completing any visible UI, CSS, layout, or panel change in SSL Studio.
---

# SSL Studio Visual Verification

`AGENTS.md` requires inspecting every visible UI change in the running app across **wide and narrow layouts** in both **light and dark themes** before calling the work done, and stating what was inspected.

## 1. Build the Frontend

Always compile the latest UI bundle before starting the browser host:

```bash
node node_modules/vite/bin/vite.js build
```

## 2. Prepare an Isolated Demo Workspace & Writable XDG Sandbox

Never mutate repository fixtures (such as `examples/due-dates`) and never write to the user's real `~/.config` or `~/.local/share` during verification:

```bash
rm -rf /tmp/ssl-studio-preview /tmp/ssl-studio-demo
mkdir -p /tmp/ssl-studio-preview/{config,data,state}
cp -r examples/due-dates /tmp/ssl-studio-demo
```

If testing Git or History views, initialize a temporary local git repo inside `/tmp/ssl-studio-demo` and commit synthetic edits using public fixture code only (never work code).

## 3. Start the Browser Host

Launch the preview server as a background daemon on a dedicated loopback port with writable XDG directories:

```bash
XDG_CONFIG_HOME=/tmp/ssl-studio-preview/config \
XDG_DATA_HOME=/tmp/ssl-studio-preview/data \
XDG_STATE_HOME=/tmp/ssl-studio-preview/state \
PORT=5193 bun run src/bun/web.ts /tmp/ssl-studio-demo
```

Wait for `http://127.0.0.1:5193` to be listening, then delegate live inspection and screenshots to the `browser` subagent.

## 4. Required 4-Point Visual Matrix

Capture and inspect screenshots (using `read_file` on host-verified screenshot paths) for all four combinations:

1. **Wide Dark (`1440×900`, Slate Dusk):** Default workspace view, panel header actions, hover states, menus, and active editor/diff interaction.
2. **Wide Light (`1440×900`, Paper):** Switch theme via Settings → Appearance (`Paper`), verify contrast, borders, tinted surfaces, and badges.
3. **Narrow Light (`720×800`, Paper):** Verify zero horizontal overflow (`scrollWidth <= clientWidth`), clean text truncation, no clipped buttons or overlapping labels.
4. **Narrow Dark (`720×800`, Slate Dusk):** Verify dark-mode clarity, focus states, and compact controls at narrow width.

## 5. Visual Defect Checklist

Check every screenshot carefully:

- No clipped or overlapping text, counters, or action buttons (especially at `720×800`).
- Menus and popovers stay inside the viewport with legible contrast.
- Hover toolbars do not shift row geometry or collide with badges/timestamps.
- Empty states, loading states, and error states read cleanly.

## 6. Mandatory Cleanup

After verification, always stop the preview daemon and remove temporary directories:

```bash
rm -rf /tmp/ssl-studio-preview /tmp/ssl-studio-demo
```

Confirm `git status` shows no stray preview files before finishing.
