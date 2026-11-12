#!/usr/bin/env python3
"""
G-10 M0 T11 (P-9a): nn.LayerNorm gradient check on this machine's GPU.

Two identical small MLPs, one with nn.LayerNorm and one with the custom
LayerNorm in training/ppo/policy.py, train side by side for 200 Adam steps on
the same random batches. Before each step the fused model gets the custom
model's weights, so both gradients are taken at the same point. Passes if every
loss and gradient stays finite and the two agree (the custom class is a
reference implementation of the same maths). The old ROCm GPU corrupted
nn.LayerNorm's backward; this checks the CUDA P100.

    python3 training/test_gpu_checks.py [--steps 200]
"""
import argparse
import os
import sys

import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from training.ppo.policy import LayerNorm  # noqa: E402


def mlp(norm) -> nn.Sequential:
    return nn.Sequential(nn.Linear(256, 512), norm(512), nn.ReLU(), nn.Linear(512, 512), norm(512), nn.ReLU(), nn.Linear(512, 32))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=200)
    args = ap.parse_args()
    if not torch.cuda.is_available():
        print("FAIL no CUDA device")
        return 1
    dev = torch.device("cuda")
    print(f"device: {torch.cuda.get_device_name(0)}, torch {torch.__version__}")
    torch.manual_seed(0)
    ref = mlp(LayerNorm).to(dev)
    fused = mlp(nn.LayerNorm).to(dev)
    fused.load_state_dict(ref.state_dict())  # same parameter names and shapes
    opts = [torch.optim.Adam(m.parameters(), lr=1e-3) for m in (ref, fused)]
    g = torch.Generator(device=dev).manual_seed(1)
    worst_grad, worst_loss = 0.0, 0.0
    for step in range(args.steps):
        x = torch.randn(1024, 256, device=dev, generator=g) * 3
        y = torch.randn(1024, 32, device=dev, generator=g)
        losses, grads = [], []
        fused.load_state_dict(ref.state_dict())  # compare gradients at identical weights
        for m, o in zip((ref, fused), opts):
            o.zero_grad()
            loss = ((m(x) - y) ** 2).mean()
            loss.backward()
            gs = torch.cat([p.grad.flatten() for p in m.parameters()])
            if not torch.isfinite(loss) or not torch.isfinite(gs).all():
                print(f"FAIL non-finite loss or gradient at step {step} ({'custom' if m is ref else 'nn.LayerNorm'})")
                return 1
            losses.append(loss.item())
            grads.append(gs)
            o.step()
        worst_loss = max(worst_loss, abs(losses[0] - losses[1]) / max(abs(losses[0]), 1e-8))
        worst_grad = max(worst_grad, ((grads[0] - grads[1]).norm() / grads[0].norm().clamp_min(1e-12)).item())
    print(f"{args.steps} steps, all finite; final loss custom {losses[0]:.4f} vs nn.LayerNorm {losses[1]:.4f}")
    print(f"max relative difference: loss {worst_loss:.2e}, gradient {worst_grad:.2e}")
    ok = worst_loss < 1e-3 and worst_grad < 1e-2
    print("PASS" if ok else "FAIL runs diverge")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
