"""
Crystal Front policy network.

Architecture:
  Entity encoder  — SetEncoder (multi-head self-attention + masked mean pool)
                    Input:  (B, MAX_E, 11) raw features
                    Inside: typeIndex → learned 16-dim embedding; rest concatenated
                    Output: (B, ENTITY_D_MODEL)

  Node encoder    — SetEncoder (lighter, 1 layer)
                    Input:  (B, MAX_N, 5)
                    Output: (B, NODE_D_MODEL)

  Trunk           — 2-layer MLP on [global || entity_summary || node_summary]
                    Output: (B, MLP_HIDDEN)

  Actor head      — Linear → 37 logits; illegal actions masked to -1e9 before sample
  Critic head     — Linear → scalar value

Why set-attention?
  The entity list varies in length and order each tick.
  A permutation-invariant encoder is required — the same policy should produce
  the same output regardless of entity ordering.

References:
  - Set Transformer (Lee et al., 2019) — https://arxiv.org/abs/1810.00825
  - CleanRL PPO    — https://github.com/vwxyzjn/cleanrl
"""

import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical


# ── RND helpers ───────────────────────────────────────────────────────────────

class RunningMeanStd(nn.Module):
    """Online mean/variance estimator (Welford). Used for obs and reward normalisation."""

    def __init__(self, shape: tuple = ()):
        super().__init__()
        self.register_buffer("mean",  torch.zeros(shape, dtype=torch.float64))
        self.register_buffer("var",   torch.ones(shape,  dtype=torch.float64))
        self.register_buffer("count", torch.tensor(1e-4, dtype=torch.float64))

    @torch.no_grad()
    def update(self, x: torch.Tensor) -> None:
        batch = x.reshape(-1, *self.mean.shape).double()
        batch_mean = batch.mean(0)
        batch_var  = batch.var(0, unbiased=False)
        batch_n    = batch.shape[0]

        total = self.count + batch_n
        delta = batch_mean - self.mean
        new_mean = self.mean + delta * batch_n / total
        m_a = self.var  * self.count
        m_b = batch_var * batch_n
        new_var  = (m_a + m_b + delta ** 2 * self.count * batch_n / total) / total
        self.mean  = new_mean
        self.var   = new_var
        self.count = total

    def normalise(self, x: torch.Tensor) -> torch.Tensor:
        std = (self.var.float() + 1e-8).sqrt()
        return (x.float() - self.mean.float()) / std


class RNDModel(nn.Module):
    """
    @deprecated — see docs/REVIVAL_PLAN.md (RND was a symptom treatment; keep rnd_coef=0.0)

    Random Network Distillation — intrinsic exploration bonus.

    Two networks operating on the 22-dim global observation:
      target:    fixed random weights  (never updated)
      predictor: trained to match target output

    Intrinsic reward per step = ||predictor(obs_norm) - target(obs_norm)||²

    After normalising observations (obs_rms) and rewards (rew_rms), the bonus
    is ~1.0 for truly novel states and decays toward 0 for familiar ones.
    """

    def __init__(self, obs_dim: int = 22, embed_dim: int = 64):  # obs_dim matches GLOBAL_DIM
        super().__init__()
        self.obs_rms = RunningMeanStd(shape=(obs_dim,))
        self.rew_rms = RunningMeanStd(shape=())

        def _mlp(*dims) -> nn.Sequential:
            layers: list[nn.Module] = []
            for i in range(len(dims) - 1):
                layers.append(nn.Linear(dims[i], dims[i + 1]))
                if i < len(dims) - 2:
                    layers.append(nn.ReLU())
            return nn.Sequential(*layers)

        # Target: 2-layer, fixed
        self.target = _mlp(obs_dim, embed_dim, embed_dim)
        for p in self.target.parameters():
            p.requires_grad_(False)
            nn.init.orthogonal_(p) if p.dim() >= 2 else nn.init.zeros_(p)

        # Predictor: 3-layer, trained
        self.predictor = _mlp(obs_dim, embed_dim, embed_dim, embed_dim)

    def _norm_obs(self, global_obs: torch.Tensor) -> torch.Tensor:
        return self.obs_rms.normalise(global_obs).clamp(-5.0, 5.0)

    def intrinsic_reward(self, global_obs: torch.Tensor) -> torch.Tensor:
        """
        Compute per-step intrinsic reward (NOT normalised by rew_rms yet).
        Shape: (B,)
        """
        o = self._norm_obs(global_obs)
        with torch.no_grad():
            t = self.target(o)
        p = self.predictor(o)
        return ((p - t) ** 2).mean(dim=-1)  # (B,)

    def predictor_loss(self, global_obs: torch.Tensor) -> torch.Tensor:
        """MSE loss to train the predictor. Call .backward() on the result."""
        o = self._norm_obs(global_obs)
        with torch.no_grad():
            t = self.target(o)
        p = self.predictor(o)
        return ((p - t) ** 2).mean()

