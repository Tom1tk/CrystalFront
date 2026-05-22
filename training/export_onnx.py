"""
Export a trained CrystalFront checkpoint to ONNX for runtime inference.

The exported model takes 5 inputs matching the environment's observation dict
and returns (action_logits, value). Legal-action masking is NOT included in
the ONNX graph — callers must apply the mask to logits before argmax.

Usage:
    python -m training.export_onnx \
      --checkpoint checkpoints/.../update_000150.pt \
      --output models/policy-v0.3.2-ML.onnx

Inputs (all float32 except masks which are bool):
    global        (1, 22)
    entities      (1, 64, 12)
    entity_mask   (1, 64)   bool
    nodes         (1, 8, 5)
    node_mask     (1, 8)    bool

Outputs:
    action_logits (1, 81)   float32  -- raw logits, apply mask before argmax
    value         (1,)      float32  -- critic value estimate
"""

from __future__ import annotations

import os
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED", "0")

import sys
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn
import tyro

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from training.ppo.policy import CrystalFrontAgent


class _OnnxWrapper(nn.Module):
    """Thin wrapper with a flat forward signature suitable for torch.onnx.export."""

    def __init__(self, agent: CrystalFrontAgent) -> None:
        super().__init__()
        self.agent = agent

    def forward(
        self,
        g:  torch.Tensor,   # (B, 22)
        e:  torch.Tensor,   # (B, 64, 12)
        em: torch.Tensor,   # (B, 64)  bool
        n:  torch.Tensor,   # (B, 8, 5)
        nm: torch.Tensor,   # (B, 8)   bool
    ) -> tuple[torch.Tensor, torch.Tensor]:
        obs = {"global": g, "entities": e, "entity_mask": em, "nodes": n, "node_mask": nm}
        hidden = self.agent._encode(obs)
        logits = self.agent.actor_head(hidden)          # (B, 81)
        value  = self.agent.critic_head(hidden).squeeze(-1)  # (B,)
        return logits, value


@dataclass
class Config:
    checkpoint:      str = "checkpoints/crystalfront_ppo__0_3_0-ML__idle__1__1779364610/update_000150.pt"
    output:          str = "models/policy-v0.3.2-ML.onnx"
    opset_version:   int = 17
    # Must match training config
    entity_d_model:  int = 64
    entity_n_heads:  int = 4
    entity_n_layers: int = 2
    node_d_model:    int = 32
    mlp_hidden:      int = 384


def export(cfg: Config) -> None:
    ckpt_path = Path(cfg.checkpoint)
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")

    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    print(f"Loaded: {ckpt_path}  (update={ckpt.get('update','?')}, step={ckpt.get('global_step',0):,})")

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

    # Dummy inputs — batch size 1, matching env observation shapes
    dummy_g  = torch.zeros(1, 22)
    dummy_e  = torch.zeros(1, 64, 12)
    dummy_em = torch.ones(1, 64, dtype=torch.bool)
    dummy_n  = torch.zeros(1, 8, 5)
    dummy_nm = torch.ones(1, 8, dtype=torch.bool)

    out_path = Path(cfg.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        wrapper,
        (dummy_g, dummy_e, dummy_em, dummy_n, dummy_nm),
        str(out_path),
        input_names=["global", "entities", "entity_mask", "nodes", "node_mask"],
        output_names=["action_logits", "value"],
        dynamic_axes={
            "global":        {0: "batch"},
            "entities":      {0: "batch"},
            "entity_mask":   {0: "batch"},
            "nodes":         {0: "batch"},
            "node_mask":     {0: "batch"},
            "action_logits": {0: "batch"},
            "value":         {0: "batch"},
        },
        opset_version=cfg.opset_version,
    )

    size_mb = out_path.stat().st_size / 1_048_576
    print(f"Exported: {out_path}  ({size_mb:.1f} MB)")
    print("Next: python -m training.test_onnx_parity --checkpoint <ckpt> --onnx_path <onnx>")


if __name__ == "__main__":
    export(tyro.cli(Config))
