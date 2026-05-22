import { FCT, FctFrame, FctPanel, FctBtn, HEX_CLIP } from "../design/facet";

const BOT_OPTIONS: { name: string; label: string; sub: string; type: "ml" | "scripted" }[] = [
  { name: "ml",               label: "ML Bot",          sub: "v0.3.2 · trained policy",  type: "ml"       },
  { name: "idle",             label: "Idle",             sub: "does nothing",              type: "scripted" },
  { name: "passive",          label: "Passive",          sub: "builds, never attacks",     type: "scripted" },
  { name: "rush_weak",        label: "Weak Rush",        sub: "4 units · push @400",       type: "scripted" },
  { name: "rush_weak_medium", label: "Weak-Med Rush",    sub: "6 units · push @300",       type: "scripted" },
  { name: "rush_medium",      label: "Medium Rush",      sub: "unlimited · push @200",     type: "scripted" },
  { name: "rush",             label: "Rush",             sub: "fast aggressive",           type: "scripted" },
  { name: "turtle",           label: "Turtle",           sub: "heavy defence",             type: "scripted" },
  { name: "macro",            label: "Macro",            sub: "economy focus",             type: "scripted" },
  { name: "heavy",            label: "Heavy",            sub: "bruiser spam",              type: "scripted" },
];

interface BotSelectMenuProps {
  username: string;
  onSelect: (bot: string) => void;
  onBack: () => void;
}

export default function BotSelectMenu({ username, onSelect, onBack }: BotSelectMenuProps) {
  const mlBots      = BOT_OPTIONS.filter(b => b.type === "ml");
  const scriptedBots = BOT_OPTIONS.filter(b => b.type === "scripted");

  return (
    <FctFrame top="PLAY VS BOT">
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.inkDim, letterSpacing: "0.28em", marginBottom: 4 }}>
          ▰ PLAY VS BOT
        </div>
        <div style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.inkFaint, letterSpacing: "0.2em" }}>
          PLAYING AS · {username.toUpperCase()}
        </div>
      </div>

      {/* ML section */}
      <div style={{ fontFamily: FCT.mono, fontSize: 8, color: FCT.ice, letterSpacing: "0.2em", marginBottom: 6 }}>
        MACHINE LEARNING
      </div>
      <FctPanel clip={HEX_CLIP} style={{ padding: 12, marginBottom: 14 }}>
        {mlBots.map(bot => (
          <FctBtn
            key={bot.name}
            primary
            full
            sub={bot.sub.toUpperCase()}
            style={{ marginBottom: 4 }}
            onClick={() => onSelect(bot.name)}
          >
            ▷ {bot.label}
          </FctBtn>
        ))}
      </FctPanel>

      {/* Scripted section */}
      <div style={{ fontFamily: FCT.mono, fontSize: 8, color: FCT.inkDim, letterSpacing: "0.2em", marginBottom: 6 }}>
        SCRIPTED
      </div>
      <FctPanel clip={HEX_CLIP} style={{ padding: 12, marginBottom: 14 }}>
        {scriptedBots.map((bot, i) => (
          <FctBtn
            key={bot.name}
            full
            sub={bot.sub.toUpperCase()}
            style={{ marginBottom: i < scriptedBots.length - 1 ? 4 : 0 }}
            onClick={() => onSelect(bot.name)}
          >
            ▷ {bot.label}
          </FctBtn>
        ))}
      </FctPanel>

      {/* Back */}
      <FctBtn full sub="MAIN MENU" onClick={onBack}>
        ← Back
      </FctBtn>
    </FctFrame>

  );
}
