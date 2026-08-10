import { useEffect, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import readflowIcon from "../../assets/brand/readflow-icon.svg";
import readflowLockupDark from "../../assets/brand/readflow-lockup-dark.svg";
import readflowLockupLight from "../../assets/brand/readflow-lockup-light.svg";

/** Scroll offset (px) at which the hero collapses into its compact state. */
const COMPACT_SCROLL_Y = 64;

/**
 * BrandHero — the brand moment at the top of the jobs page.
 *
 * Shows the full lockup (icon + wordmark + tagline) while the page is at the
 * top. Once the user scrolls past the sticky header it collapses into a
 * compact "icon + ReadFlow" row, mirroring the header brand so the two
 * visually merge while scrolling.
 *
 * Both states stay mounted and cross-fade so the transition is a pure CSS
 * height/opacity animation driven by one boolean — no per-frame state.
 * The lockup swaps between the dark and light variants from the theme.
 */
export function BrandHero() {
  const { theme } = useTheme();
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > COMPACT_SCROLL_Y);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const lockupSrc = theme === "dark" ? readflowLockupDark : readflowLockupLight;

  return (
    <section
      className={`relative flex items-center justify-center transition-all duration-300 ${
        compact ? "h-12" : "h-44 md:h-56"
      }`}
    >
      {/* Full lockup: icon + wordmark + tagline. Scales with the container
          height, so collapsing the section also shrinks the artwork. */}
      <img
        alt="ReadFlow — Turn your reading into listening"
        aria-hidden={compact}
        className={`absolute inset-0 m-auto max-h-full max-w-full transition-opacity duration-300 ${
          compact ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        src={lockupSrc}
      />
      {/* Compact row: icon + wordmark only. */}
      <div
        aria-hidden={!compact}
        className={`absolute inset-0 flex items-center justify-center gap-2 transition-opacity duration-300 ${
          compact ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <img alt="" className="h-7 w-7" src={readflowIcon} />
        <span className="text-sm font-semibold tracking-wide text-[var(--ink-primary)]">
          ReadFlow
        </span>
      </div>
    </section>
  );
}