# ── constants matching env/crystalfront_env.py ───────────────────────────────

GLOBAL_DIM        = 22   # 18 base + 4 threat geometry (v0.1.57)
ENTITY_DIM        = 12   # raw features (v0.1.57: +inAttackRange)
NODE_DIM          = 5
N_ENTITY_TYPES    = 10
ACTION_SPACE_SIZE = 81   # v0.2.3-ML: 58→66 → 71 (targeting_friend, spread_fire × 4 groups)


# ── helpers ───────────────────────────────────────────────────────────────────

def layer_init(layer: nn.Linear, std: float = np.sqrt(2), bias: float = 0.0) -> nn.Linear:
    """Orthogonal weight init — standard for PPO."""
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias)
    return layer


class LayerNorm(nn.Module):
    """
    LayerNorm composed from basic ops (mean/var/normalise).

    nn.LayerNorm's CUDA backward kernel on ROCm (torch 2.12.0+rocm7.2)
    corrupts roughly half of grad_weight/grad_bias with leftover memory
    (observed as `inf` elements), which poisons the optimizer step and
    propagates NaNs through the whole network within a few batches. This
    composition avoids the buggy fused kernel.
    """

    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.bias   = nn.Parameter(torch.zeros(dim))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mean = x.mean(-1, keepdim=True)
        var  = x.var(-1, keepdim=True, unbiased=False)
        x_norm = (x - mean) / torch.sqrt(var + self.eps)
        return x_norm * self.weight + self.bias


# ── set encoder ───────────────────────────────────────────────────────────────

class SetEncoder(nn.Module):
    """
    Encodes a variable-length set of feature vectors into a fixed-size summary.

    Uses a standard TransformerEncoder (self-attention) followed by masked mean
    pooling.  Padding slots (mask=False) are ignored in both attention and pool.
    """

    def __init__(self, input_dim: int, d_model: int, n_heads: int, n_layers: int):
        super().__init__()
        self.proj = nn.Linear(input_dim, d_model)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=d_model * 2,
            dropout=0.0,
            batch_first=True,
            norm_first=True,    # Pre-norm: more stable for small batch sizes
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers, enable_nested_tensor=False)
        self.d_model = d_model

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """
        x:    (B, N, input_dim) — set elements
        mask: (B, N) bool       — True = valid slot, False = padding
        Returns (B, d_model).
        """
        x = self.proj(x)                              # (B, N, d_model)
        padding = ~mask                               # TransformerEncoder: True = IGNORE
        x = self.encoder(x, src_key_padding_mask=padding)   # (B, N, d_model)

        # Masked mean pooling — only average over valid slots
        valid = mask.unsqueeze(-1).float()            # (B, N, 1)
        pooled = (x * valid).sum(1) / valid.sum(1).clamp(min=1.0)  # (B, d_model)
        return pooled


# ── main agent ────────────────────────────────────────────────────────────────

