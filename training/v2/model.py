"""
v2 learner network (ML_RETRAIN_IMPLEMENTATION.md §7.1), M1 step 1: feed-forward core.

    entity set → transformer (per-entity embeddings feed the pointer heads) ┐
    memory, nodes → MLP                                                      │
    grid (dynamic + static channels) → 3-layer CNN → linear                  ├→ concat → MLP → h
    globals + z → MLP (z via embedding)                                      ┘
    heads: econ kind → site | econ pointer | econ target
           group → order → unit pointer → point target | entity pointer
           (each masked and conditioned on the previous choices)
    value × 3 (win, shaped, aux) from h and the critic-state encoding (both seats' true globals)

A head that does not apply to the chosen action (e.g. site when not building)
contributes nothing to the log-probability or entropy.
"""
from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from training.v2 import spaces as S

NEG = -1e9


def masked_choice(logits, mask, active, given=None, greedy=False):
    """Sample (or score `given`) from masked logits. Returns action, log-prob, entropy, active (all (B,))."""
    has = mask.any(-1)
    active = active & has
    mask = mask.clone()
    mask[~has, 0] = True
    logits = logits.masked_fill(~mask, NEG)
    logp = F.log_softmax(logits, -1)
    if given is None:
        a = logits.argmax(-1) if greedy else torch.distributions.Categorical(logits=logits).sample()
    else:
        a = given
    af = active.float()
    lp = logp.gather(-1, a.unsqueeze(-1)).squeeze(-1) * af
    ent = -(logp.exp() * logp.masked_fill(~mask, 0.0)).sum(-1) * af
    return a, lp, ent, active


