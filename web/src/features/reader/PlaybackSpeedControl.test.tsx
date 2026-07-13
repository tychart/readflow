import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { PlaybackSpeedControl } from "./PlaybackSpeedControl";

describe("PlaybackSpeedControl", () => {
  test("renders with initial value", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    expect(slider).toHaveValue("1");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("1");
  });

  test("slider change calls onChange and updates input", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    fireEvent.change(slider, { target: { value: "1.5" } });

    expect(onChange).toHaveBeenCalledWith(1.5);
    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("1.5");
  });

  test("text input accepts valid positive float on blur", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(2.5);
  });

  test("text input accepts value above slider max (e.g., 4.0)", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "4.0" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(4.0);
  });

  test("text input reverts to current value on invalid entry", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.5} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("1.5");
  });

  test("text input reverts on negative value", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "-2" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("1");
  });

  test("text input reverts on zero", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("1");
  });

  test("Enter key commits typed value", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "0.75" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(0.75);
  });

  test("slider is clamped to range when value exceeds bounds", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={4.0} onChange={onChange} />);

    // Slider should show 3.0 (max) even though actual value is 4.0
    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    expect(slider).toHaveValue("3");

    // Input should show the real value
    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("4");
  });

  test("updates when external value changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    rerender(<PlaybackSpeedControl value={2.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("2");
  });

  test("slider is clamped at min when value is below slider range", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={0.1} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    expect(slider).toHaveValue("0.5");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("0.1");
  });

  test("text input accepts a large value above slider range", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "10.0" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(10.0);
  });

  test("text input with leading whitespace is parsed correctly", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "  2.0" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(2.0);
  });

  test("onChange is not called on invalid blur", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.5} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "not-a-number" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("1.5");
  });

  test("renders the 'Speed' label", () => {
    render(<PlaybackSpeedControl value={1.0} onChange={vi.fn()} />);

    expect(screen.getByText("Speed")).toBeInTheDocument();
  });

  test("slider shows correct position at min boundary (0.5)", () => {
    render(<PlaybackSpeedControl value={0.5} onChange={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    expect(slider).toHaveValue("0.5");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("0.5");
  });

  test("slider shows correct position at max boundary (3.0)", () => {
    render(<PlaybackSpeedControl value={3.0} onChange={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    expect(slider).toHaveValue("3");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("3");
  });

  test("Enter key with negative value reverts", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("1");
  });

  test("empty string on blur reverts to current value", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={2.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("2");
  });

  test("infinity value reverts", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1.0} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    fireEvent.change(input, { target: { value: "Infinity" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("1");
  });

  test("speed retains precision formatting (e.g., 0.05 step values)", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={0.5} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    fireEvent.change(slider, { target: { value: "1.05" } });

    expect(onChange).toHaveBeenCalledWith(1.05);
    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("1.05");
  });

  test("slider gradient fill reflects current value", () => {
    render(<PlaybackSpeedControl value={1.0} onChange={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    // At value 1.0 (midpoint between 0.5 and 3.0), fill should be 20%
    const expectedFill = ((1.0 - 0.5) / (3.0 - 0.5)) * 100;
    expect(slider.getAttribute("style")).toContain(`${expectedFill}%`);
  });
});
