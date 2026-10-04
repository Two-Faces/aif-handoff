import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskPlan } from "@/components/task/TaskPlan";

describe("personal board plan editor", () => {
  it("keeps the edit's original revision through remote refresh and preserves a rejected draft", async () => {
    const original = { plan: [{ streamKey: "original", sequence: 1 }] };
    const latest = { plan: [{ streamKey: "remote", sequence: 2 }] };
    const save = vi.fn().mockRejectedValue(new Error("This plan changed on another device"));
    const view = render(<TaskPlan plan="Original" revisions={original} onSave={save} />);
    fireEvent.click(screen.getByText("Edit board plan"));
    fireEvent.change(screen.getByLabelText("Board plan"), { target: { value: "Local draft" } });
    view.rerender(<TaskPlan plan="Remote revision" revisions={latest} onSave={save} />);
    fireEvent.click(screen.getByText("Save board plan"));
    await waitFor(() => expect(save).toHaveBeenCalledWith("Local draft", original));
    expect(await screen.findByText(/Your draft is preserved/)).toBeDefined();
    expect((screen.getByLabelText("Board plan") as HTMLTextAreaElement).value).toBe("Local draft");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Remote revision")).toBeDefined();
  });
});
