"""
v2 learner network (ML_RETRAIN_IMPLEMENTATION.md §7.1).

    entity set → transformer (per-entity embeddings feed the pointer heads) ┐
    memory, nodes → MLP                                                      │
    grid (dynamic + static channels) → 3-layer CNN → linear                  ├→ concat → MLP → x
    globals + z → MLP (z via embedding)                                      ┘
    x → LSTM cell → h = x + mem_out(lstm)          (memory across decisions)
    h → opponent model (enemy unit / building counts, army location)
    h → h + opp_in(opponent-model probabilities, detached) → policy and value heads

mem_out and opp_in start at zero, so a feed-forward checkpoint loads into this
network and plays exactly as before until training moves them (`load_weights`).
    heads: econ kind → site | econ pointer | econ target
           group → order → unit pointer → point target | entity pointer
           scout order → point target | entity pointer (the Outrider's own slot, action space 9;
           warm-started from the army heads as the `scout` group when a checkpoint lacks them)
           (each masked and conditioned on the previous choices)
    value × 3 (win, shaped, aux) from h and the critic-state encoding (both seats' true globals)

Layout v4 (rebuild R1, docs/REBUILD_R1_PLAN.md S6) adds:
    attention pool: 4 learned queries over entity embeddings + memory tokens + a null token, 2 more
        over enemy rows and filled memory slots only → Linear → new (zero-initialised) core inputs
    opponent model: near-base buildings / combat units and workers out (bins), near-base anchor
        (focal loss, the labels are rare)
    critic: the unfogged entities (1 transformer layer, attention pool), grid (CNN) and nodes next to
        the true globals (training only; never exported)

A head that does not apply to the chosen action (e.g. site when not building)
contributes nothing to the log-probability or entropy.
"""
from __future__ import annotations

import math

import numpy as np

import torch
import torch.nn as nn
import torch.nn.functional as F

from training.v2 import spaces as S

NEG = -1e9
V4 = S.LAYOUT == "v4"
N_POOL_ALL, N_POOL_ENEMY = 4, 2
OPP_NEW_COUNTS = ("nearBuildings", "nearCombat", "workersOut")  # v4 opponent-model groups (binned), then nearAnchor