class Agent(nn.Module):
    def __init__(self, d_ent: int = 128, d_h: int = 384):
        super().__init__()
        self.d_ent = d_ent
        self.ent_proj = nn.Linear(S.ENTITY_F, d_ent)
        layer = nn.TransformerEncoderLayer(d_ent, 4, d_ent * 2, dropout=0.0, batch_first=True, norm_first=True)
        self.ent_enc = nn.TransformerEncoder(layer, 2, enable_nested_tensor=False)
        self.nodes = nn.Sequential(nn.Linear(S.N_NODES * S.NODE_F, 128), nn.ReLU())
        self.memory = nn.Sequential(nn.Linear(S.N_MEMORY * S.MEMORY_F, 128), nn.ReLU())
        self.z_emb = nn.Embedding(S.N_Z, 16)
        self.glob = nn.Sequential(nn.Linear(S.N_GLOBALS + 16, 128), nn.ReLU())
        c = S.GRID_DYN_C + S.GRID_STATIC_C
        self.cnn = nn.Sequential(
            nn.Conv2d(c, 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(64, 64, 3, stride=2, padding=1), nn.ReLU(), nn.Flatten(),
        )
        with torch.no_grad():
            n_cnn = self.cnn(torch.zeros(1, c, S.GRID_ROWS, S.GRID_COLS)).shape[1]
        self.grid = nn.Sequential(nn.Linear(n_cnn, 256), nn.ReLU())
        self.core = nn.Sequential(
            nn.Linear(d_ent + 128 * 3 + 256, 512), nn.LayerNorm(512), nn.ReLU(),
            nn.Linear(512, d_h), nn.ReLU(),
        )
        # Policy heads
        self.econ = nn.Linear(d_h, S.ECON)
        self.build_emb = nn.Embedding(S.N_BUILDINGS, d_h)
        self.site = nn.Linear(d_h, S.BUILD_SITES)
        self.eptr_emb = nn.Embedding(S.ECON_PTR_KINDS, d_h)
        self.eptr_q = nn.Linear(d_h, d_ent)
        self.etgt = nn.Linear(d_h, S.TARGETS)
        self.group = nn.Linear(d_h, S.N_GROUPS)
        self.group_emb = nn.Embedding(S.N_GROUPS, d_h)
        self.order = nn.Linear(d_h, S.N_ORDERS)
        self.order_emb = nn.Embedding(S.N_ORDERS, d_h)
        self.unit_q = nn.Linear(d_h, d_ent)
        self.unit_proj = nn.Linear(d_ent, d_h)
        self.target = nn.Linear(d_h, S.TARGETS)
        self.ptr_q = nn.Linear(d_h, d_ent)
        # Critic
        self.critic = nn.Sequential(nn.Linear(2 * S.N_GLOBALS, 128), nn.ReLU())
        self.value = nn.Sequential(nn.Linear(d_h + 128, 256), nn.ReLU(), nn.Linear(256, 3))
        for head in (self.econ, self.site, self.etgt, self.group, self.order, self.target):
            nn.init.orthogonal_(head.weight, 0.01)
            nn.init.zeros_(head.bias)
        # Kind-balanced starting priors (learnable biases): without them a near-uniform
        # policy spends ~80% of econ decisions on the 48 assign variants and sends
        # the army to random grid cells instead of named anchors (idle probe run 1).
        with torch.no_grad():
            self.econ.bias[S.ECON_ASSIGN0:S.ECON_REPAIR] = -math.log(12.0)  # 48 assigns weigh like 4 actions
            for head in (self.target, self.etgt):  # 750 grid cells weigh like the 53 named targets
                head.bias[S.TARGET_GRID0:S.TARGET_NONE] = -math.log(S.GRID_CELLS / S.TARGET_GRID0)
            self.site.bias[S.NAMED_SITES:] = -math.log(S.GRID_CELLS / S.NAMED_SITES)  # 750 grid sites weigh like the 10 named

    # ── trunk ────────────────────────────────────────────────────────────────

    def trunk(self, o: dict[str, torch.Tensor]):
        """Returns h (B, d_h), per-entity embeddings E (B, N, d_ent) and the entity validity mask (B, N)."""
        ent = o["ent"]
        b, n = ent.shape[0], ent.shape[1]
        valid = torch.arange(n, device=ent.device).unsqueeze(0) < o["ent_n"].unsqueeze(1)
        safe = valid.clone()
        safe[:, 0] = True  # an all-padding row would make attention NaN
        E = self.ent_enc(self.ent_proj(ent), src_key_padding_mask=~safe)
        vf = valid.unsqueeze(-1).float()
        pooled = (E * vf).sum(1) / vf.sum(1).clamp(min=1.0)
        x = torch.cat([
            pooled,
            self.nodes(o["nodes"].flatten(1)),
            self.memory(o["memory"].flatten(1)),
            self.glob(torch.cat([o["globals"], self.z_emb(o["z"].clamp(0, S.N_Z - 1))], -1)),
            self.grid(self.cnn(o["grid"])),
        ], -1)
        return self.core(x), E, valid

    def values(self, h: torch.Tensor, critic: torch.Tensor) -> torch.Tensor:
        """(B, 3): win, shaped, aux."""
        return self.value(torch.cat([h, self.critic(critic)], -1))

    def _pointer(self, q: torch.Tensor, E: torch.Tensor) -> torch.Tensor:
        logits = torch.einsum("bd,bnd->bn", q, E) / math.sqrt(self.d_ent)
        return F.pad(logits, (0, S.PTR - logits.shape[1]), value=NEG)

    # ── policy ───────────────────────────────────────────────────────────────

    def policy(self, h, E, valid, masks=None, rows=None, given=None, greedy=False, head_lp=None):
        """
        Sampling: pass full `masks` (stack_masks layout); the mask rows used are returned for storage.
        Scoring: pass stored `rows` and `given` actions.
        Returns (actions dict of (B,) long, rows dict, log-prob (B,), entropy dict of (B,)).
        `head_lp`, if a dict, receives each head's log-prob (B,) (0 where the head is inactive).
        """
        b = h.shape[0]
        ar = torch.arange(b, device=h.device)
        out, R, ent = {}, {}, {}
        lp = torch.zeros(b, device=h.device)
        on = torch.ones(b, dtype=torch.bool, device=h.device)
        g = (lambda k: None) if given is None else (lambda k: given[k])

        def row(key, full_key, idx):
            if rows is not None:
                return rows[key]
            return masks[full_key][ar, idx]

        def take(key, logits, mask, active):
            nonlocal lp
            a, l, e, act = masked_choice(logits, mask, active, g(key), greedy)
            out[key], R[key], ent[key] = a, mask, e
            out[key + "_on"] = act
            lp = lp + l
            if head_lp is not None:
                head_lp[key] = l

        def pad_valid(m):  # pointer masks: only real entity rows
            return m & F.pad(valid, (0, S.PTR - valid.shape[1]), value=False)

        # Economy
        take("econ", self.econ(h), masks["econ"] if rows is None else rows["econ"], on)
        e = out["econ"]
        is_build = (e >= S.ECON_BUILD0) & (e < S.ECON_ASSIGN0)
        bi = (e - S.ECON_BUILD0).clamp(0, S.N_BUILDINGS - 1)
        take("site", self.site(h + self.build_emb(bi)), row("site", "site", bi), is_build)
        is_ptr = e >= S.ECON_REPAIR
        ki = (e - S.ECON_REPAIR).clamp(0, S.ECON_PTR_KINDS - 1)
        take("econPtr", self._pointer(self.eptr_q(h + self.eptr_emb(ki)), E), pad_valid(row("econPtr", "econPtr", ki)), is_ptr)
        take("econTarget", self.etgt(h + self.eptr_emb(ki)), masks["econTarget"] if rows is None else rows["econTarget"], e == S.ECON_RALLY)
        # Army
        take("group", self.group(h), masks["group"] if rows is None else rows["group"], on)
        gi = out["group"]
        take("order", self.order(h + self.group_emb(gi)), row("order", "order", gi), on)
        oi = out["order"]
        ho = h + self.order_emb(oi)
        is_unit = gi == S.GROUP_UNIT
        take("unit", self._pointer(self.unit_q(ho), E), pad_valid(row("unit", "unit", oi)), is_unit)
        ui = out["unit"].clamp(0, E.shape[1] - 1)
        hu = ho + self.unit_proj(E[ar, ui]) * out["unit_on"].float().unsqueeze(-1)
        is_point = torch.zeros_like(on)
        for o_ in S.POINT_ORDERS:
            is_point |= oi == o_
        take("target", self.target(hu), row("target", "target", oi), is_point)
        is_eptr = torch.zeros_like(on)
        for o_ in S.PTR_ORDERS:
            is_eptr |= oi == o_
        take("ptr", self._pointer(self.ptr_q(hu), E), pad_valid(row("ptr", "ptr", oi)), is_eptr)
        return out, R, lp, ent


HEADS = ("econ", "site", "econPtr", "econTarget", "group", "order", "unit", "target", "ptr")


WIRE = {"econ": ("econ", 0), "site": ("econ", 1), "econPtr": ("econ", 2), "econTarget": ("econ", 3),
        "group": ("army", 0), "order": ("army", 1), "unit": ("army", 2), "target": ("army", 3), "ptr": ("army", 4)}


def teacher_actions(teachers: list[dict], dev) -> dict[str, torch.Tensor]:
    """Teach-seat wire actions → per-head action tensors (the `given` argument of `policy`)."""
    return {k: torch.tensor([t[w][i] for t in teachers], dtype=torch.long, device=dev) for k, (w, i) in WIRE.items()}


def wire_actions(out: dict[str, torch.Tensor]) -> list[dict]:
    """Head outputs → runner wire actions (inactive heads sent as 0 / TARGET_NONE)."""
    v = {k: out[k].cpu().numpy() for k in HEADS}
    on = {k: out[k + "_on"].cpu().numpy() for k in HEADS}
    res = []
    for i in range(len(v["econ"])):
        f = lambda k, d=0: int(v[k][i]) if on[k][i] else d  # noqa: E731
        res.append({
            "econ": [int(v["econ"][i]), f("site"), f("econPtr"), f("econTarget")],
            "army": [int(v["group"][i]), int(v["order"][i]), f("unit"), f("target", S.TARGET_NONE), f("ptr")],
        })
    return res
