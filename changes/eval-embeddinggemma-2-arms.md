---
type: Added
---
- **Embedder-arms eval gains offline arm families.** nomic-v1.5 at 768 dimensions, and EmbeddingGemma 2 at 768 and 256 dimensions (the 256 arm is an MRL storage arm and never decides). Their vectors come from a Modal GPU batch run (`eval/modal_embed_gemma2.py`, bf16, text-only), loaded back into the harness after its export is checked against the run. `embedder-model-pins.json` gains an `evalOnly` block for the GPU-only eval models, which the pins gate now validates.