class AttnPool(nn.Module):
    """Learned queries over a token set plus an always-valid null token (so an empty set cannot give NaN).
    `allowed` is one (B, T) bool mask per query group; returns (B, n_queries, d)."""

    def __init__(self, d: int, groups: tuple[int, ...], heads: int = 4):
        super().__init__()
        self.groups, self.heads = groups, heads
        self.q = nn.Parameter(torch.randn(sum(groups), d) * 0.02)
        self.null = nn.Parameter(torch.zeros(1, 1, d))
        self.attn = nn.MultiheadAttention(d, heads, dropout=0.0, batch_first=True)

    def forward(self, tokens: torch.Tensor, allowed: list[torch.Tensor]) -> torch.Tensor:
        b = tokens.shape[0]
        kv = torch.cat([tokens, self.null.expand(b, 1, -1)], 1)
        one = torch.ones(b, 1, dtype=torch.bool, device=tokens.device)
        block = torch.cat([torch.cat([a, one], 1).unsqueeze(1).expand(-1, n, -1) for a, n in zip(allowed, self.groups)], 1)  # (B, Q, T + 1)
        mask = (~block).repeat_interleave(self.heads, 0)
        out, _ = self.attn(self.q.unsqueeze(0).expand(b, -1, -1), kv, kv, attn_mask=mask, need_weights=False)
        return out


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
        n_core = d_ent + 128 * 3 + 256
        if V4:  # attention pool over entities and memory tokens; its core columns start at zero
            self.mem_tok = nn.Linear(S.MEMORY_F, d_ent)
            self.slot_emb = nn.Embedding(S.N_MEMORY, d_ent)
            self.pool = AttnPool(d_ent, (N_POOL_ALL, N_POOL_ENEMY))
            self.pool_out = nn.Sequential(nn.Linear((N_POOL_ALL + N_POOL_ENEMY) * d_ent, 256), nn.ReLU())
        self.core = nn.Sequential(
            nn.Linear(n_core + (256 if V4 else 0), 512), nn.LayerNorm(512), nn.ReLU(),
            nn.Linear(512, d_h), nn.ReLU(),
        )
        if V4:
            with torch.no_grad():
                self.core[0].weight[:, n_core:] = 0.0
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
        # Scout slot (the Outrider's own order); load_weights copies the army heads into these when missing
        self.scout_order = nn.Linear(d_h, S.N_ORDERS)
        self.scout_target = nn.Linear(d_h, S.TARGETS)
        self.scout_ptr_q = nn.Linear(d_h, d_ent)
        # Memory and opponent model (residual, zero at init)
        self.lstm = nn.LSTMCell(d_h, d_h)
        self.mem_out = nn.Linear(d_h, d_h)
        self.n_opp = (S.OPP_UNITS + S.OPP_BUILDINGS) * S.OPP_BINS + S.N_ANCHORS + 1
        if V4:
            self.n_opp += len(OPP_NEW_COUNTS) * S.OPP_BINS + S.N_ANCHORS + 1
        self.opp = nn.Linear(d_h, self.n_opp)
        self.opp_in = nn.Linear(self.n_opp, d_h)
        for m in (self.mem_out, self.opp_in):
            nn.init.zeros_(m.weight)
            nn.init.zeros_(m.bias)
        # Critic
        self.critic = nn.Sequential(nn.Linear(2 * S.N_GLOBALS, 128), nn.ReLU())
        if V4:  # the unfogged state: entities (64-d, 1 layer, 2-query pool), grid CNN, nodes → 128 more
            self.c_ent_proj = nn.Linear(S.ENTITY_F, 64)
            c_layer = nn.TransformerEncoderLayer(64, 4, 128, dropout=0.0, batch_first=True, norm_first=True)
            self.c_ent_enc = nn.TransformerEncoder(c_layer, 1, enable_nested_tensor=False)
            self.c_pool = AttnPool(64, (2,))
            self.c_ent_out = nn.Sequential(nn.Linear(2 * 64, 64), nn.ReLU())
            self.c_cnn = nn.Sequential(
                nn.Conv2d(c, 16, 3, stride=2, padding=1), nn.ReLU(),
                nn.Conv2d(16, 32, 3, stride=2, padding=1), nn.ReLU(), nn.Flatten(),
            )
            with torch.no_grad():
                n_ccnn = self.c_cnn(torch.zeros(1, c, S.GRID_ROWS, S.GRID_COLS)).shape[1]
            self.c_grid = nn.Sequential(nn.Linear(n_ccnn, 32), nn.ReLU())
            self.c_nodes = nn.Sequential(nn.Linear(S.N_NODES * S.NODE_F, 32), nn.ReLU())
        self.value = nn.Sequential(nn.Linear(d_h + (256 if V4 else 128), 256), nn.ReLU(), nn.Linear(256, 3))
        for head in (self.econ, self.site, self.etgt, self.group, self.order, self.target, self.scout_order, self.scout_target):
            nn.init.orthogonal_(head.weight, 0.01)
            nn.init.zeros_(head.bias)
        # Kind-balanced starting priors (learnable biases): without them a near-uniform
        # policy spends ~80% of econ decisions on the 48 assign variants and sends
        # the army to random grid cells instead of named anchors (idle probe run 1).
        with torch.no_grad():
            self.econ.bias[S.ECON_ASSIGN0:S.ECON_REPAIR] = -math.log(12.0)  # 48 assigns weigh like 4 actions
            for head in (self.target, self.etgt, self.scout_target):  # 750 grid cells weigh like the 53 named targets
                head.bias[S.TARGET_GRID0:S.TARGET_NONE] = -math.log(S.GRID_CELLS / S.TARGET_GRID0)
            self.site.bias[S.NAMED_SITES:] = -math.log(S.GRID_CELLS / S.NAMED_SITES)  # 750 grid sites weigh like the 10 named

    # ── trunk ────────────────────────────────────────────────────────────────

    def zero_state(self, b: int, dev) -> tuple[torch.Tensor, torch.Tensor]:
        d = self.lstm.hidden_size
        return torch.zeros(b, d, device=dev), torch.zeros(b, d, device=dev)

    def trunk(self, o: dict[str, torch.Tensor], state):
        """One decision. `state` = (h, c), each (B, d_h). Returns h (B, d_h), E (B, N, d_ent), valid (B, N), new state, opponent-model logits."""
        x, E, valid = self.encode(o)
        hs, cs = self.lstm(x, state)
        h, opp = self._heads_in(x + self.mem_out(hs))
        return h, E, valid, (hs, cs), opp

    def trunk_seq(self, o: dict[str, torch.Tensor], state, first: torch.Tensor, L: int):
        """Training: o holds L×n decisions laid out time-major ((t, seq) → t * n + seq); `state` is each
        sequence's state before its first step and `first` (L * n,) marks episode starts (state reset)."""
        x, E, valid = self.encode(o)
        n = x.shape[0] // L
        xs, keep = x.view(L, n, -1), (~first).float().view(L, n, 1)
        hs, cs = state
        out = []
        for t in range(L):
            hs, cs = self.lstm(xs[t], (hs * keep[t], cs * keep[t]))
            out.append(hs)
        h, opp = self._heads_in(x + self.mem_out(torch.stack(out).view(L * n, -1)))
        return h, E, valid, opp

    def _heads_in(self, h):
        opp = self.opp(h)
        return h + self.opp_in(self.opp_probs(opp).detach()), opp

    def opp_probs(self, opp: torch.Tensor) -> torch.Tensor:
        """Logits → per-group softmax probabilities (same layout)."""
        nb = (S.OPP_UNITS + S.OPP_BUILDINGS) * S.OPP_BINS
        na = nb + S.N_ANCHORS + 1
        counts = F.softmax(opp[:, :nb].view(-1, S.OPP_UNITS + S.OPP_BUILDINGS, S.OPP_BINS), -1).flatten(1)
        out = [counts, F.softmax(opp[:, nb:na], -1)]
        if V4:
            nn_ = na + len(OPP_NEW_COUNTS) * S.OPP_BINS
            out += [F.softmax(opp[:, na:nn_].view(-1, len(OPP_NEW_COUNTS), S.OPP_BINS), -1).flatten(1), F.softmax(opp[:, nn_:], -1)]
        return torch.cat(out, -1)

    def opp_loss(self, opp: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        """Loss per prediction, averaged. labels (B, OPP_UNITS + OPP_BUILDINGS + 1 [+ 4 in v4]): bin per count, then
        anchor (cross-entropy); v4 then the near-base / workers-out bins and the near-base anchor (focal, γ 2)."""
        k = S.OPP_UNITS + S.OPP_BUILDINGS
        nb = k * S.OPP_BINS
        na = nb + S.N_ANCHORS + 1
        lc = F.cross_entropy(opp[:, :nb].reshape(-1, S.OPP_BINS), labels[:, :k].reshape(-1))
        la = F.cross_entropy(opp[:, nb:na], labels[:, k])
        if not V4:
            return (lc * k + la) / (k + 1)
        kn = len(OPP_NEW_COUNTS)
        nn_ = na + kn * S.OPP_BINS
        ln = focal_loss(opp[:, na:nn_].reshape(-1, S.OPP_BINS), labels[:, k + 1:k + 1 + kn].reshape(-1))
        lna = focal_loss(opp[:, nn_:], labels[:, k + 1 + kn])
        return (lc * k + la + ln * kn + lna) / (k + 1 + kn + 1)

    def opp_ce(self, opp: torch.Tensor, labels: torch.Tensor, near_w: float = 3.0) -> torch.Tensor:
        """(B,) weighted mean cross-entropy over the opponent-model groups (the ROA scouting reward's H, R1 S7).
        v4: the near-base groups (nearBuildings, nearCombat, nearAnchor) weigh `near_w`, the others 1."""
        k = S.OPP_UNITS + S.OPP_BUILDINGS
        nb = k * S.OPP_BINS
        na = nb + S.N_ANCHORS + 1
        ce = lambda lg, y: F.cross_entropy(lg, y, reduction="none")  # noqa: E731
        b = opp.shape[0]
        lc = ce(opp[:, :nb].reshape(-1, S.OPP_BINS), labels[:, :k].reshape(-1)).view(b, k)
        terms, w = [lc, ce(opp[:, nb:na], labels[:, k]).unsqueeze(1)], [torch.ones(k + 1, device=opp.device)]
        if V4:
            kn = len(OPP_NEW_COUNTS)
            nn_ = na + kn * S.OPP_BINS
            terms += [ce(opp[:, na:nn_].reshape(-1, S.OPP_BINS), labels[:, k + 1:k + 1 + kn].reshape(-1)).view(b, kn),
                      ce(opp[:, nn_:], labels[:, k + 1 + kn]).unsqueeze(1)]
            w += [torch.tensor([near_w if n.startswith("near") else 1.0 for n in OPP_NEW_COUNTS], device=opp.device),
                  torch.tensor([near_w], device=opp.device)]
        t, w = torch.cat(terms, 1), torch.cat(w)
        return (t * w).sum(1) / w.sum()

    def encode(self, o: dict[str, torch.Tensor]):
        """Per-decision encoder (before memory): x (B, d_h), E (B, N, d_ent), valid (B, N)."""
        ent = o["ent"]
        b, n = ent.shape[0], ent.shape[1]
        valid = torch.arange(n, device=ent.device).unsqueeze(0) < o["ent_n"].unsqueeze(1)
        safe = valid.clone()
        safe[:, 0] = True  # an all-padding row would make attention NaN
        E = self.ent_enc(self.ent_proj(ent), src_key_padding_mask=~safe)
        vf = valid.unsqueeze(-1).float()
        pooled = (E * vf).sum(1) / vf.sum(1).clamp(min=1.0)
        parts = [
            pooled,
            self.nodes(o["nodes"].flatten(1)),
            self.memory(o["memory"].flatten(1)),
            self.glob(torch.cat([o["globals"], self.z_emb(o["z"].clamp(0, S.N_Z - 1))], -1)),
            self.grid(self.cnn(o["grid"])),
        ]
        if V4:
            mem = o["memory"]
            slots = torch.arange(S.N_MEMORY, device=mem.device)
            tok = torch.cat([E, self.mem_tok(mem) + self.slot_emb(slots).unsqueeze(0)], 1)
            filled = mem[:, :, 0] > 0.5
            enemy = valid & (ent[:, :, 1] > 0.5)
            pool = self.pool(tok, [torch.cat([valid, filled], 1), torch.cat([enemy, filled], 1)])
            parts.append(self.pool_out(pool.flatten(1)))
        return self.core(torch.cat(parts, -1)), E, valid

    def values(self, h: torch.Tensor, o: dict[str, torch.Tensor]) -> torch.Tensor:
        """(B, 3): win, shaped, aux. `o` is the batch (stack_obs): `critic` holds both seats' true globals; in v4 also
        `c_ent` / `c_ent_n` / `c_nodes` / `c_grid`, this seat's unfogged state."""
        enc = [self.critic(o["critic"])]
        if V4:
            ce = o["c_ent"]
            cv = torch.arange(ce.shape[1], device=ce.device).unsqueeze(0) < o["c_ent_n"].unsqueeze(1)
            safe = cv.clone()
            safe[:, 0] = True
            CE = self.c_ent_enc(self.c_ent_proj(ce), src_key_padding_mask=~safe)
            enc += [self.c_ent_out(self.c_pool(CE, [cv]).flatten(1)), self.c_grid(self.c_cnn(o["c_grid"])), self.c_nodes(o["c_nodes"].flatten(1))]
        return self.value(torch.cat([h] + enc, -1))

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
        # Scout slot (masks without the slot allow only `none`)
        if "scoutOrder" not in (masks if rows is None else rows):  # v2 layout
            out["scoutOrder"] = torch.zeros(b, dtype=torch.long, device=h.device)
            out["scoutOrder_on"] = torch.zeros(b, dtype=torch.bool, device=h.device)
            for k in ("scoutTarget", "scoutPtr"):
                out[k], out[k + "_on"] = out["scoutOrder"].clone(), out["scoutOrder_on"].clone()
            return out, R, lp, ent
        hg = h + self.group_emb.weight[S.GROUP_SCOUT]
        take("scoutOrder", self.scout_order(hg), masks["scoutOrder"] if rows is None else rows["scoutOrder"], on)
        si = out["scoutOrder"]
        hs = h + self.order_emb(si)
        s_point = torch.zeros_like(on)
        for o_ in S.POINT_ORDERS:
            s_point |= si == o_
        take("scoutTarget", self.scout_target(hs), row("scoutTarget", "target", si), s_point)
        s_ptr = torch.zeros_like(on)
        for o_ in S.PTR_ORDERS:
            s_ptr |= si == o_
        take("scoutPtr", self._pointer(self.scout_ptr_q(hs), E), pad_valid(row("scoutPtr", "ptr", si)), s_ptr)
        return out, R, lp, ent


HEADS = ("econ", "site", "econPtr", "econTarget", "group", "order", "unit", "target", "ptr", "scoutOrder", "scoutTarget", "scoutPtr")
SCOUT_HEADS = ("scoutOrder", "scoutTarget", "scoutPtr")


WIRE = {"econ": ("econ", 0), "site": ("econ", 1), "econPtr": ("econ", 2), "econTarget": ("econ", 3),
        "group": ("army", 0), "order": ("army", 1), "unit": ("army", 2), "target": ("army", 3), "ptr": ("army", 4),
        "scoutOrder": ("scout", 0), "scoutTarget": ("scout", 1), "scoutPtr": ("scout", 2)}


def scout_labels(labels: list, dev) -> dict[str, torch.Tensor]:
    """Runner `scoutTeacher` labels [order, target, ptr] → per-head tensors (the `given` of the scout heads)."""
    a = torch.tensor(labels, dtype=torch.long, device=dev)
    return {"scoutOrder": a[:, 0], "scoutTarget": a[:, 1], "scoutPtr": a[:, 2]}


def teacher_actions(teachers: list[dict], dev) -> dict[str, torch.Tensor]:
    """Teach-seat wire actions → per-head action tensors (the `given` argument of `policy`)."""
    none = {"scout": [0, S.TARGET_NONE, 0]}
    return {k: torch.tensor([t.get(w, none.get(w))[i] for t in teachers], dtype=torch.long, device=dev) for k, (w, i) in WIRE.items()}


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
            "scout": [f("scoutOrder"), f("scoutTarget", S.TARGET_NONE), f("scoutPtr")],
        })
    return res


