import { useReaderMotion } from "../hooks/useReaderSettings";

export interface NavbarJobTitleProps {
  /** The open job's title, or null when no reader is open. */
  title: string | null;
}

/**
 * The fade, kept in one place because the pair is load-bearing: the base opacity
 * is a utility class (not an inline style) so `focus-visible:opacity-100` can
 * win on specificity and reveal the control to keyboard users.
 */
const TITLE_CLASSES = [
  "min-w-0 truncate rounded text-left",
  "text-sm font-medium text-[var(--ink-secondary)]",
  "opacity-[calc(var(--scroll-progress,0)*1.5)] transition-colors",
  "hover:text-[var(--ink-primary)]",
  "focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1",
  "focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]",
  // The divider goes away on phone widths, where every pixel goes to the title.
  "sm:border-[var(--line)] sm:border-l sm:pl-2",
].join(" ");

/** Scroll to the top of the document, gliding unless motion is reduced. */
function scrollToTop(reducedMotion: boolean): void {
  window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
}

/**
 * The open job's title in the app header.
 *
 * It fades in as the reader's playbar compacts, so the document keeps a name
 * once its own heading has scrolled away. The fade is a `calc()` on the
 * reader's `--scroll-progress` custom property, which `useScrollProgressVar`
 * mirrors onto `<html>` for exactly this purpose — the header is a sibling of
 * `<main>`, and custom properties never inherit sideways.
 *
 * The fade is an arbitrary Tailwind value rather than an inline `opacity`
 * because focus has to reveal the control: `focus-visible:opacity-100` wins on
 * specificity only while the base value stays a class (an inline style would
 * beat it, leaving keyboard users focused on invisible text).
 *
 * Clicking it returns to the top of the document, where the expanded title and
 * the full controls are. That is a plain window scroll, not reader state, so
 * the header needs nothing from the reader but the string. The glide follows
 * `useReaderMotion()` — the one place the reader's motion setting and the OS
 * preference are combined — rather than re-deriving it here.
 *
 * The divider is the button's left border rather than a sibling, so it fades in
 * with the label (a standalone hairline was left floating beside the brand) and
 * it is dropped on phone widths, where every pixel goes to the title.
 */
export function NavbarJobTitle({ title }: NavbarJobTitleProps) {
  const motion = useReaderMotion();

  if (!title) return null;

  return (
    <span className="flex min-w-0 items-center" data-testid="navbar-job-title">
      {/* The instruction goes in `aria-label`, NOT in a visually hidden span:
          `sr-only` is absolutely positioned, the button is not a positioned
          ancestor, and `overflow: hidden` therefore does not clip it. It laid
          out at the end of the untruncated title and widened the whole document
          to ~830px on a phone (horizontal scroll, sticky bars pushed off-screen
          sideways). Keep the label inside the visible text's own box. */}
      <button
        aria-label={`${title} — back to the top of the document`}
        className={TITLE_CLASSES}
        onClick={() => scrollToTop(motion === "reduced")}
        title={title}
        type="button"
      >
        {title}
      </button>
    </span>
  );
}
