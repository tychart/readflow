import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DownloadButton } from "./DownloadButton";

afterEach(cleanup);

/* jsdom has no PointerEvent; the panel dismisses on a pointer press. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function renderButton(
  overrides: Partial<Parameters<typeof DownloadButton>[0]> = {},
) {
  const onDownload = vi.fn();
  const view = render(
    <DownloadButton
      canDownload
      isComplete={false}
      isDownloading={false}
      onDownload={onDownload}
      {...overrides}
    />,
  );
  return { onDownload, ...view };
}

function openFormats() {
  fireEvent.click(
    screen.getByRole("button", { name: "Choose download format" }),
  );
}

describe("DownloadButton", () => {
  test("the plain button downloads the default format", () => {
    const { onDownload } = renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Download rendered audio" }),
    );
    expect(onDownload).toHaveBeenCalledWith("m4a");
  });

  test("offers every encoding the server can produce", () => {
    renderButton();
    openFormats();
    const panel = screen.getByTestId("download-format-panel");
    expect(panel).toHaveTextContent("M4A (AAC)");
    expect(panel).toHaveTextContent("MP3");
    expect(panel).toHaveTextContent("Opus");
    expect(panel).toHaveTextContent("FLAC");
    expect(panel).toHaveTextContent("WAV");
  });

  test("picking a format downloads it and closes the panel", () => {
    const { onDownload } = renderButton();
    openFormats();
    fireEvent.click(screen.getByText("FLAC"));
    expect(onDownload).toHaveBeenCalledWith("flac");
    expect(screen.queryByTestId("download-format-panel")).toBeNull();
  });

  test("portals the panel out of the clipped metadata row", () => {
    // The playbar's metadata row is `overflow: hidden` (it collapses on
    // scroll), so an inline panel was clipped to its first row.
    const { container } = renderButton();
    openFormats();
    const panel = screen.getByTestId("download-format-panel");
    expect(container.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
    // Placed by measurement, not left at the document origin.
    expect(panel.style.left).toBe("8px");
    expect(panel.style.top).toBe("6px");
  });

  test("closes on Escape, outside presses and page scroll", () => {
    renderButton();

    openFormats();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("download-format-panel")).toBeNull();

    openFormats();
    fireEvent(document, new TestPointerEvent("pointerdown"));
    expect(screen.queryByTestId("download-format-panel")).toBeNull();

    openFormats();
    fireEvent.scroll(window);
    expect(screen.queryByTestId("download-format-panel")).toBeNull();
  });

  test("an outside press inside the panel's own toggle leaves it open", () => {
    renderButton();
    const trigger = screen.getByRole("button", {
      name: "Choose download format",
    });
    openFormats();
    fireEvent(trigger, new TestPointerEvent("pointerdown"));
    expect(screen.getByTestId("download-format-panel")).toBeInTheDocument();
  });

  test("stays inert while there is nothing to download", () => {
    renderButton({ canDownload: false });
    expect(
      screen.getByRole("button", { name: "Download not available" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Choose download format" }),
    ).toBeDisabled();

    openFormats();
    expect(screen.queryByTestId("download-format-panel")).toBeNull();
  });

  test("shows progress instead of the label while the export is building", () => {
    renderButton({ isDownloading: true });
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download rendered audio" }),
    ).toBeDisabled();
  });
});