NEW_PARAMS = ("lstm.", "mem_out.", "opp.", "opp_in.")
# v4 modules a v4 checkpoint may lack (they keep their init): attention pool, critic encoder
V4_PARAMS = ("mem_tok.", "slot_emb.", "pool.", "pool_out.", "c_ent_proj.", "c_ent_enc.", "c_pool.", "c_ent_out.", "c_cnn.", "c_grid.", "c_nodes.")
SCOUT_FROM = {"scout_order.": "order.", "scout_target.": "target.", "scout_ptr_q.": "ptr_q."}


def load_weights(agent: Agent, sd: dict) -> None:
    """Load a checkpoint's model weights. A feed-forward checkpoint (before memory and the
    opponent model) may lack only the new modules, which keep their zero-output init. A checkpoint
    from before the scout slot gets copies of its army order / target / pointer heads there, so its
    Outrider starts out ordered as its `scout` group was."""
    sd = dict(sd)
    for new, old in SCOUT_FROM.items():
        for k in [k for k in sd if k.startswith(old)]:
            sd.setdefault(new + k[len(old):], sd[k].clone())
    missing, unexpected = agent.load_state_dict(sd, strict=False)
    bad = [k for k in missing if not k.startswith(NEW_PARAMS + (V4_PARAMS if V4 else ()))] + list(unexpected)
    if bad:
        raise RuntimeError(f"checkpoint does not match the model: {bad[:5]}")


