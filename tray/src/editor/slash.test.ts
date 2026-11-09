import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@web/types";
import { insertCommand, rankCommands, slashToken, startsWithQuery } from "@web/lib/slash";

const cmd = (name: string, description?: string): SlashCommand => ({ name, source: "user", description });

describe("the command being typed", () => {
  it("is a slash at the start or after a space, up to the caret", () => {
    expect(slashToken("/rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(slashToken("then /rev", 9)).toEqual({ start: 5, query: "rev" });
    expect(slashToken("/", 1)).toEqual({ start: 0, query: "" });
  });

  it("is not a path, nor a word the caret is inside of", () => {
    expect(slashToken("/usr/bin", 8)).toBeNull();
    expect(slashToken("C:/x", 4)).toBeNull();
    expect(slashToken("a/b", 3)).toBeNull();
    expect(slashToken("/review", 3)).toBeNull();
  });
});

describe("the suggestions", () => {
  const commands = [cmd("review"), cmd("design:critique"), cmd("preview-it"), cmd("clear", "Start over, reviewing nothing")];

  it("put the names that start with it first, then a plugin's own part, then the rest", () => {
    expect(rankCommands(commands, "rev").map((c) => c.name)).toEqual(["review", "preview-it", "clear"]);
    expect(rankCommands(commands, "crit").map((c) => c.name)).toEqual(["design:critique"]);
  });

  it("let Enter take only what starts with what was typed", () => {
    expect(startsWithQuery(cmd("design:critique"), "crit")).toBe(true);
    expect(startsWithQuery(cmd("preview-it"), "rev")).toBe(false);
  });
});

describe("taking one", () => {
  it("writes it in place of what was typed, with one space after it", () => {
    expect(insertCommand("/rev", { start: 0, query: "rev" }, 4, cmd("review"))).toEqual({ text: "/review ", caret: 8 });
    expect(insertCommand("then /rev it", { start: 5, query: "rev" }, 9, cmd("review"))).toEqual({
      text: "then /review it",
      caret: 13,
    });
  });
});
