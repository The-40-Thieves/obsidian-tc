---
type: Security
---
- **CI installs run no downloaded build or lifecycle script outside the install smoke job.** The `setup-repo` action loses its unused `install-mode: frozen` (lifecycle scripts on), and every `pip install` in the workflows now carries `--only-binary :all:`, including the pinned Checkov install and the model service's hash-locked one.