class CrystalFrontAgent(nn.Module):
    """
    PPO agent for Crystal Front.

    Shared trunk for both actor and critic (standard for on-policy RL).
    The actor applies a legal-action mask before sampling — this hard-prevents
    the policy from ever choosing an action it can't execute, which dramatically
    speeds up early learning.
    """

    def __init__(
        self,
        entity_d_model: int = 64,
        entity_n_heads: int = 4,
        entity_n_layers: int = 2,
        node_d_model: int = 32,
        mlp_hidden: int = 256,
    ):
        super().__init__()

        # Entity type embedding: replaces the raw 0-9 scalar with a richer vector
        self.type_embed = nn.Embedding(N_ENTITY_TYPES, 16)

        # Entity encoder input: 16 (type emb) + 10 (remaining features) = 26
        entity_input_dim = 16 + (ENTITY_DIM - 1)
        self.entity_encoder = SetEncoder(entity_input_dim, entity_d_model, entity_n_heads, entity_n_layers)

        # Node encoder — lighter (fewer layers) since there are at most 8 nodes
        self.node_encoder = SetEncoder(NODE_DIM, node_d_model, n_heads=2, n_layers=1)

        trunk_in = GLOBAL_DIM + entity_d_model + node_d_model
        self.trunk = nn.Sequential(
            layer_init(nn.Linear(trunk_in, mlp_hidden)),
            LayerNorm(mlp_hidden),
            nn.ReLU(),
            layer_init(nn.Linear(mlp_hidden, mlp_hidden)),
            LayerNorm(mlp_hidden),
            nn.ReLU(),
        )

        # Separate heads — small std for actor to start near uniform, std=1 for critic
        self.actor_head  = layer_init(nn.Linear(mlp_hidden, ACTION_SPACE_SIZE), std=0.01)
        self.critic_head = layer_init(nn.Linear(mlp_hidden, 1), std=1.0)

    def _encode(self, obs: dict[str, torch.Tensor]) -> torch.Tensor:
        """Run all encoders and return the trunk output (B, mlp_hidden)."""
        g  = obs["global"]        # (B, GLOBAL_DIM)
        e  = obs["entities"]      # (B, MAX_E, ENTITY_DIM)
        em = obs["entity_mask"]   # (B, MAX_E) bool
        n  = obs["nodes"]         # (B, MAX_N, NODE_DIM)
        nm = obs["node_mask"]     # (B, MAX_N) bool

        # Embed entity type, replace raw typeIndex column
        type_idx = e[..., 0].long().clamp(0, N_ENTITY_TYPES - 1)  # (B, MAX_E)
        type_emb = self.type_embed(type_idx)                        # (B, MAX_E, 16)
        e_rest   = e[..., 1:]                                       # (B, MAX_E, 10)
        e_full   = torch.cat([type_emb, e_rest], dim=-1)            # (B, MAX_E, 26)

        entity_summary = self.entity_encoder(e_full, em)            # (B, entity_d_model)
        node_summary   = self.node_encoder(n, nm)                   # (B, node_d_model)

        combined = torch.cat([g, entity_summary, node_summary], dim=-1)
        return self.trunk(combined)

    def get_value(self, obs: dict[str, torch.Tensor]) -> torch.Tensor:
        """Baseline value estimate. Shape (B, 1)."""
        return self.critic_head(self._encode(obs))

    def get_action_and_value(
        self,
        obs: dict[str, torch.Tensor],
        action: torch.Tensor | None = None,
        legal_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Sample an action (or evaluate a given one) and return:
          (action, log_prob, entropy, value)

        legal_mask: (B, 73) bool — True = legal.
        Illegal actions are masked to -inf before the softmax.
        """
        hidden = self._encode(obs)
        logits = self.actor_head(hidden)                            # (B, 73)

        if legal_mask is not None:
            logits = logits.masked_fill(~legal_mask, -1e9)

        probs = Categorical(logits=logits)
        if action is None:
            action = probs.sample()
        return action, probs.log_prob(action), probs.entropy(), self.critic_head(hidden)
