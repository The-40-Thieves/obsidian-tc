#!/usr/bin/env bash
# qwen-tei: the Qwen3 dense-embedding backend for ModelClient.embed
# (packages/server/src/model/tei.ts). Hugging Face Text Embeddings Inference serving
# Qwen3-Embedding with last-token pooling over the OpenAI-compatible /v1/embeddings
# endpoint. CPU vs GPU is ONLY the device: same contract, same pooling, so the TS
# adapter is unchanged either way. Weights persist in the tei-qwen-data volume.
#
# Usage:
#   ./run.sh                              # cpu, Qwen3-Embedding-0.6B (default)
#   ./run.sh gpu                          # gpu (--gpus all, arch-specific image)
#   ./run.sh cpu Qwen/Qwen3-Embedding-4B  # a bigger model on cpu
set -euo pipefail
# Git Bash / MSYS mangles the container-side "/data" mount and the model-id slashes when
# calling the Windows docker exe; disable POSIX path conversion for this script.
export MSYS_NO_PATHCONV=1
DEVICE="${1:-cpu}"
MODEL="${2:-Qwen/Qwen3-Embedding-0.6B}"
NAME="qwen-tei"
PORT="8085"
VER="1.9"
# Cap the warmup batch: TEI warms up a full --max-batch-tokens batch, and O(n^2) attention at the
# 16384 default OOM-kills the process during warmup (silently on Docker Desktop / WSL2). Our chunks
# are ~171 tokens, so 2048 is ample and keeps warmup small on both CPU and this 10 GB GPU.
BATCH_TOKENS="${BATCH_TOKENS:-2048}"
CLIENT_BATCH="${CLIENT_BATCH:-32}"
# The GPU image tag is the GPU's CUDA compute capability, NOT the generic "cuda" image: that generic
# image lacks sm_86 kernels and SILENTLY falls back to CPU on an RTX 30xx. 86=Ampere (RTX30xx/A10),
# 80=A100, 89=Ada (RTX40xx), 90=Hopper, 75=Turing. Default 86 for this box's RTX 3080; override CUDA_CC.
CUDA_CC="${CUDA_CC:-86}"
case "$DEVICE" in
  cpu) IMAGE="ghcr.io/huggingface/text-embeddings-inference:cpu-${VER}";        GPU_FLAG="" ;;
  gpu) IMAGE="ghcr.io/huggingface/text-embeddings-inference:${CUDA_CC}-${VER}"; GPU_FLAG="--gpus all" ;;
  *)   echo "usage: $0 [cpu|gpu] [model-id]" >&2; exit 1 ;;
esac
docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "starting '$NAME' device=$DEVICE image=$IMAGE model=$MODEL port=$PORT batch_tokens=$BATCH_TOKENS"
# shellcheck disable=SC2086
docker run -d --name "$NAME" $GPU_FLAG \
  -p "${PORT}:80" \
  -v tei-qwen-data:/data \
  --pull always \
  "$IMAGE" \
  --model-id "$MODEL" \
  --max-batch-tokens "$BATCH_TOKENS" \
  --max-client-batch-size "$CLIENT_BATCH"
echo "started. health: curl http://127.0.0.1:${PORT}/health   info: curl http://127.0.0.1:${PORT}/info"
