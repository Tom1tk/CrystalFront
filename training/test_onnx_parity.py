"""
Verify that ONNX inference matches PyTorch within tolerance.

Loads both models, runs N random observations through each, and asserts that
the action_logits and value outputs match within the given tolerance. A passing
run means the ONNX export is correct and safe to deploy.

Usage:
    python -m training.test_onnx_parity \
      --checkpoint checkpoints/.../update_000150.pt \
      --onnx_path models/policy-v0.3.2-ML.onnx
"""

from __future__ import annotations

import os
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED", "0")

import sys
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import onnxruntime as ort
import tyro

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from training.ppo.policy import CrystalFrontAgent
from training.export_onnx import _OnnxWrapper


@dataclass
class Config:
    checkpoint: str   = "checkpoints/crystalfront_ppo__0_3_0-ML__idle__1__1779364610/update_000150.pt"
    onnx_path:  str   = "models/policy-v0.3.2-ML.onnx"
    n_samples:  int   = 200
    tolerance:  float = 1e-3
    seed:       int   = 42
    # Must match training config
    entity_d_model:  int = 64
    entity_n_heads:  int = 4
    entity_n_layers: int = 2
    node_d_model:    int = 32
    mlp_hidden:      int = 384


def main(cfg: Config) -> None:
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)
    random.seed(cfg.seed)

    # ── load PyTorch model ────────────────────────────────────────────────────
    ckpt = torch.load(cfg.checkpoint, map_location="cpu", weights_only=False)
    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    )
    state = ckpt["agent"]
    if any(k.startswith("_orig_mod.") for k in state):
        state = {k.replace("_orig_mod.", ""): v for k, v in state.items()}
    agent.load_state_dict(state)
    agent.eval()
    wrapper = _OnnxWrapper(agent)
    wrapper.eval()
    print(f"PyTorch model loaded: {cfg.checkpoint}")

    # ── load ONNX session ─────────────────────────────────────────────────────
    sess = ort.InferenceSession(cfg.onnx_path, providers=["CPUExecutionProvider"])
    print(f"ONNX session loaded: {cfg.onnx_path}")

    # ── run comparison ────────────────────────────────────────────────────────
    max_logit_err = 0.0
    max_value_err = 0.0

    for i in range(cfg.n_samples):
        # Random observations with realistic value ranges
        g  = torch.randn(1, 22)
        e  = torch.randn(1, 64, 12)
        em = torch.randint(0, 2, (1, 64), dtype=torch.bool)
        em[0, 0] = True   # at least one valid entity
        n  = torch.randn(1, 8, 5)
        nm = torch.randint(0, 2, (1, 8), dtype=torch.bool)
        nm[0, 0] = True   # at least one valid node

        # PyTorch forward
        with torch.no_grad():
            pt_logits, pt_value = wrapper(g, e, em, n, nm)
        pt_logits_np = pt_logits.numpy()
        pt_value_np  = pt_value.numpy()

        # ONNX forward
        feeds = {
            "global":      g.numpy(),
            "entities":    e.numpy(),
            "entity_mask": em.numpy(),
            "nodes":       n.numpy(),
            "node_mask":   nm.numpy(),
        }
        ort_logits, ort_value = sess.run(None, feeds)

        logit_err = float(np.abs(pt_logits_np - ort_logits).max())
        value_err = float(np.abs(pt_value_np  - ort_value).max())
        max_logit_err = max(max_logit_err, logit_err)
        max_value_err = max(max_value_err, value_err)

        if logit_err > cfg.tolerance or value_err > cfg.tolerance:
            print(f"FAIL at sample {i}: logit_err={logit_err:.6f}, value_err={value_err:.6f}")
            raise AssertionError(f"Parity check failed (tolerance={cfg.tolerance})")

    print(f"PASS: {cfg.n_samples} samples")
    print(f"  max logit error: {max_logit_err:.2e}")
    print(f"  max value error: {max_value_err:.2e}")
    print(f"  (tolerance: {cfg.tolerance:.2e})")


if __name__ == "__main__":
    main(tyro.cli(Config))
