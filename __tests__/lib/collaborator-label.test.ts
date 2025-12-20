/// <reference types="jest" />

import { formatCollaboratorLabel } from "@/lib/collaborator-label";

describe("formatCollaboratorLabel", () => {
  it("prefers trimmed collaborator names", () => {
    expect(
      formatCollaboratorLabel({
        id: "1",
        email: "person@example.com",
        name: "  Pat Chef  ",
      })
    ).toBe("Pat Chef");
  });

  it("falls back to email when name missing", () => {
    expect(
      formatCollaboratorLabel({
        id: "2",
        email: "person@example.com",
        name: null,
      })
    ).toBe("person@example.com");
  });

  it("returns default label when both name and email missing", () => {
    expect(
      formatCollaboratorLabel({
        id: "3",
        email: "",
        name: null,
      })
    ).toBe("Unnamed collaborator");
  });
});
