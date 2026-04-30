import { describe, it, expect } from "bun:test";
import { parseLinearInput } from "./index.ts";

describe("parseLinearInput", () => {
  it("returns the identifier verbatim when given a bare identifier", () => {
    expect(parseLinearInput("MEC-680")).toBe("MEC-680");
  });

  it("extracts the identifier from a full Linear issue URL", () => {
    expect(
      parseLinearInput("https://linear.app/meca/issue/MEC-680/some-title")
    ).toBe("MEC-680");
  });

  it("extracts the identifier from a slug-style Linear issue URL", () => {
    expect(
      parseLinearInput(
        "https://linear.app/meca-therapies/issue/MEC-680/select-3-4-linear-integration"
      )
    ).toBe("MEC-680");
  });

  it("normalizes lowercase identifiers to uppercase", () => {
    expect(parseLinearInput("mec-680")).toBe("MEC-680");
  });

  it("normalizes lowercase URL identifiers to uppercase", () => {
    expect(parseLinearInput("https://linear.app/meca/issue/mec-680/foo")).toBe(
      "MEC-680"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseLinearInput("  MEC-680  ")).toBe("MEC-680");
    expect(parseLinearInput("\t MEC-680\n")).toBe("MEC-680");
  });

  it("returns null for an empty string", () => {
    expect(parseLinearInput("")).toBeNull();
    expect(parseLinearInput("   ")).toBeNull();
  });

  it("returns null for arbitrary non-Linear input", () => {
    expect(parseLinearInput("hello world")).toBeNull();
    expect(parseLinearInput("just-a-slug")).toBeNull();
    expect(parseLinearInput("12345")).toBeNull();
  });

  it("returns null for non-issue Linear URLs (project, settings, view)", () => {
    expect(
      parseLinearInput("https://linear.app/meca/project/some-project")
    ).toBeNull();
    expect(parseLinearInput("https://linear.app/meca/settings/api")).toBeNull();
    expect(
      parseLinearInput("https://linear.app/meca/team/MEC/active")
    ).toBeNull();
  });

  it("returns null when the identifier is embedded in surrounding text", () => {
    // We require a clean paste, not freeform prose.
    expect(parseLinearInput("see MEC-680 for details")).toBeNull();
  });

  it("returns null for non-string input (defensive)", () => {
    expect(parseLinearInput(undefined as unknown as string)).toBeNull();
    expect(parseLinearInput(null as unknown as string)).toBeNull();
  });
});
