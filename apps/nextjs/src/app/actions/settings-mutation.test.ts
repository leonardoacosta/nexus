/**
 * settings.ts server action tests — wave 1, spec: add-revalidation-to-server-actions
 *
 * Verifies the revalidatePath contract for saveAgentConfig:
 *   2.2 — success path (add + remove branches) calls revalidatePath('/settings')
 *   2.3 — failure path does NOT call revalidatePath (contract scenario 3)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted runs before module imports — safe to assign variables used inside vi.mock factories
const { revalidatePath, mockSaveAgent, mockDeleteAgent } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  mockSaveAgent: vi.fn(),
  mockDeleteAgent: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/get-client", () => ({
  getClient: vi.fn().mockResolvedValue({
    saveAgent: mockSaveAgent,
    deleteAgent: mockDeleteAgent,
  }),
}));

// Import AFTER mocks are registered
import { saveAgentConfig } from "./settings";

const TEST_AGENT = { name: "mac", host: "100.64.0.5", port: 7400 };

describe("saveAgentConfig — revalidatePath contract", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    mockSaveAgent.mockClear();
    mockDeleteAgent.mockClear();
  });

  // ---- 2.2: success path — add branch -----------------------------------

  it("calls revalidatePath('/settings') after a successful add", async () => {
    mockSaveAgent.mockResolvedValueOnce({ saved: true });

    await saveAgentConfig("add", TEST_AGENT);

    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("calls client.saveAgent (not deleteAgent) on the add branch", async () => {
    mockSaveAgent.mockResolvedValueOnce({ saved: true });

    await saveAgentConfig("add", TEST_AGENT);

    expect(mockSaveAgent).toHaveBeenCalledTimes(1);
    expect(mockDeleteAgent).not.toHaveBeenCalled();
  });

  // ---- 2.2: success path — remove branch --------------------------------

  it("calls revalidatePath('/settings') after a successful remove", async () => {
    mockDeleteAgent.mockResolvedValueOnce({ deleted: true });

    await saveAgentConfig("remove", TEST_AGENT);

    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("calls client.deleteAgent (not saveAgent) on the remove branch", async () => {
    mockDeleteAgent.mockResolvedValueOnce({ deleted: true });

    await saveAgentConfig("remove", TEST_AGENT);

    expect(mockDeleteAgent).toHaveBeenCalledTimes(1);
    expect(mockSaveAgent).not.toHaveBeenCalled();
  });

  // ---- 2.3: failure path — MUST NOT call revalidatePath -----------------

  it("does NOT call revalidatePath when client.saveAgent throws (add branch)", async () => {
    mockSaveAgent.mockRejectedValueOnce(new Error("duplicate agent name"));

    await expect(saveAgentConfig("add", TEST_AGENT)).rejects.toThrow(
      "duplicate agent name",
    );

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT call revalidatePath when client.saveAgent returns a 500 error (add branch)", async () => {
    mockSaveAgent.mockRejectedValueOnce(new Error("db write failed"));

    await expect(saveAgentConfig("add", TEST_AGENT)).rejects.toThrow(
      "db write failed",
    );

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT call revalidatePath when client.deleteAgent throws (remove branch)", async () => {
    mockDeleteAgent.mockRejectedValueOnce(new Error("agent not found"));

    await expect(saveAgentConfig("remove", TEST_AGENT)).rejects.toThrow(
      "agent not found",
    );

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT call revalidatePath when client.deleteAgent returns a 500 error (remove branch)", async () => {
    mockDeleteAgent.mockRejectedValueOnce(new Error("delete failed"));

    await expect(saveAgentConfig("remove", TEST_AGENT)).rejects.toThrow(
      "delete failed",
    );

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
