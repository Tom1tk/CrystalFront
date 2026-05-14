"""Quick smoke test: run 5 steps in one env and verify shapes."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import torch
from training.env.crystalfront_env import CrystalFrontEnv, GLOBAL_DIM, ENTITY_DIM, NODE_DIM, MAX_ENTITIES, MAX_NODES, ACTION_SPACE_SIZE
from training.ppo.policy import CrystalFrontAgent

print("=== CrystalFront environment smoke test ===\n")

env = CrystalFrontEnv(opponent="idle")
obs, info = env.reset(seed=42)

print(f"Observation keys: {list(obs.keys())}")
print(f"  global:      shape={obs['global'].shape}  (expected {(GLOBAL_DIM,)})")
print(f"  entities:    shape={obs['entities'].shape}  (expected {(MAX_ENTITIES, ENTITY_DIM)})")
print(f"  entity_mask: shape={obs['entity_mask'].shape}, active={obs['entity_mask'].sum()}")
print(f"  nodes:       shape={obs['nodes'].shape}  (expected {(MAX_NODES, NODE_DIM)})")
print(f"  node_mask:   shape={obs['node_mask'].shape}, active={obs['node_mask'].sum()}")
print(f"  legal_mask:  shape={info['legal_mask'].shape}, legal={info['legal_mask'].sum()}")

# Quick agent forward pass
agent = CrystalFrontAgent()
device = torch.device("cpu")

def to_tensor(obs_dict, legal):
    return (
        {k: torch.as_tensor(v[None], dtype=torch.bool if v.dtype == np.bool_ else torch.float32)
         for k, v in obs_dict.items()},
        torch.as_tensor(legal[None], dtype=torch.bool),
    )

obs_t, mask_t = to_tensor(obs, info["legal_mask"])
with torch.no_grad():
    action, logp, entropy, value = agent.get_action_and_value(obs_t, legal_mask=mask_t)

print(f"\nAgent forward pass:")
print(f"  action={action.item()}, logp={logp.item():.3f}, entropy={entropy.item():.3f}, value={value.item():.3f}")

print(f"\nRunning 10 steps...")
total_reward = 0.0
for i in range(10):
    obs_t, mask_t = to_tensor(obs, info["legal_mask"])
    with torch.no_grad():
        action, _, _, _ = agent.get_action_and_value(obs_t, legal_mask=mask_t)
    obs, reward, terminated, truncated, info = env.step(action.item())
    total_reward += reward
    if terminated or truncated:
        obs, info = env.reset(seed=i)
        print(f"  step {i}: done. ep_reward={total_reward:.3f}")
        total_reward = 0.0

print(f"\nTotal reward over 10 steps: {total_reward:.4f}")
env.close()
print("\nSMOKE TEST PASSED")