def bin_counts(x: np.ndarray) -> np.ndarray:
    """Counts → bins 0, 1, 2, 3-4, 5-8, 9+."""
    return np.digitize(x, [1, 2, 3, 5, 9])


def focal_loss(logits: torch.Tensor, y: torch.Tensor, gamma: float = 2.0) -> torch.Tensor:
    """Mean focal loss (1 - p_y)^γ · -log p_y."""
    lp = F.log_softmax(logits, -1).gather(-1, y.unsqueeze(-1)).squeeze(-1)
    return (-(1 - lp.exp()).pow(gamma) * lp).mean()


def opp_targets(labels: list[dict]) -> np.ndarray:
    """Runner oppLabels → (B, OPP_UNITS + OPP_BUILDINGS + 1 [+ 4 in v4]) int64 class targets."""
    u = np.asarray([l["units"] for l in labels])
    b = np.asarray([l["buildings"] for l in labels])
    a = np.asarray([l["armyAnchor"] for l in labels])[:, None]
    parts = [bin_counts(u), bin_counts(b), a]
    if V4:
        parts += [bin_counts(np.asarray([[l[k] for k in OPP_NEW_COUNTS] for l in labels])), np.asarray([l["nearAnchor"] for l in labels])[:, None]]
    return np.concatenate(parts, 1).astype(np.int64)
