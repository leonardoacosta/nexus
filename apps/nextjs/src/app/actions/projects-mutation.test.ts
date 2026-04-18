/**
 * projects.ts server action tests — wave 1, spec: add-revalidation-to-server-actions
 *
 * Verifies the revalidatePath contract for updateProject:
 *   2.1 — success path calls revalidatePath with the correct paths
 *   2.3 — failure path does NOT call revalidatePath (contract scenario 3)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted runs before module imports — safe to assign variables used inside vi.mock factories
const { revalidatePath, mockUpdateProject } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  mockUpdateProject: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/get-client", () => ({
  getClient: vi.fn().mockResolvedValue({ updateProject: mockUpdateProject }),
}));

// Import AFTER mocks are registered
import { updateProject } from "./projects";

describe("updateProject — revalidatePath contract", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    mockUpdateProject.mockClear();
  });

  // ---- 2.1: success path ------------------------------------------------

  it("calls revalidatePath('/projects') after a successful tag update", async () => {
    mockUpdateProject.mockResolvedValueOnce({ updated: true });

    await updateProject("p1", { tags: ["rust"], name: "my-project" });

    expect(revalidatePath).toHaveBeenCalledWith("/projects");
  });

  it("calls revalidatePath with the encoded project name route after success", async () => {
    mockUpdateProject.mockResolvedValueOnce({ updated: true });

    await updateProject("p1", { tags: ["rust"], name: "my-project" });

    expect(revalidatePath).toHaveBeenCalledWith("/projects/my-project");
  });

  it("calls revalidatePath exactly twice when name is provided", async () => {
    mockUpdateProject.mockResolvedValueOnce({ updated: true });

    await updateProject("p1", { tags: ["cli"], name: "nexus" });

    expect(revalidatePath).toHaveBeenCalledTimes(2);
    expect(revalidatePath).toHaveBeenCalledWith("/projects");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/nexus");
  });

  it("calls revalidatePath once (only /projects) when name is omitted", async () => {
    mockUpdateProject.mockResolvedValueOnce({ updated: true });

    await updateProject("p1", { tags: ["cli"] });

    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/projects");
  });

  it("URL-encodes project name with spaces in the revalidated path", async () => {
    mockUpdateProject.mockResolvedValueOnce({ updated: true });

    await updateProject("p1", { tags: ["rust"], name: "my project" });

    expect(revalidatePath).toHaveBeenCalledWith("/projects/my%20project");
  });

  // ---- 2.3: failure path — MUST NOT call revalidatePath -----------------

  it("does NOT call revalidatePath when client.updateProject throws", async () => {
    mockUpdateProject.mockRejectedValueOnce(new Error("agent unreachable"));

    await expect(
      updateProject("p1", { tags: ["rust"], name: "my-project" }),
    ).rejects.toThrow("agent unreachable");

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT call revalidatePath when client.updateProject returns a 500 error", async () => {
    mockUpdateProject.mockRejectedValueOnce(new Error("internal server error"));

    await expect(
      updateProject("p1", { description: "new desc", name: "my-project" }),
    ).rejects.toThrow("internal server error");

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // ---- edge: empty patch short-circuits before any client call ----------

  it("does NOT call revalidatePath when patch is empty (no-op early return)", async () => {
    // Only name provided — no tags or description → Object.keys(patch).length === 0
    await updateProject("p1", { name: "my-project" });

    expect(mockUpdateProject).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
