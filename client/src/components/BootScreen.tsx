/**
 * First screen of the site (G-12): word mark and progress while the 3D models and the
 * menu backdrop load. The sound icon is already here, so a player can mute before any
 * music starts. Fades out once `done` is set.
 */
import { useEffect, useState } from "react";
import { Wordmark } from "../design/glass";

export default function BootScreen({ done, status }: { done: boolean; status: string }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 600);
    return () => clearTimeout(t);
  }, [done]);
  if (gone) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1500, background: "#05060a", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 26, opacity: done ? 0 : 1, transition: "opacity 0.6s ease",
      pointerEvents: done ? "none" : "auto",
    }}>
      <Wordmark size={64} />
      <div style={{ width: 220, height: 2, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
        <div className="g-boot-bar" style={{ width: "40%", height: "100%", background: "var(--accent)" }} />
      </div>
      <div className="g-label g-pulse">{status}</div>
    </div>
  );
}
