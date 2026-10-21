---
type: Security
---
- **The dev toolchain's `vite` is raised to 7.3.7.** 7.3.6 and earlier carry three `launch-editor` advisories (GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw), all Windows editor-launch issues in the dev server reached through `vitest`. The shipped server does not include `vite`; nothing to do for users. The override now has a floor and a ceiling (`>=7.3.7 <8`) so it cannot fall back below the fix.
