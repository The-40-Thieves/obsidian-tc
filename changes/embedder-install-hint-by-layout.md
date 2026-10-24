---
type: Fixed
---
- **The embedder install hint follows how obsidian-tc is installed.** A global npm install is told `npm install --global <embedder>@<version>`; a project install is told `npm install --save-exact <embedder>@<version>` run in that project's directory. `obsidian-tc setup`'s install prompt names no directory for a global install. Before, the doctor warning, the boot log and the setup prompt printed both forms, and a global user who ran the project form from their home folder got a stray `package.json`.
